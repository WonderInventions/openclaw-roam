/**
 * Roam native chat streaming tracks.
 *
 * The local Roam appserver supports explicit stream lifecycle calls:
 *
 *   POST /chat.startStream
 *   POST /chat.appendStream
 *   POST /chat.stopStream
 *
 * We use that contract for both answer text (`kind="text"`) and the thinking
 * lane (`kind="thinking"`). Public edge deployments still fall back to the
 * draft post+update path for answer text; native answer streaming is reserved
 * for localhost-style developer appservers where the stream lifecycle is
 * directly observable end to end.
 */

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveRoamAccount } from "./accounts.js";
import { resolveApiBase } from "./api-base.js";
import { stripRoamTargetPrefix } from "./normalize.js";
import { getRoamRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

/** Mirror the draft answer track: defer the first send until text accumulates. */
export const ROAM_NATIVE_STREAM_MIN_INITIAL_CHARS = 30;
/** Mirror the draft answer track: at most one append per second per track. */
export const ROAM_NATIVE_STREAM_DEFAULT_THROTTLE_MS = 1000;
export const ROAM_THINKING_MIN_INITIAL_CHARS = ROAM_NATIVE_STREAM_MIN_INITIAL_CHARS;
export const ROAM_THINKING_DEFAULT_THROTTLE_MS = ROAM_NATIVE_STREAM_DEFAULT_THROTTLE_MS;

type RoamNativeStreamKind = "text" | "thinking";

export type RoamNativeStreamTrack = {
  pushAccumulated(text: string): Promise<void>;
  rotate(): Promise<void>;
  finalize(finalText?: string): Promise<void>;
  isFailed(): boolean;
  getCommittedLength(): number;
};

export type RoamAnswerStreamTrack = RoamNativeStreamTrack;
export type RoamThinkingStreamTrack = RoamNativeStreamTrack;

type CreateRoamNativeStreamTrackParams = {
  chatId: string;
  /**
   * Microsecond parent-message timestamp. When set, the stream session is
   * created inside that Roam thread (`chat.startStream` accepts this and the
   * server scopes the broadcast to thread participants).
   */
  threadTimestamp?: number;
  accountId: string;
  apiKey?: string;
  minInitialChars?: number;
  throttleMs?: number;
  cfg?: CoreConfig;
  onError?: (message: string) => void;
  onActivity?: () => void;
  kind: RoamNativeStreamKind;
};

export type CreateRoamAnswerStreamTrackParams = Omit<
  CreateRoamNativeStreamTrackParams,
  "kind"
>;
export type CreateRoamThinkingStreamTrackParams = Omit<
  CreateRoamNativeStreamTrackParams,
  "kind"
>;

type StreamSession = {
  streamId: string;
  chatId: string;
  stopped: boolean;
};

type StreamProgressResponse = {
  streamId?: string;
  chatId?: string;
};

type StreamStopResponse = StreamProgressResponse & {
  timestamp?: number;
};

function resolveNativeStreamContext(params: CreateRoamNativeStreamTrackParams): {
  accountId: string;
  apiBase: string;
  apiKey: string;
  normalizedChatId: string;
} {
  const cfg = (params.cfg ?? getRoamRuntime().config.loadConfig()) as CoreConfig;
  const account = resolveRoamAccount({ cfg, accountId: params.accountId });
  const apiKey = params.apiKey?.trim() || account.apiKey;
  if (!apiKey) {
    throw new Error(
      `Roam API key missing for account "${account.accountId}" (set channels.roam.apiKey).`,
    );
  }
  const normalizedChatId = stripRoamTargetPrefix(params.chatId);
  if (!normalizedChatId) {
    throw new Error(`Chat ID is required for Roam ${params.kind} streams`);
  }
  return {
    accountId: account.accountId,
    apiBase: resolveApiBase(cfg, account.config.apiBaseUrl),
    apiKey,
    normalizedChatId,
  };
}

async function postStreamJson<T>(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  auditContext: string,
): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    auditContext,
  });

  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`status=${response.status} body=${errorBody.slice(0, 200)}`);
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

function createRoamNativeStreamTrack(
  params: CreateRoamNativeStreamTrackParams,
): RoamNativeStreamTrack {
  const minInitialChars = params.minInitialChars ?? ROAM_NATIVE_STREAM_MIN_INITIAL_CHARS;
  const throttleMs = params.throttleMs ?? ROAM_NATIVE_STREAM_DEFAULT_THROTTLE_MS;
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
    log?.info(`[roam-stream/${params.kind}] ${event}`);
  };

  let session: StreamSession | null = null;
  let lastSentText = "";
  let lastQueuedText = "";
  let failed = false;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let lastSendAt = 0;

  const markFailed = (reason: string): void => {
    if (failed) {
      return;
    }
    failed = true;
    logEvent(`FAIL ${reason}`);
    params.onError?.(reason);
  };

  const ensureSession = async (text: string): Promise<void> => {
    if (session) {
      return;
    }
    const { apiBase, apiKey, normalizedChatId } = resolveNativeStreamContext(params);
    const started = Date.now();
    // Server generates the streamId. The start request takes only chatId+kind;
    // text is sent via the first appendStream after the session is open.
    const startBody: { chatId: string; kind: string; threadTimestamp?: number } = {
      chatId: normalizedChatId,
      kind: params.kind,
    };
    if (params.threadTimestamp !== undefined) {
      startBody.threadTimestamp = params.threadTimestamp;
    }
    const response = await postStreamJson<StreamProgressResponse>(
      `${apiBase}/chat.startStream`,
      apiKey,
      startBody,
      `roam-chat-start-stream-${params.kind}`,
    );
    if (!response.streamId) {
      throw new Error("chat.startStream did not return a streamId");
    }
    session = {
      streamId: response.streamId,
      chatId: response.chatId ?? normalizedChatId,
      stopped: false,
    };
    logEvent(
      `start OK chat=${session.chatId} stream=${session.streamId} dt=${Date.now() - started}ms`,
    );
    params.onActivity?.();
    // Push the initial text immediately so the user sees something before the
    // first throttled append window.
    if (text.length > 0) {
      await appendSnapshot(text);
    }
  };

  const appendSnapshot = async (text: string): Promise<void> => {
    if (!session) {
      await ensureSession(text);
      return;
    }
    // chat.appendStream.text is INCREMENTAL by default — the server appends it
    // to the existing stream content. Setting `snapshot: true` flips it to
    // replace-semantics, which matches OpenClaw's reply pipeline (each
    // `onPartialReply` payload is the full accumulated text). This is more
    // resilient than computing a delta when the text is not strictly
    // monotonic-extending.
    const { apiBase, apiKey } = resolveNativeStreamContext(params);
    const started = Date.now();
    await postStreamJson<StreamProgressResponse>(
      `${apiBase}/chat.appendStream`,
      apiKey,
      {
        streamId: session.streamId,
        text,
        snapshot: true,
      },
      `roam-chat-append-stream-${params.kind}`,
    );
    logEvent(
      `append OK chat=${session.chatId} stream=${session.streamId} dt=${Date.now() - started}ms chars=${text.length}`,
    );
    params.onActivity?.();
    lastSentText = text;
    lastSendAt = Date.now();
  };

  const flush = async (): Promise<void> => {
    if (failed || lastQueuedText === lastSentText) {
      return;
    }
    const target = lastQueuedText;
    logEvent(`flush queued=${target.length} hasSession=${session !== null}`);
    try {
      await appendSnapshot(target);
    } catch (err) {
      markFailed(`flush failed: ${String(err)}`);
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

  const stopSession = async (trailingText = ""): Promise<void> => {
    if (!session || session.stopped) {
      return;
    }
    const { apiBase, apiKey } = resolveNativeStreamContext(params);
    const started = Date.now();
    // The stream's content was already committed via prior appendStream calls.
    // chat.stopStream just freezes the stream — text in the body would create
    // a *second* message, so only send the streamId. If a non-empty
    // `trailingText` was supplied (caller wants to overwrite the final
    // content), include it; otherwise omit.
    const stopBody: { streamId: string; text?: string } = {
      streamId: session.streamId,
    };
    if (trailingText.length > 0 && trailingText !== lastSentText) {
      stopBody.text = trailingText;
    } else if (lastSentText.length === 0) {
      // Nothing was ever appended — server would 400 "stream ended with no
      // content". Mark the session done locally and bail.
      logEvent(
        `stop skipped chat=${session.chatId} stream=${session.streamId} (no content)`,
      );
      session.stopped = true;
      session = null;
      lastSentText = "";
      lastQueuedText = "";
      lastSendAt = Date.now();
      return;
    }
    await postStreamJson<StreamStopResponse>(
      `${apiBase}/chat.stopStream`,
      apiKey,
      stopBody,
      `roam-chat-stop-stream-${params.kind}`,
    );
    session.stopped = true;
    logEvent(
      `stop OK chat=${session.chatId} stream=${session.streamId} dt=${Date.now() - started}ms`,
    );
    params.onActivity?.();
    session = null;
    lastSentText = "";
    lastQueuedText = "";
    lastSendAt = Date.now();
  };

  const pushAccumulated = async (text: string): Promise<void> => {
    if (failed || text === lastQueuedText) {
      return;
    }
    lastQueuedText = text;
    if (!session && text.length < minInitialChars) {
      logEvent(`push deferred chars=${text.length} threshold=${minInitialChars}`);
      return;
    }
    scheduleFlush();
  };

  const rotate = async (): Promise<void> => {
    if (failed) {
      return;
    }
    logEvent(`rotate hasSession=${session !== null} sent=${lastSentText.length}`);
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    try {
      await stopSession();
    } catch (err) {
      markFailed(`rotate failed: ${String(err)}`);
    }
  };

  const finalize = async (finalText?: string): Promise<void> => {
    if (failed) {
      logEvent("finalize skipped (failed)");
      return;
    }
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    if (typeof finalText === "string" && finalText !== lastQueuedText) {
      lastQueuedText = finalText;
    }
    if (!session && lastQueuedText.length === 0) {
      return;
    }
    if (lastQueuedText !== lastSentText) {
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
    try {
      await stopSession();
    } catch (err) {
      markFailed(`finalize failed: ${String(err)}`);
    }
  };

  return {
    pushAccumulated,
    rotate,
    finalize,
    isFailed: () => failed,
    getCommittedLength: () => 0,
  };
}

export function createRoamAnswerStreamTrack(
  params: CreateRoamAnswerStreamTrackParams,
): RoamAnswerStreamTrack {
  return createRoamNativeStreamTrack({ ...params, kind: "text" });
}

export function createRoamThinkingStreamTrack(
  params: CreateRoamThinkingStreamTrackParams,
): RoamThinkingStreamTrack {
  return createRoamNativeStreamTrack({ ...params, kind: "thinking" });
}
