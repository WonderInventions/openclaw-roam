/**
 * Roam live message track.
 *
 * Mirrors Telegram's edit-in-place streaming model: open one message via
 * `chat.post`, then update its body in place via `chat.update` as more text
 * arrives, throttled to one update per second per track. When the per-message
 * byte cap is hit, the open message is closed and a fresh `chat.post` opens
 * for the suffix.
 */

import { getRoamRuntime } from "./runtime.js";
import { sendMessageRoam, updateMessageRoam } from "./send.js";

/** Server cap on a single chat.post / chat.update message body. */
export const ROAM_MAX_MESSAGE_BYTES = 8000;
/** Headroom for UTF-8 / JSON framing. */
export const ROAM_MAX_MESSAGE_BYTES_HEADROOM = 500;
/** Mirror Telegram: defer the first send until the response has accumulated. */
export const ROAM_MIN_INITIAL_CHARS = 30;
/** Mirror Telegram: at most one chat.update per second per track. */
export const ROAM_DEFAULT_THROTTLE_MS = 1000;

const encoder = new TextEncoder();

/**
 * Return the number of leading characters from `text` whose UTF-8 byte length
 * fits within `budget`. Iterates code points so we never split a surrogate
 * pair.
 */
export function sliceByByteBudget(text: string, budget: number): number {
  if (budget <= 0) {
    return 0;
  }
  let bytes = 0;
  let chars = 0;
  for (const ch of text) {
    const chBytes = encoder.encode(ch).length;
    if (bytes + chBytes > budget) {
      break;
    }
    bytes += chBytes;
    chars += ch.length;
  }
  return chars;
}

function byteLen(text: string): number {
  return encoder.encode(text).length;
}

export type RoamLiveMessageTrack = {
  /**
   * Push the latest accumulated text for the open logical message. The track
   * issues a `chat.post` for the first send (once the threshold is met) and
   * `chat.update` for subsequent sends, throttled to one call per second.
   * When the byte cap is exceeded, the open message is closed and a new
   * `chat.post` opens for the suffix.
   */
  pushAccumulated(text: string): Promise<void>;
  /**
   * Treat the open message as committed and start a fresh logical message
   * on the next push. Mirrors Telegram's `forceNewMessage` and is fired on
   * `onAssistantMessageStart` and reasoning-segment splits.
   */
  rotate(): Promise<void>;
  /**
   * Drain pending updates synchronously. If `finalText` is supplied, it
   * becomes the final message content (bypasses the initial-char threshold).
   */
  finalize(finalText?: string): Promise<void>;
  /** True after a chat.post or chat.update failed; caller may fall back. */
  isFailed(): boolean;
  /**
   * Total chars committed in the current logical message via prior byte-cap
   * splits. Used by the deliver fallback to chat.post only the unsent suffix.
   */
  getCommittedLength(): number;
};

export type CreateRoamLiveMessageTrackParams = {
  chatId: string;
  /** Microsecond parent-message timestamp when streaming into an existing Roam thread. */
  threadTimestamp?: number;
  accountId: string;
  apiKey?: string;
  minInitialChars?: number;
  throttleMs?: number;
  messageByteBudget?: number;
  onError?: (message: string) => void;
  onActivity?: () => void;
};

export function createRoamLiveMessageTrack(
  params: CreateRoamLiveMessageTrackParams,
): RoamLiveMessageTrack {
  const minInitialChars = params.minInitialChars ?? ROAM_MIN_INITIAL_CHARS;
  const throttleMs = params.throttleMs ?? ROAM_DEFAULT_THROTTLE_MS;
  const budget =
    params.messageByteBudget ?? ROAM_MAX_MESSAGE_BYTES - ROAM_MAX_MESSAGE_BYTES_HEADROOM;

  const sendOpts = {
    accountId: params.accountId,
    threadTimestamp: params.threadTimestamp,
    apiKey: params.apiKey,
  } as const;

  // Logger is resolved lazily so unit tests that don't mount the runtime can
  // still construct tracks. Falls back to no-op if the runtime isn't ready.
  const log = (() => {
    try {
      return getRoamRuntime().logging.getChildLogger({
        channel: "roam",
        accountId: params.accountId,
      });
    } catch {
      return null;
    }
  })();
  const logEvent = (event: string): void => {
    log?.info(`[roam-stream] ${event}`);
  };

  let messageTimestamp: number | null = null;
  let lastSentText = "";
  let lastQueuedText = "";
  let committedPrefixLength = 0;
  let failed = false;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  // Mark the track failed and release the throttle timer reference. The track
  // is single-use after this — all further `pushAccumulated` calls are no-ops
  // (and `finalize` short-circuits).
  const markFailed = (): void => {
    failed = true;
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
  };
  let lastSendAt = 0;

  const flush = async (): Promise<void> => {
    while (!failed && lastQueuedText !== lastSentText) {
      const target = lastQueuedText;
      const targetBytes = byteLen(target);

      if (targetBytes <= budget) {
        const willPost = messageTimestamp === null;
        logEvent(
          `flush ${willPost ? "post" : "update"} chat=${params.chatId} chars=${target.length} bytes=${targetBytes} ts=${messageTimestamp ?? "-"}`,
        );
        try {
          if (messageTimestamp === null) {
            const result = await sendMessageRoam(params.chatId, target, sendOpts);
            messageTimestamp = typeof result.timestamp === "number" ? result.timestamp : null;
            logEvent(`flush post resolved ts=${messageTimestamp ?? "missing"}`);
          } else {
            await updateMessageRoam(params.chatId, messageTimestamp, target, sendOpts);
            logEvent(`flush update resolved ts=${messageTimestamp}`);
          }
          lastSentText = target;
          lastSendAt = Date.now();
          params.onActivity?.();
        } catch (err) {
          markFailed();
          // Advance committedPrefixLength past the text Roam already accepted
          // so the deliver fallback chat.posts only the unsent suffix instead
          // of duplicating what the user already sees.
          if (lastSentText.length > 0) {
            committedPrefixLength += lastSentText.length;
          }
          logEvent(
            `flush FAIL committed=${committedPrefixLength} sent=${lastSentText.length} err=${String(err)}`,
          );
          params.onError?.(`live message send/update failed: ${String(err)}`);
        }
        return;
      }

      const headChars = sliceByByteBudget(target, budget);
      if (headChars === 0) {
        markFailed();
        logEvent(
          `cap-split stuck chars=${target.length} budget=${budget} committed=${committedPrefixLength}`,
        );
        params.onError?.(
          `cap-split could not advance (target=${target.length} chars, budget=${budget} bytes)`,
        );
        return;
      }
      const head = target.slice(0, headChars);
      const willPost = messageTimestamp === null;
      logEvent(
        `flush cap-split ${willPost ? "post" : "update"} chat=${params.chatId} chars=${headChars} (target=${target.length}) ts=${messageTimestamp ?? "-"}`,
      );
      try {
        if (messageTimestamp === null) {
          const result = await sendMessageRoam(params.chatId, head, sendOpts);
          messageTimestamp = typeof result.timestamp === "number" ? result.timestamp : null;
        } else if (head !== lastSentText) {
          await updateMessageRoam(params.chatId, messageTimestamp, head, sendOpts);
        }
        params.onActivity?.();
      } catch (err) {
        markFailed();
        if (lastSentText.length > 0) {
          committedPrefixLength += lastSentText.length;
        }
        logEvent(`cap-split flush FAIL committed=${committedPrefixLength} err=${String(err)}`);
        params.onError?.(`cap-split flush failed: ${String(err)}`);
        return;
      }

      committedPrefixLength += headChars;
      messageTimestamp = null;
      lastSentText = "";
      lastQueuedText = target.slice(headChars);
      lastSendAt = Date.now();
      logEvent(
        `cap-split rotated committed=${committedPrefixLength} suffix=${lastQueuedText.length}`,
      );
      // Loop continues with the suffix in a fresh message.
    }
  };

  const scheduleFlush = (): void => {
    if (failed || throttleTimer || inFlight) {
      return;
    }
    const elapsed = Date.now() - lastSendAt;
    const wait = Math.max(0, throttleMs - elapsed);
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      void runFlush();
    }, wait);
  };

  const runFlush = async (): Promise<void> => {
    if (failed || inFlight) {
      return;
    }
    const p = flush();
    inFlight = p;
    try {
      await p;
    } finally {
      if (inFlight === p) {
        inFlight = null;
      }
      if (!failed && lastQueuedText !== lastSentText && !throttleTimer) {
        scheduleFlush();
      }
    }
  };

  const pushAccumulated = async (text: string): Promise<void> => {
    if (failed) {
      return;
    }
    const target = text.slice(committedPrefixLength);
    if (target === lastQueuedText) {
      return;
    }
    lastQueuedText = target;
    if (messageTimestamp === null && lastSentText === "" && target.length < minInitialChars) {
      logEvent(
        `push deferred chat=${params.chatId} chars=${target.length} threshold=${minInitialChars}`,
      );
      return;
    }
    logEvent(
      `push queued chat=${params.chatId} chars=${target.length} hasMsg=${messageTimestamp !== null}`,
    );
    scheduleFlush();
  };

  const rotate = async (): Promise<void> => {
    if (failed) {
      return;
    }
    logEvent(
      `rotate chat=${params.chatId} prevTs=${messageTimestamp ?? "-"} sent=${lastSentText.length}`,
    );
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    committedPrefixLength = 0;
    messageTimestamp = null;
    lastSentText = "";
    lastQueuedText = "";
  };

  const finalize = async (finalText?: string): Promise<void> => {
    if (failed) {
      logEvent(`finalize skipped (failed) chat=${params.chatId}`);
      return;
    }
    logEvent(
      `finalize chat=${params.chatId} hasFinal=${typeof finalText === "string"} queued=${lastQueuedText.length} sent=${lastSentText.length}`,
    );
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    if (typeof finalText === "string") {
      const target = finalText.slice(committedPrefixLength);
      if (target !== lastQueuedText) {
        lastQueuedText = target;
      }
    }
    if (!failed && lastQueuedText !== lastSentText) {
      const p = flush();
      inFlight = p;
      try {
        await p;
      } finally {
        if (inFlight === p) {
          inFlight = null;
        }
      }
    }
  };

  return {
    pushAccumulated,
    rotate,
    finalize,
    isFailed: () => failed,
    getCommittedLength: () => committedPrefixLength,
  };
}
