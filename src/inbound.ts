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
  resolveRoamRequireMention,
} from "./policy.js";
import { getRoamRuntime } from "./runtime.js";
import { sendMessageRoam, sendTypingRoam } from "./send.js";
import { createRoamLiveMessageTrack } from "./streaming.js";
import type { CoreConfig, RoamInboundMessage } from "./types.js";

const CHANNEL_ID = "roam" as const;

/** Strip Roam mention syntax for the bot's own user ID. */
function stripBotMention(text: string, botId?: string): string {
  if (botId) {
    // Only strip the bot's own mention, preserve other user mentions
    const escaped = botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`<!?@${escaped}>`, "gi"), "").trim();
  }
  // Fallback: strip all <@xxx> mentions when bot ID is unknown
  return text.replace(/<!?@[0-9a-f-]+>/gi, "").trim();
}

/** Check if the bot was mentioned in the message. */
function wasBotMentioned(text: string, botId?: string): boolean {
  if (botId) {
    const escaped = botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`<!?@${escaped}>`, "i").test(text);
  }
  // Without a known botId, we cannot reliably detect bot mentions.
  // Return false to avoid waking the bot on arbitrary user mentions.
  return false;
}

/** Download media URLs to local files for the media understanding pipeline. */
async function downloadMediaToLocal(
  mediaUrls: string[],
  mediaTypes: string[],
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
    } catch {
      // Skip failed downloads; don't block message processing.
    }
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
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, botId, statusSink } = params;
  const core = getRoamRuntime();

  // Drop messages sent by the bot itself to prevent infinite loops.
  if (botId && message.senderId === botId) {
    runtime.log?.(`roam: drop self-message from bot ${botId}`);
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

  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
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
  if (isGroup && !groupMatch.allowed) {
    runtime.log?.(`roam: drop chat ${chatId} (not allowlisted)`);
    return;
  }
  if (groupConfig?.enabled === false) {
    runtime.log?.(`roam: drop chat ${chatId} (disabled)`);
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
      runtime.log?.(`roam: drop group sender ${senderId} (reason=${access.reason})`);
      return;
    }
    const groupAllow = resolveRoamGroupAllow({
      groupPolicy,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: groupAllowFrom,
      senderId,
    });
    if (!groupAllow.allowed) {
      runtime.log?.(`roam: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (access.decision !== "allow") {
      runtime.log?.(
        `roam: DM access decision=${access.decision} reason=${access.reason} sender=${senderId}`,
      );
      if (access.decision === "pairing") {
        runtime.log?.(`roam: issuing pairing challenge to ${senderId} in chat ${chatId}`);
        await pairing.issueChallenge({
          senderId,
          senderIdLine: `Your Roam user id: ${senderId}`,
          meta: { name: senderName || undefined },
          sendPairingReply: async (text) => {
            runtime.log?.(`roam: sending pairing reply to ${chatId}`);
            await sendMessageRoam(chatId, text, { accountId: account.accountId });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onReplyError: (err) => {
            runtime.error?.(`roam: pairing reply failed for ${senderId}: ${String(err)}`);
          },
        });
      }
      runtime.log?.(`roam: drop DM sender ${senderId} (reason=${access.reason})`);
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
    runtime.log?.(`roam: drop mention-only message from ${senderId}`);
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
    runtime.log?.(`roam: drop chat ${chatId} (no mention)`);
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
    timestamp: message.timestamp,
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

  // Reply in the same Roam-native thread as the inbound message, if any. The
  // webhook delivers the parent message's microsecond timestamp on threaded
  // messages; pass it back to chat.post as threadTimestamp.
  const threadTimestamp = isGroup ? message.threadTimestamp : undefined;

  // Pre-fetch chat history for groups so the agent sees context it would
  // otherwise have missed: in `requireMention: true` groups the plugin drops
  // non-mention messages, and in threaded mentions the parent + sibling
  // replies were never delivered to the agent. DMs are intentionally
  // skipped — the openclaw session for `roam:<senderId>` already records
  // every inbound + outbound on that DM (the bot is always a participant),
  // so a chat.history fetch would be redundant. Bounded by historyLimit
  // (default 20, server max 200). 0 disables.
  const historyLimit = account.config.historyLimit ?? 20;
  let threadHistory: RoamHistoryMessage[] = [];
  if (isGroup && historyLimit > 0) {
    threadHistory = await fetchRoamChatHistory({
      cfg: config,
      accountId: account.accountId,
      apiKey: account.apiKey,
      apiBaseUrl: account.config.apiBaseUrl,
      chatId,
      threadTimestamp,
      limit: historyLimit,
    }).catch((err) => {
      runtime.error?.(
        `roam: chat.history failed for chat ${chatId} thread=${threadTimestamp ?? "-"}: ${String(err)}`,
      );
      return [];
    });
  }
  // Filter out the inbound itself (already delivered to the agent as Body) so
  // we don't double-include it. Sort ascending so the model sees chronological
  // order.
  const inboundHistory = threadHistory
    .filter((entry) => entry.timestamp !== message.timestamp * 1000)
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
    const downloaded = await downloadMediaToLocal(message.mediaUrls, message.mediaTypes ?? []);
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
    Timestamp: message.timestamp,
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

  const onActivity = () => statusSink?.({ lastOutboundAt: Date.now() });
  // Thinking uses the native stream lifecycle with kind="thinking" so Roam
  // renders it as a collapsed thought-bubble (ThinkingContent) rather than a
  // normal chat message. The stream lifecycle does not currently support
  // threading, so thinking content is posted at the top level of the chat.
  const thinkingTrack = useStreaming
    ? createRoamThinkingStreamTrack({
        chatId,
        accountId: account.accountId,
        apiKey: account.apiKey,
        onError: (msg) => runtime.error?.(`roam-stream[thinking]: ${msg}`),
        onActivity,
      })
    : null;
  // Native streaming is enabled when `streaming.nativeTransport: true`. Falls
  // back to the draft `chat.post` + `chat.update` path otherwise.
  const answerTrack = useStreaming
    ? allowNativeAnswerTransport
      ? createRoamAnswerStreamTrack({
          chatId,
          accountId: account.accountId,
          apiKey: account.apiKey,
          onError: (msg) => runtime.error?.(`roam-stream[answer-native]: ${msg}`),
          onActivity,
        })
      : createRoamLiveMessageTrack({
          chatId,
          threadTimestamp,
          accountId: account.accountId,
          apiKey: account.apiKey,
          onError: (msg) => runtime.error?.(`roam-stream[answer]: ${msg}`),
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
        `roam-stream[answer]: fallback chat.post chat=${chatId} fullLen=${fullText.length} committed=${committed} sendLen=${(payloadToSend.text ?? "").length}`,
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
        runtime.error?.(`roam: failed updating session meta: ${String(err)}`);
      },
      onDispatchError: (err: unknown, info: { kind: string }) => {
        runtime.error?.(`roam ${info.kind} reply failed: ${String(err)}`);
      },
      replyOptions: {
        skillFilter: groupConfig?.skills,
        disableBlockStreaming: useStreaming
          ? true
          : typeof resolveChannelStreamingBlockEnabled(account.config) === "boolean"
            ? !resolveChannelStreamingBlockEnabled(account.config)
            : undefined,
        onPartialReply:
          useStreaming && answerTrack
            ? (payload: { text?: string }) => {
                // First partial token = model has started speaking; stop typing.
                stopTypingPulse();
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
    clearInterval(typingInterval);
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
