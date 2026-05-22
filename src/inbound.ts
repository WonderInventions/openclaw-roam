import {
  MAX_IMAGE_BYTES,
  fetchRemoteMedia,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  createChannelPairingController,
  deliverFormattedTextWithAttachments,
  dispatchInboundReplyWithBase,
  logInboundDrop,
  logTypingFailure,
  readStoreAllowFromForDmPolicy,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingNativeTransport,
  resolveDmGroupAccessWithCommandGate,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveSendableOutboundReplyParts,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OutboundReplyPayload,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { ResolvedRoamAccount } from "./accounts.js";
import { createRoamAnswerStreamTrack, createRoamThinkingStreamTrack } from "./chat-stream.js";
import { fetchRoamChatHistory, type RoamHistoryMessage } from "./history.js";
import {
  normalizeRoamAllowlist,
  resolveRoamAllowlistMatch,
  resolveRoamGroupAllow,
  resolveRoamGroupMatch,
  resolveRoamGroupSystemPrompt,
  resolveRoamMentionGate,
  resolveRoamReplyInThread,
  resolveRoamRequireMention,
} from "./policy.js";
import { getRoamRuntime } from "./runtime.js";
import { sendMessageRoam, sendTypingRoam } from "./send.js";
import { createRoamLiveMessageTrack } from "./streaming.js";
import type { CoreConfig, RoamInboundMessage } from "./types.js";

const CHANNEL_ID = "roam" as const;

/**
 * Per-process record of which (sessionKey, history-scope) combinations the
 * plugin has already fetched chat.history for. We fetch the prior chat /
 * thread context the FIRST time a session encounters a given scope (either
 * "top" for top-level conversations or `thread:<microsecondTs>` for a
 * specific thread), then skip on subsequent turns — the session itself
 * accumulates each turn's user message + agent reply, so re-fetching the
 * same history every turn would just duplicate context the agent already has
 * and burn tokens N² as threads grow.
 *
 * Restart loses the cache; a single re-fetch on the first inbound after
 * restart restores the bot's view of pre-restart context. Bounded to
 * HISTORY_FETCH_MEMO_MAX entries with FIFO eviction so a long-running bot
 * in many chats doesn't accumulate unboundedly.
 */
const HISTORY_FETCH_MEMO_MAX = 1000;
const historyFetchMemo = new Map<string, Set<string>>();

function hasFetchedHistoryFor(sessionKey: string, scope: string): boolean {
  return historyFetchMemo.get(sessionKey)?.has(scope) ?? false;
}

function recordHistoryFetched(sessionKey: string, scope: string): void {
  let scopes = historyFetchMemo.get(sessionKey);
  if (!scopes) {
    if (historyFetchMemo.size >= HISTORY_FETCH_MEMO_MAX) {
      const oldest = historyFetchMemo.keys().next().value;
      if (oldest !== undefined) historyFetchMemo.delete(oldest);
    }
    scopes = new Set();
    historyFetchMemo.set(sessionKey, scopes);
  }
  scopes.add(scope);
}

/** Test-only: clear the per-process history-fetch memoization. */
export function __resetHistoryFetchMemoForTests(): void {
  historyFetchMemo.clear();
}

/**
 * Track which `(accountId, chatId)` pairs have already received the
 * "not-allowlisted" courtesy notice this process. The notice fires at most
 * once per chat per restart to avoid spam if the operator doesn't update
 * config immediately. Bounded with full-clear eviction (best-effort; insertion
 * order isn't tracked).
 */
const NOT_ALLOWLISTED_NOTICE_MAX = 1000;
const notAllowlistedNoticeSent = new Set<string>();

function shouldSendNotAllowlistedNotice(scopeKey: string): boolean {
  if (notAllowlistedNoticeSent.has(scopeKey)) return false;
  if (notAllowlistedNoticeSent.size >= NOT_ALLOWLISTED_NOTICE_MAX) {
    notAllowlistedNoticeSent.clear();
  }
  notAllowlistedNoticeSent.add(scopeKey);
  return true;
}

/** Test-only: clear the per-process not-allowlisted notice memoization. */
export function __resetNotAllowlistedNoticeForTests(): void {
  notAllowlistedNoticeSent.clear();
}

function buildNotAllowlistedNotice(params: { accountId: string; chatId: string }): string {
  return [
    `Hi — I see your message, but this group isn't on my allowlist for the \`${params.accountId}\` account, so I can't reply yet.`,
    ``,
    `To enable me here, either:`,
    `• Set my \`groupPolicy\` to \`"open"\` (allow any group I'm added to), or`,
    `• Add this group to the allowlist. This chat's id is \`${params.chatId}\`.`,
  ].join("\n");
}

function buildNotAllowlistedDmNotice(params: {
  accountId: string;
  senderId: string;
}): string {
  return [
    `Hi — I see your message, but you're not on my allowlist for the \`${params.accountId}\` account, so I can't reply yet.`,
    ``,
    `To enable me to reply, either:`,
    `• Set my \`dmPolicy\` to \`"open"\` (allow any workspace member to DM me), or`,
    `• Add yourself to the allowlist. Your user id is \`${params.senderId}\`.`,
  ].join("\n");
}

/**
 * Build a regex that matches `<@<botId>>` or `<!@<botId>>` for a known bot ID.
 * Returns null when `botId` is undefined — callers must handle that explicitly,
 * since "fallback: strip all mentions" is the right thing for body cleanup
 * (`stripBotMention`) but the wrong thing for detection (`wasBotMentioned`).
 */
function buildBotMentionRegex(botId: string, flags = "gi"): RegExp {
  const escaped = botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<!?@${escaped}>`, flags);
}

/** Strip Roam mention syntax for the bot's own user ID. */
function stripBotMention(text: string, botId?: string): string {
  if (botId) {
    return text.replace(buildBotMentionRegex(botId, "gi"), "").trim();
  }
  // Fallback: strip all <@xxx> mentions when bot ID is unknown.
  return text.replace(/<!?@[0-9a-f-]+>/gi, "").trim();
}

/** Check if the bot was mentioned in the message. */
function wasBotMentioned(text: string, botId?: string): boolean {
  if (!botId) {
    // Without a known botId, we cannot reliably detect bot mentions.
    // Return false to avoid waking the bot on arbitrary user mentions.
    return false;
  }
  return buildBotMentionRegex(botId, "i").test(text);
}

/** Download media URLs to local files for the media understanding pipeline. */
async function downloadMediaToLocal(
  mediaUrls: string[],
  mediaTypes: string[],
  log?: (msg: string) => void,
): Promise<{ paths: string[]; urls: string[]; types: string[] }> {
  const paths: string[] = [];
  const urls: string[] = [];
  const types: string[] = [];
  for (let i = 0; i < mediaUrls.length; i++) {
    const url = mediaUrls[i];
    const mime = mediaTypes[i];
    try {
      const fetched = await fetchRemoteMedia({ url, maxBytes: MAX_IMAGE_BYTES });
      const saved = await saveMediaBuffer(fetched.buffer, mime ?? fetched.contentType, "inbound");
      paths.push(saved.path);
      urls.push(url);
      types.push(mime ?? fetched.contentType ?? "application/octet-stream");
    } catch (err) {
      // Skip failed downloads; don't block message processing — but do log
      // why, so operators investigating "the agent didn't see my image" have
      // a breadcrumb instead of silence.
      log?.(`roam-media: download failed url=${url} err=${String(err)}`);
    }
  }
  if (mediaUrls.length > 0) {
    log?.(`roam-media: downloaded ${paths.length}/${mediaUrls.length}`);
  }
  return { paths, urls, types };
}

// Roam enforces an 8000-byte cap per chat.post message and per chat.stream
// snapshot. We chunk by character count with a smaller budget so multi-byte
// UTF-8 (emoji, accents) cannot push a single chunk over the byte limit.
const ROAM_TEXT_CHUNK_LIMIT = 6000;

async function deliverRoamReply(params: {
  payload: OutboundReplyPayload;
  chatId: string;
  accountId: string;
  threadTimestamp?: number;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, chatId, accountId, threadTimestamp, statusSink } = params;
  await deliverFormattedTextWithAttachments({
    payload,
    send: async ({ text }) => {
      const chunks =
        text.length <= ROAM_TEXT_CHUNK_LIMIT
          ? [text]
          : getRoamRuntime().channel.text.chunkMarkdownText(text, ROAM_TEXT_CHUNK_LIMIT);
      for (const chunk of chunks) {
        if (!chunk) {
          continue;
        }
        await sendMessageRoam(chatId, chunk, { accountId, threadTimestamp });
        statusSink?.({ lastOutboundAt: Date.now() });
      }
    },
  });
}

export async function handleRoamInbound(params: {
  message: RoamInboundMessage;
  account: ResolvedRoamAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  /** Bot's chat address ID for self-message filtering. */
  botId?: string;
  /**
   * Owner's user UUID (PATs only). When set, the handler responds only to
   * messages from the owner — uniform across DM and group surfaces.
   */
  ownerId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, botId, ownerId, statusSink } = params;
  const core = getRoamRuntime();

  // Drop messages sent by the bot itself to prevent infinite loops.
  if (botId && message.senderId === botId) {
    runtime.log?.(`roam[${account.accountId}]: drop self-message from bot ${botId}`);
    return;
  }

  // Personal bots respond only to their owner. token.info gives us the owner
  // for PATs (rmp-); org tokens (rmk-) have no owner and skip this gate. The
  // check is uniform across DM and group surfaces — a non-owner DMing the bot
  // and a non-owner messaging in a group the bot joined are functionally the
  // same and should be treated identically.
  if (ownerId && message.senderId !== ownerId) {
    runtime.log?.(
      `roam[${account.accountId}]: drop sender ${message.senderId} (not owner; personal bot)`,
    );
    return;
  }

  const chatId = message.chatId;
  const typingThreadTimestamp = message.threadTimestamp;
  const fireTypingPulse = () => {
    sendTypingRoam(chatId, {
      accountId: account.accountId,
      threadTimestamp: typingThreadTimestamp,
    }).catch((err) => {
      logTypingFailure({
        log: (msg) => runtime.log?.(msg),
        channel: CHANNEL_ID,
        target: chatId,
        error: err,
      });
    });
  };
  // Typing pulse is started AFTER all drop checks pass (see "begin typing
  // pulse" below). Dropped messages must not leave a chat.typing trace; the
  // shared contract fixtures assert zero API calls on the drop paths.
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  try {
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  const hasMedia = (message.mediaUrls?.length ?? 0) > 0;
  if (!rawBody && !hasMedia) {
    return;
  }

  const isGroup = message.chatType === "group";
  const senderId = message.senderId;
  const senderName = message.senderName;

  // `lastInboundAt` is a Date.now()-style ms field; convert from the µs identifier.
  const messageTimestampMs = Math.floor(message.timestampMicros / 1000);
  statusSink?.({ lastInboundAt: messageTimestampMs });

  // Default is "open" — DMs to a Roam bot are gated by workspace membership
  // (anyone in the workspace can DM anyone). Personal bots are additionally
  // owner-locked above; org bots can opt into a hard allowlist via `allowFrom`.
  // Pairing remains opt-in via `dmPolicy: "pairing"`.
  const dmPolicy = account.config.dmPolicy ?? "open";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config as OpenClawConfig);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent:
        ((config.channels as Record<string, unknown> | undefined)?.roam ?? undefined) !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "roam",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => runtime.log?.(message),
  });

  const configAllowFrom = normalizeRoamAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeRoamAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeRoamAllowlist(storeAllowFrom);

  const groupMatch = resolveRoamGroupMatch({
    groups: account.config.groups,
    chatId,
  });
  const groupConfig = groupMatch.groupConfig;
  // The per-group `groups` map gates chats only in `allowlist` policy mode.
  // Under `open`, listed entries are optional overrides (system prompt, mention
  // requirement, etc.), not an allowlist — otherwise adding one entry would
  // implicitly lock out every other group, which has burned users adding the
  // bot to a fresh group.
  if (isGroup && groupPolicy === "allowlist" && !groupMatch.allowed) {
    // If the operator has explicitly opted into allowlist mode and the bot is
    // @-mentioned in a group it doesn't yet know about, post a one-time
    // courtesy reply explaining how to enable it. Mirrors the DM-pairing UX:
    // silence is fine for incidental traffic, but a direct mention is a clear
    // signal of user intent that the bot should respond to.
    const rawTextForMention = message.text?.trim() ?? "";
    if (
      wasBotMentioned(rawTextForMention, botId) &&
      shouldSendNotAllowlistedNotice(`${account.accountId}:${chatId}`)
    ) {
      await sendMessageRoam(
        chatId,
        buildNotAllowlistedNotice({ accountId: account.accountId, chatId }),
        {
          accountId: account.accountId,
          threadTimestamp: message.threadTimestamp,
        },
      ).catch((err) => {
        runtime.error?.(
          `roam[${account.accountId}]: failed to post not-allowlisted notice for chat ${chatId}: ${String(err)}`,
        );
      });
    }
    runtime.log?.(`roam[${account.accountId}]: drop chat ${chatId} (not allowlisted)`);
    return;
  }
  if (groupConfig?.enabled === false) {
    runtime.log?.(`roam[${account.accountId}]: drop chat ${chatId} (disabled)`);
    return;
  }

  const groupAllowFrom = normalizeRoamAllowlist(groupConfig?.allowFrom);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups =
    (config.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: storeAllowList,
    isSenderAllowed: (allowFrom) => resolveRoamAllowlistMatch({ allowFrom, senderId }).allowed,
    command: {
      useAccessGroups,
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAuthorized;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;

  if (isGroup) {
    if (access.decision !== "allow") {
      runtime.log?.(`roam[${account.accountId}]: drop group sender ${senderId} (reason=${access.reason})`);
      return;
    }
    const groupAllow = resolveRoamGroupAllow({
      groupPolicy,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: groupAllowFrom,
      senderId,
    });
    if (!groupAllow.allowed) {
      runtime.log?.(`roam[${account.accountId}]: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (access.decision !== "allow") {
      runtime.log?.(
        `roam[${account.accountId}]: DM access decision=${access.decision} reason=${access.reason} sender=${senderId}`,
      );
      if (access.decision === "pairing") {
        runtime.log?.(`roam[${account.accountId}]: issuing pairing challenge to ${senderId} in chat ${chatId}`);
        await pairing.issueChallenge({
          senderId,
          senderIdLine: `Your Roam user id: ${senderId}`,
          meta: { name: senderName || undefined },
          sendPairingReply: async (text) => {
            runtime.log?.(`roam[${account.accountId}]: sending pairing reply to ${chatId}`);
            await sendMessageRoam(chatId, text, { accountId: account.accountId });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onReplyError: (err) => {
            runtime.error?.(`roam[${account.accountId}]: pairing reply failed for ${senderId}: ${String(err)}`);
          },
        });
      } else if (
        shouldSendNotAllowlistedNotice(`dm:${account.accountId}:${senderId}`)
      ) {
        // Allowlist-style DM denial. Mirror the group-side courtesy notice:
        // tell the sender how to get added rather than silently dropping.
        // Debounced per (accountId, senderId) per process so a single stranger
        // can't make us spam.
        await sendMessageRoam(
          chatId,
          buildNotAllowlistedDmNotice({ accountId: account.accountId, senderId }),
          { accountId: account.accountId },
        ).catch((err) => {
          runtime.error?.(
            `roam[${account.accountId}]: failed to post not-allowlisted DM notice for ${senderId}: ${String(err)}`,
          );
        });
      }
      runtime.log?.(`roam[${account.accountId}]: drop DM sender ${senderId} (reason=${access.reason})`);
      return;
    }
  }

  if (access.shouldBlockControlCommand) {
    logInboundDrop({
      log: (message) => runtime.log?.(message),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  // Strip bot mentions from body before processing
  const bodyForAgent = stripBotMention(rawBody, botId);

  // If the message was only a bot mention with no actual content (and no media), drop it.
  if (!bodyForAgent && !hasControlCommand && !hasMedia) {
    runtime.log?.(`roam[${account.accountId}]: drop mention-only message from ${senderId}`);
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const canDetectMention = mentionRegexes.length > 0 || !!botId;
  const wasMentioned = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : wasBotMentioned(rawBody, botId);
  const shouldRequireMention = isGroup
    ? resolveRoamRequireMention({
        groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;
  const mentionGate = resolveRoamMentionGate({
    isGroup,
    requireMention: shouldRequireMention,
    canDetectMention,
    wasMentioned,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  });
  if (isGroup && mentionGate.shouldSkip) {
    runtime.log?.(`roam[${account.accountId}]: drop chat ${chatId} (no mention)`);
    return;
  }

  // Begin typing pulse: past every drop check, we will dispatch. The pulse
  // covers the slow tail (history fetch, media download, agent dispatch).
  // Roam's typing TTL is ~3s; 2s pulses keep continuous overlap.
  fireTypingPulse();
  typingInterval = setInterval(fireTypingPulse, 2000);

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? chatId : senderId,
    },
  });

  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    { agentId: route.agentId },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Roam",
    from: fromLabel,
    timestamp: messageTimestampMs,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent || rawBody,
  });

  const groupSystemPrompt = isGroup
    ? resolveRoamGroupSystemPrompt({
        groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : undefined;

  // Decide where the bot's reply lands in the chat:
  //   1. Inbound already in a thread → reply in that same thread (use parent ts).
  //   2. Top-level inbound + group is configured `replyInThread: true` → start
  //      a new thread under the inbound message (use inbound timestamp as parent).
  //   3. Otherwise → reply at top level.
  // Roam expects threadTimestamp in microseconds; message.timestamp is in ms
  // (converted at webhook ingestion), so multiply by 1000 for case (2).
  const replyInThread = isGroup
    ? resolveRoamReplyInThread({
        groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;
  const threadTimestamp = !isGroup
    ? undefined
    : message.threadTimestamp !== undefined
      ? message.threadTimestamp
      : replyInThread
        ? message.timestampMicros
        : undefined;

  // Pre-fetch chat history for groups so the agent sees context it would
  // otherwise have missed. DMs are intentionally skipped — the openclaw
  // session for `roam:<senderId>` already records every inbound + outbound
  // (the bot is always a participant), so chat.history is redundant.
  //
  // We fetch two pages in parallel and merge them:
  //   1. Top-level chat history (no threadTimestamp) — gives the parent
  //      that started the thread plus surrounding top-level context. The
  //      v1 `chat.history?threadTimestamp=X` endpoint returns only the
  //      REPLIES of message X (not X itself), so without this fetch the
  //      agent has no record of the message it's replying to.
  //   2. Thread replies (with threadTimestamp) — sibling messages in the
  //      same thread when there are several. Often empty on the first
  //      reply, which is exactly the case where the top-level fetch saves us.
  //
  // Memoization gate (only safe when the bot sees every message in the
  // chat): proactive bots configured with `requireMention: false` receive a
  // webhook for every message and the session records continuous coverage,
  // so we only need to fetch chat.history on the FIRST turn for each
  // (session, scope) — after that, re-fetching would just duplicate
  // context the agent already has and burn tokens N² as threads grow.
  //
  // For the mention-only case (`requireMention: true`, the typical PAT-bot
  // shape — bot can't be a channel member and only sees @-mentions),
  // ALWAYS fetch: any number of messages may have been posted between
  // the bot's prior mention and now, and none of them were dispatched to
  // the agent, so the session has gaps the memo would mask.
  //
  // Bounded by historyLimit (default 20, server max 200). 0 disables.
  const historyLimit = account.config.historyLimit ?? 20;
  const historyScope = threadTimestamp !== undefined ? `thread:${threadTimestamp}` : "top";
  const historyMemoKey = route.sessionKey ?? `chat:${chatId}`;
  // shouldRequireMention is true only for groups; for DMs we exit before reaching here.
  const canMemoizeHistory = isGroup && !shouldRequireMention;
  const shouldFetchHistory =
    isGroup &&
    historyLimit > 0 &&
    (!canMemoizeHistory || !hasFetchedHistoryFor(historyMemoKey, historyScope));
  const historyFetchCfg = {
    cfg: config,
    accountId: account.accountId,
    apiKey: account.apiKey,
    apiBaseUrl: account.config.apiBaseUrl,
    chatId,
    limit: historyLimit,
  } as const;
  const fetches: Array<Promise<RoamHistoryMessage[]>> = [];
  if (shouldFetchHistory) {
    fetches.push(
      fetchRoamChatHistory(historyFetchCfg).catch((err) => {
        runtime.error?.(
          `roam[${account.accountId}]: chat.history (top-level) failed for chat ${chatId}: ${String(err)}`,
        );
        return [];
      }),
    );
    if (threadTimestamp !== undefined) {
      fetches.push(
        fetchRoamChatHistory({ ...historyFetchCfg, threadTimestamp }).catch((err) => {
          runtime.error?.(
            `roam[${account.accountId}]: chat.history (thread=${threadTimestamp}) failed for chat ${chatId}: ${String(err)}`,
          );
          return [];
        }),
      );
    }
    if (canMemoizeHistory) {
      recordHistoryFetched(historyMemoKey, historyScope);
    }
  }
  const fetched = (await Promise.all(fetches)).flat();
  // Dedupe by microsecond timestamp (a message that appears in both fetches
  // — e.g. the parent surfaced in the top-level page AND echoed in the thread
  // page — should only be delivered to the agent once). Filter out the
  // inbound itself (already delivered as Body). Sort ascending so the agent
  // reads chronologically.
  const byTimestamp = new Map<number, RoamHistoryMessage>();
  for (const entry of fetched) {
    if (entry.timestamp === message.timestampMicros) continue;
    byTimestamp.set(entry.timestamp, entry);
  }
  const inboundHistory = [...byTimestamp.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((entry) => ({
      sender: entry.sender,
      body: entry.text ?? "",
      timestamp: Math.floor(entry.timestamp / 1000),
    }));

  // Download media attachments to local files so the media understanding pipeline can process them.
  let mediaPaths: string[] | undefined;
  let mediaUrls: string[] | undefined;
  let mediaTypes: string[] | undefined;
  if (message.mediaUrls?.length) {
    const downloaded = await downloadMediaToLocal(
      message.mediaUrls,
      message.mediaTypes ?? [],
      (msg) => runtime.log?.(`roam[${account.accountId}] ${msg}`),
    );
    if (downloaded.paths.length > 0) {
      mediaPaths = downloaded.paths;
      mediaUrls = downloaded.urls;
      mediaTypes = downloaded.types;
    }
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent || rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    InboundHistory: inboundHistory.length > 0 ? inboundHistory : undefined,
    // Carry the Roam-native thread parent timestamp forward so outbound replies
    // land in the same thread. The host surfaces this as ChannelOutboundContext.threadId.
    MessageThreadId: threadTimestamp,
    From: isGroup ? `roam:group:${chatId}` : `roam:${senderId}`,
    To: `roam:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    GroupSubject: isGroup ? chatId : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: messageTimestampMs,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `roam:${chatId}`,
    CommandAuthorized: commandAuthorized,
    MediaPaths: mediaPaths,
    MediaUrls: mediaUrls,
    MediaTypes: mediaTypes,
  });

  const previewMode = resolveChannelPreviewStreamMode(account.config, "partial");
  const nativeTransport = resolveChannelStreamingNativeTransport(account.config);
  // Native streaming is supported on `api.ro.am` since the Streaming API merge,
  // so `nativeTransport: true` is sufficient — no need to gate by host.
  const allowNativeAnswerTransport = nativeTransport === true;
  const useStreaming = previewMode === "partial" && account.apiKey.length > 0;

  // `onActivity` fires when a track actually sends to Roam (chat.post or
  // chat.update returned OK). We also use this signal to stop the typing
  // pulse: stopping on the first agent token (the old behavior) leaves a
  // visible gap between "typing disappears" and "first message arrives" when
  // the model thinks for a while. Keeping the pulse until the first real send
  // means the indicator is replaced by the message without a flicker.
  const onActivity = () => {
    stopTypingPulse();
    statusSink?.({ lastOutboundAt: Date.now() });
  };
  // Thinking uses the native stream lifecycle with kind="thinking" so Roam
  // renders it as a collapsed thought-bubble (ThinkingContent) rather than a
  // normal chat message. `threadTimestamp` is passed through when set so the
  // thought-bubble lives inside the same thread as the answer.
  const thinkingTrack = useStreaming
    ? createRoamThinkingStreamTrack({
        chatId,
        threadTimestamp,
        accountId: account.accountId,
        apiKey: account.apiKey,
        onError: (msg) => runtime.error?.(`roam-stream[thinking]: ${msg}`),
        onActivity,
      })
    : null;
  // Native streaming is enabled when `streaming.nativeTransport: true`. Falls
  // back to the draft `chat.post` + `chat.update` path otherwise.
  // Capture the most recent stream error so the fallback log can include the
  // root cause inline (otherwise "fallback chat.post" lands in logs without
  // context for *why* the stream failed).
  let lastAnswerStreamError: string | undefined;
  const recordAnswerStreamError = (label: string) => (msg: string) => {
    lastAnswerStreamError = msg;
    runtime.error?.(`roam-stream[${label}]: ${msg}`);
  };
  const answerTrack = useStreaming
    ? allowNativeAnswerTransport
      ? createRoamAnswerStreamTrack({
          chatId,
          threadTimestamp,
          accountId: account.accountId,
          apiKey: account.apiKey,
          onError: recordAnswerStreamError("answer-native"),
          onActivity,
        })
      : createRoamLiveMessageTrack({
          chatId,
          threadTimestamp,
          accountId: account.accountId,
          apiKey: account.apiKey,
          onError: recordAnswerStreamError("answer"),
          onActivity,
        })
    : null;
  let splitReasoningOnNextStream = false;

  // Stop the typing pulse once we begin sending. Roam holds the typing
  // indicator for ~3s after the last pulse, so if we keep pulsing right up
  // until the final send, the indicator visibly outlasts the message.
  // Idempotent — fine if already cleared.
  const stopTypingPulse = () => {
    clearInterval(typingInterval);
  };

  const deliver = async (payload: OutboundReplyPayload): Promise<void> => {
    stopTypingPulse();
    // Reasoning payloads are stripped by normalizeReplyPayloadsForDelivery, so
    // deliver only ever receives the answer payload. Reasoning content is
    // streamed separately via onReasoningStream/onReasoningEnd into the
    // thinking track.
    const reply = resolveSendableOutboundReplyParts(payload);
    if (useStreaming && answerTrack && reply.hasText && !reply.hasMedia) {
      const fullText = payload.text ?? "";
      if (!answerTrack.isFailed()) {
        await answerTrack.finalize(fullText);
        if (!answerTrack.isFailed()) {
          return;
        }
      }
      // Edit failed (or track failed mid-stream): chat.post the suffix beyond
      // what was already committed via byte-cap splits.
      const committed = answerTrack.getCommittedLength();
      const payloadToSend =
        committed > 0 && committed < fullText.length
          ? { ...payload, text: fullText.slice(committed) }
          : payload;
      runtime.log?.(
        `roam-stream[answer]: fallback chat.post chat=${chatId} fullLen=${fullText.length} committed=${committed} sendLen=${(payloadToSend.text ?? "").length} cause=${lastAnswerStreamError ?? "unknown"}`,
      );
      await deliverRoamReply({
        payload: payloadToSend,
        chatId,
        accountId: account.accountId,
        threadTimestamp,
        statusSink,
      });
      return;
    }

    // Media payloads (or streaming disabled) always go via chat.post.
    await deliverRoamReply({
      payload,
      chatId,
      accountId: account.accountId,
      threadTimestamp,
      statusSink,
    });
  };

  // Drive the typing indicator from the plugin: the published
  // `dispatchInboundReplyWithBase` does not forward the typing wiring on
  // `replyOptions` to the buffered-block dispatcher, so we pulse `chat.typing`
  // ourselves until the dispatch resolves. Roam's server-side typing TTL is
  // short; an initial pulse plus a 5s heartbeat keeps the indicator visible.
  try {
    await dispatchInboundReplyWithBase({
      cfg: config as OpenClawConfig,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      route,
      storePath,
      ctxPayload,
      core,
      deliver,
      onRecordError: (err: unknown) => {
        runtime.error?.(`roam[${account.accountId}]: failed updating session meta: ${String(err)}`);
      },
      onDispatchError: (err: unknown, info: { kind: string }) => {
        runtime.error?.(`roam[${account.accountId}] ${info.kind} reply failed: ${String(err)}`);
      },
      replyOptions: {
        // Roam is a direct-reply channel: the agent's assistant text is the
        // user-facing reply, not a side-channel that needs an explicit
        // `message.send` tool call to be visible. Without this, the host's
        // default for group chats — `sourceReplyDeliveryMode: "message_tool_only"`
        // when `messages.groupChat.visibleReplies` is anything other than
        // "automatic" — silently suppresses replies in groups: the agent
        // produces text in its session log, the dispatcher hits the
        // `suppressDelivery` branch, and our `deliver` callback is never
        // invoked. Force "automatic" so Roam group replies always reach the
        // channel regardless of the host-level visibleReplies preference.
        sourceReplyDeliveryMode: "automatic",
        skillFilter: groupConfig?.skills,
        disableBlockStreaming: useStreaming
          ? true
          : typeof resolveChannelStreamingBlockEnabled(account.config) === "boolean"
            ? !resolveChannelStreamingBlockEnabled(account.config)
            : undefined,
        onPartialReply:
          useStreaming && answerTrack
            ? (payload: { text?: string }) => {
                // Typing pulse is stopped by `onActivity` on the first
                // successful send, NOT here on the first token — see the
                // comment on `onActivity` above.
                return answerTrack.pushAccumulated(payload.text ?? "");
              }
            : undefined,
        onReasoningStream:
          useStreaming && thinkingTrack
            ? async (payload: { text?: string }) => {
                if (splitReasoningOnNextStream) {
                  await thinkingTrack.rotate();
                  splitReasoningOnNextStream = false;
                }
                await thinkingTrack.pushAccumulated(payload.text ?? "");
              }
            : undefined,
        onReasoningEnd:
          useStreaming && thinkingTrack
            ? () => {
                // Mirror Telegram: defer the split until next reasoning chunk so
                // the current message stays open for late edits.
                splitReasoningOnNextStream = true;
              }
            : undefined,
        onAssistantMessageStart:
          useStreaming && answerTrack ? () => answerTrack.rotate() : undefined,
      },
    });
  } finally {
    // Inner finally: track lifecycle is tied to dispatch. The outer finally
    // owns `clearInterval` — don't duplicate it here.
    if (thinkingTrack) {
      await thinkingTrack.finalize();
    }
    if (answerTrack) {
      await answerTrack.finalize();
    }
  }
  } finally {
    clearInterval(typingInterval);
  }
}
