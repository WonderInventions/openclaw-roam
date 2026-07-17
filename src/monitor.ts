import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { fetchRoamApi, roamApiErrorFromResponse, RoamApiError } from "./http.js";
import { ROAM_API_VERSION } from "./version.js";
import {
  type RuntimeEnv,
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  resolveWebhookPath,
  withResolvedWebhookRequestPipeline,
} from "../runtime-api.js";
import { resolveRoamAccount, type ResolvedRoamAccount } from "./accounts.js";
import { resolveApiBase } from "./api-base.js";
import { handleRoamInbound } from "./inbound.js";
import { getRoamRuntime } from "./runtime.js";
import type { CoreConfig, RoamBotIdentity, RoamInboundMessage, RoamWebhookEvent } from "./types.js";

const DEFAULT_WEBHOOK_PATH_PREFIX = "/roam-webhook";

/** Max age for webhook timestamps before rejecting as replay (5 minutes). */
const WEBHOOK_TIMESTAMP_TOLERANCE_S = 300;

type RoamWebhookTarget = {
  account: ResolvedRoamAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  path: string;
  /** Bot's chat address ID for self-message filtering. */
  botId?: string;
  /**
   * Owner's user UUID (PATs only). When set, the inbound handler drops every
   * message whose sender is not the owner — a personal bot only responds to
   * its owner. Undefined for org tokens.
   */
  ownerId?: string;
  /** Standard-webhooks signing secret for verifying inbound payloads. */
  secret: string;
  /**
   * Health/freshness callback. `lastInboundAt` is set when a webhook is
   * received and accepted (post-signature, pre-gating); `lastOutboundAt` is
   * set each time the plugin successfully posts to Roam. Both are
   * `Date.now()`-style milliseconds since epoch — NOT the raw µs timestamp
   * Roam uses to index messages. Consumers typically surface these as
   * "last seen / last replied" timestamps in operator UIs.
   */
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

/**
 * Verify a standard-webhooks signature (https://www.standardwebhooks.com).
 * Returns true if the signature is valid, false otherwise.
 */
export function verifyStandardWebhookSignature(
  secret: string,
  headers: IncomingMessage["headers"],
  rawBody: string,
): boolean {
  const msgId = headers["webhook-id"] as string | undefined;
  const msgTimestamp = headers["webhook-timestamp"] as string | undefined;
  const msgSignature = headers["webhook-signature"] as string | undefined;

  if (!msgId || !msgTimestamp || !msgSignature) {
    return false;
  }

  // Reject stale timestamps (replay protection)
  const timestampSec = Number.parseInt(msgTimestamp, 10);
  if (Number.isNaN(timestampSec)) {
    return false;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampSec) > WEBHOOK_TIMESTAMP_TOLERANCE_S) {
    return false;
  }

  // Decode the secret key (strip "whsec_" prefix if present, then base64-decode)
  const secretPayload = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretPayload, "base64");

  // Compute expected signature: HMAC-SHA256(key, "${msgId}.${msgTimestamp}.${rawBody}")
  const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`;
  const expectedSigBytes = createHmac("sha256", secretBytes).update(signedContent).digest();

  // The header may contain multiple space-separated "v1,<base64>" signatures.
  // Use timingSafeEqual rather than string equality so signature comparison
  // doesn't leak bits via response-time side channel.
  const signatures = msgSignature.split(" ");
  for (const sig of signatures) {
    const parts = sig.split(",");
    if (parts[0] !== "v1" || typeof parts[1] !== "string") continue;
    let candidateBytes: Buffer;
    try {
      candidateBytes = Buffer.from(parts[1], "base64");
    } catch {
      continue;
    }
    if (candidateBytes.length !== expectedSigBytes.length) continue;
    if (timingSafeEqual(candidateBytes, expectedSigBytes)) {
      return true;
    }
  }
  return false;
}

const webhookTargets = new Map<string, RoamWebhookTarget[]>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();

// Dedup cache for inbound messages. The Roam server can double-deliver
// chat.message webhooks (observed ~50ms apart with distinct webhook-ids but
// identical messageId). Key is `${accountId}:${messageId}` so multi-account
// setups don't cross-contaminate; value is the insertion timestamp in ms.
// Bounded so a sustained high-rate burst can't grow unbounded between TTL
// sweeps: TTL handles the steady state, the size cap handles bursts.
const RECENT_MESSAGE_TTL_MS = 60_000;
const RECENT_MESSAGE_MAX = 10_000;
const recentMessageIds = new Map<string, number>();

function isDuplicateRoamMessage(accountId: string, messageId: string): boolean {
  const key = `${accountId}:${messageId}`;
  const now = Date.now();
  if (recentMessageIds.size > 0) {
    for (const [k, t] of recentMessageIds) {
      if (now - t > RECENT_MESSAGE_TTL_MS) recentMessageIds.delete(k);
      else break;
    }
  }
  if (recentMessageIds.has(key)) return true;
  // Cap by eldest-insertion eviction. Map iteration order is insertion order,
  // so deleting from the front drops the oldest entries first.
  while (recentMessageIds.size >= RECENT_MESSAGE_MAX) {
    const oldest = recentMessageIds.keys().next().value;
    if (oldest === undefined) break;
    recentMessageIds.delete(oldest);
  }
  recentMessageIds.set(key, now);
  return false;
}

/**
 * First API version that wraps every v1 webhook body in the common envelope
 * `{ type, eventId, timestamp, apiVersion, data }`. Detect via `apiVersion`
 * (and a present object `data`) so bare baseline payloads and enveloped
 * deliveries share one code path.
 */
export const ROAM_WEBHOOK_ENVELOPE_VERSION = "2026-07-07";

/**
 * If `raw` is a 2026-07-07+ common event envelope, return the inner `data`
 * payload. For `chat.message`, restore the legacy `type: "message"`
 * discriminator when the envelope carries `type: "chat.message"` and `data`
 * omits it. Bare (baseline `2026-06-01`) payloads pass through unchanged.
 */
export function unwrapRoamWebhookEnvelope(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const env = raw as Record<string, unknown>;
  // Detect by apiVersion + data object (not only equality to 2026-07-07) so
  // future envelope versions keep unwrapping without a pin bump.
  if (typeof env.apiVersion !== "string" || env.apiVersion.length === 0) {
    return raw;
  }
  if (!env.data || typeof env.data !== "object" || Array.isArray(env.data)) {
    return raw;
  }
  const data = { ...(env.data as Record<string, unknown>) };
  if (env.type === "chat.message" && data.type === undefined) {
    data.type = "message";
  }
  return data;
}

export function parseRoamWebhookEvent(raw: unknown): RoamWebhookEvent | null {
  const unwrapped = unwrapRoamWebhookEnvelope(raw);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    return null;
  }
  const obj = unwrapped as Record<string, unknown>;
  if (obj.type !== "message") {
    return null;
  }
  if (typeof obj.userId !== "string") {
    return null;
  }
  if (typeof obj.chatId !== "string") {
    return null;
  }
  if (typeof obj.timestamp !== "number" || !Number.isFinite(obj.timestamp)) {
    return null;
  }
  // Normalize text to string — media-only events may omit it.
  if (obj.text !== undefined && typeof obj.text !== "string") {
    return null;
  }
  // chatType is required for correct DM/group routing.
  if (obj.chatType !== "dm" && obj.chatType !== "channel" && obj.chatType !== "group") {
    return null;
  }
  // Optional edit revision (1 = create, >1 = edit). Accept number only.
  if (obj.version !== undefined && (typeof obj.version !== "number" || !Number.isFinite(obj.version))) {
    return null;
  }
  return obj as unknown as RoamWebhookEvent;
}

/**
 * Whether a parsed `chat.message` webhook should be dispatched to the agent.
 *
 * v1 delivers create, edit, and delete on the same event. Treating every
 * delivery as a new user message re-drives the agent on edits/deletes.
 * Only **new** messages are agent-worthy: `version` missing or `=== 1`, and
 * not a delete tombstone (`contentType === "deleted"`).
 */
export function shouldDispatchChatMessage(event: RoamWebhookEvent): boolean {
  if (event.contentType === "deleted") {
    return false;
  }
  if (event.version !== undefined && event.version !== 1) {
    return false;
  }
  return true;
}

export function webhookEventToInbound(event: RoamWebhookEvent): RoamInboundMessage {
  // Roam timestamps are microsecond-precision. We preserve the raw value
  // unchanged — Roam indexes messages by exact µs, so any consumer that round-
  // trips through a Roam API call (e.g. starting a thread under this message)
  // must use `timestampMicros`. Consumers that want ms convert at the boundary.
  // Derive chat type from the event's chatType field ("dm" → "direct", "channel"/"group" → "group").
  const chatType: "direct" | "group" = event.chatType === "dm" ? "direct" : "group";
  const msg: RoamInboundMessage = {
    messageId: event.messageId ?? String(event.timestamp),
    chatId: event.chatId,
    senderId: event.userId,
    senderName: "",
    text: event.text,
    timestampMicros: event.timestamp,
    chatType,
    // Keep threadTimestamp in microseconds (raw API value). Roam's chat.post
    // and chat.history expect threadTimestamp in microseconds.
    threadTimestamp: event.threadTimestamp ?? undefined,
  };

  // Extract media URLs from attached items. Prefer `url` when present —
  // the appserver may populate progressive content URLs even while the
  // asset is still finishing ingestion (wonder#45443). Items that still
  // lack a url (metadata-only / not ready) are skipped rather than
  // blocking the text path.
  if (Array.isArray(event.items) && event.items.length) {
    const mediaUrls: string[] = [];
    const mediaTypes: string[] = [];
    for (const item of event.items) {
      if (item.url) {
        mediaUrls.push(item.url);
        mediaTypes.push(item.mime ?? "application/octet-stream");
      }
    }
    if (mediaUrls.length > 0) {
      msg.mediaUrls = mediaUrls;
      msg.mediaTypes = mediaTypes;
    }
  }

  return msg;
}

async function handleRoamWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  return await withResolvedWebhookRequestPipeline({
    req,
    res,
    targetsByPath: webhookTargets,
    allowMethods: ["POST"],
    requireJsonContentType: true,
    inFlightLimiter: webhookInFlightLimiter,
    handle: async ({ targets }) => {
      // Read raw body first — needed for standard-webhooks signature verification.
      const rawResult = await readWebhookBodyOrReject({
        req,
        res,
        profile: "post-auth",
        invalidBodyMessage: "invalid payload",
      });
      if (!rawResult.ok) {
        return true;
      }
      const rawBody = rawResult.value;

      // Resolve the target for this path.
      const target = targets[0];
      if (!target) {
        res.statusCode = 404;
        res.end("no target");
        return true;
      }

      // Verify standard-webhooks signature (secret is required at startup).
      if (!verifyStandardWebhookSignature(target.secret, req.headers, rawBody)) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("invalid webhook signature");
        return true;
      }

      // Parse JSON body.
      let parsed: unknown;
      try {
        parsed = rawBody.trim() ? JSON.parse(rawBody) : undefined;
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("invalid JSON payload");
        return true;
      }

      const event = parseRoamWebhookEvent(parsed);
      if (!event) {
        // Surface the rejected event's `type` so operators see when Roam adds
        // a new event kind we don't yet handle, instead of silently 400-ing.
        const rejectedType =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>).type
            : undefined;
        target.runtime.log?.(
          `[${target.account.accountId}] roam: rejected webhook event (type=${
            typeof rejectedType === "string" ? rejectedType : "?"
          }); update the plugin if this is a new Roam event kind`,
        );
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("invalid event payload");
        return true;
      }

      // ACK edits/deletes without re-driving the agent. Still 200 so Roam
      // does not retry; create-only dispatch keeps agent turns correct.
      if (!shouldDispatchChatMessage(event)) {
        const reason =
          event.contentType === "deleted"
            ? "delete"
            : `edit version=${event.version ?? "?"}`;
        target.runtime.log?.(
          `roam webhook event: drop ${reason} chatId=${event.chatId} ts=${event.timestamp} (agent dispatches creates only)`,
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
        return true;
      }

      target.statusSink?.({ lastInboundAt: Date.now() });

      // Acknowledge immediately, process async
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");

      const message = webhookEventToInbound(event);
      if (isDuplicateRoamMessage(target.account.accountId, message.messageId)) {
        target.runtime.log?.(
          `roam webhook event: drop duplicate messageId=${message.messageId} chatId=${message.chatId}`,
        );
        return true;
      }
      target.runtime.log?.(
        `roam webhook event: type=${event.type} chatId=${message.chatId} sender=${message.senderId} chatType=${message.chatType}`,
      );
      const core = getRoamRuntime();
      core.channel.activity.record({
        channel: "roam",
        accountId: target.account.accountId,
        direction: "inbound",
        at: Math.floor(message.timestampMicros / 1000),
      });

      handleRoamInbound({
        message,
        account: target.account,
        config: target.config,
        runtime: target.runtime,
        botId: target.botId,
        ownerId: target.ownerId,
        statusSink: target.statusSink,
      }).catch((err) => {
        target.runtime.error?.(
          `[${target.account.accountId}] Roam webhook handler failed: ${String(err)}`,
        );
      });

      return true;
    },
  });
}

function registerRoamWebhookTarget(target: RoamWebhookTarget): () => void {
  return registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "roam",
      source: "roam-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleRoamWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  }).unregister;
}

const WEBHOOK_EVENT = "chat.message";

/** Subscribe to Roam V1 chat.message webhook events for the given account. */
async function subscribeRoamWebhooks(params: {
  apiKey: string;
  webhookUrl: string;
  cfg?: CoreConfig;
  accountApiBaseUrl?: string;
}): Promise<void> {
  const apiBase = resolveApiBase(params.cfg, params.accountApiBaseUrl);
  const url = `${apiBase}/webhook.subscribe`;
  const { response, release } = await fetchRoamApi({
    url,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: params.webhookUrl,
        event: WEBHOOK_EVENT,
        version: ROAM_API_VERSION,
      }),
    },
    auditContext: "roam-webhook-subscribe",
  });
  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw roamApiErrorFromResponse({
        status: response.status,
        body: errorBody,
        action: "webhook.subscribe",
      });
    }
  } finally {
    await release();
  }
}

/** Unsubscribe from Roam webhook events. Returns void; errors are logged but
 * never thrown — shutdown can't usefully recover from this. */
async function unsubscribeRoamWebhooks(params: {
  apiKey: string;
  webhookUrl: string;
  cfg?: CoreConfig;
  accountApiBaseUrl?: string;
  log?: { warn?: (msg: string) => void };
}): Promise<void> {
  const apiBase = resolveApiBase(params.cfg, params.accountApiBaseUrl);
  try {
    const { response, release } = await fetchRoamApi({
      url: `${apiBase}/webhook.unsubscribe`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: params.webhookUrl, event: WEBHOOK_EVENT }),
      },
      auditContext: "roam-webhook-unsubscribe",
    });
    try {
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        // 4xx/5xx isn't fatal but is worth surfacing — an unsubscribe failure
        // means Roam keeps the subscription pointing at our (now-stopped)
        // webhook URL. If the operator restarts with a new URL the old route
        // will get orphaned traffic until they manually clean it up.
        params.log?.warn?.(
          `Roam webhook.unsubscribe non-OK status=${response.status} body=${body.slice(0, 200)}`,
        );
      }
    } finally {
      await release();
    }
  } catch (err) {
    params.log?.warn?.(`Roam webhook.unsubscribe failed: ${String(err)}`);
  }
}

/**
 * Fetch bot persona identity from token.info.
 *
 * Returns null on transient / non-auth failures (caller may retry).
 * Throws `RoamApiError` with `isPermanentAuthFailure` for `token_revoked` /
 * `invalid_token` so callers stop immediately instead of retrying a dead key.
 */
async function fetchRoamBotIdentity(
  apiKey: string,
  cfg?: CoreConfig,
  accountApiBaseUrl?: string,
): Promise<RoamBotIdentity | null> {
  const apiBase = resolveApiBase(cfg, accountApiBaseUrl);
  try {
    const { response, release } = await fetchRoamApi({
      url: `${apiBase}/token.info`,
      init: {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      auditContext: "roam-token-info",
    });
    try {
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const err = roamApiErrorFromResponse({
          status: response.status,
          body: errorBody,
          action: "token.info",
        });
        if (err.isPermanentAuthFailure) {
          throw err;
        }
        return null;
      }
      // PATs (rmp-) return both `user` (the human owner) and `bot` (the PAT's
      // distinct bot persona). Org tokens (rmk-) return only `user`, which IS
      // the bot identity. Use the presence of `data.bot.id` to disambiguate.
      const data = (await response.json()) as {
        user?: { id?: string; name?: string; imageUrl?: string };
        bot?: { id?: string; name?: string; imageUrl?: string };
      };
      const isPat = Boolean(data.bot?.id);
      const persona = isPat ? data.bot : data.user;
      if (!persona?.id || !persona?.name) {
        return null;
      }
      return {
        id: persona.id,
        name: persona.name,
        imageUrl: persona.imageUrl || undefined,
        // Owner is only meaningful for PATs. For org tokens, leave undefined.
        ownerId: isPat ? data.user?.id : undefined,
      };
    } finally {
      await release();
    }
  } catch (err) {
    if (err instanceof RoamApiError && err.isPermanentAuthFailure) {
      throw err;
    }
    return null;
  }
}

export type RoamMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function monitorRoamProvider(opts: RoamMonitorOptions): Promise<{ stop: () => void }> {
  const core = getRoamRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveRoamAccount({ cfg, accountId: opts.accountId });
  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.apiKey) {
    throw new Error(`Roam API key not configured for account "${account.accountId}"`);
  }

  // Each account gets a unique webhook path to avoid cross-account routing.
  // Default: /roam-webhook (for the default account) or /roam-webhook-<accountId>.
  // When webhookUrl is set, derive the local route path from its pathname.
  const defaultPath =
    account.accountId === "default"
      ? DEFAULT_WEBHOOK_PATH_PREFIX
      : `${DEFAULT_WEBHOOK_PATH_PREFIX}-${account.accountId}`;
  const webhookPath =
    resolveWebhookPath({
      webhookPath: account.config.webhookPath,
      webhookUrl: account.config.webhookUrl,
      defaultPath,
    }) ?? defaultPath;

  const logger = core.logging.getChildLogger({
    channel: "roam",
    accountId: account.accountId,
  });

  // Fetch bot persona identity for self-message filtering and (for PATs)
  // owner-only enforcement. Retry briefly on transient failures so a single
  // network blip at startup doesn't degrade security for the lifetime of the
  // process. Permanent auth failures (token_revoked / invalid_token) abort
  // immediately — retrying a dead key never recovers.
  const accountApiBaseUrl = account.config.apiBaseUrl;
  let botIdentity: RoamBotIdentity | null = null;
  try {
    botIdentity = await fetchRoamBotIdentity(account.apiKey, cfg, accountApiBaseUrl);
    for (let attempt = 1; attempt <= 2 && !botIdentity; attempt++) {
      // Skip the inter-attempt sleep under vitest so retry-path tests don't
      // each cost ~3s of wall time. Production keeps the linear backoff.
      const delayMs = process.env.NODE_ENV === "test" ? 0 : attempt * 1000;
      logger.warn(
        `[${account.accountId}] token.info attempt ${attempt} failed; retrying in ${delayMs}ms`,
      );
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      botIdentity = await fetchRoamBotIdentity(account.apiKey, cfg, accountApiBaseUrl);
    }
  } catch (err) {
    if (err instanceof RoamApiError && err.isPermanentAuthFailure) {
      throw new Error(
        `[${account.accountId}] Roam API key rejected (${err.code}) — refusing to start this account. ` +
          (err.code === "token_revoked"
            ? "The token is permanently unusable (owner archived/deleted or client revoked); discard it and create a new key."
            : "The token is invalid or expired; check channels.roam.apiKey / ROAM_API_KEY and create a new key if needed."),
        { cause: err },
      );
    }
    throw err;
  }
  if (botIdentity) {
    account.botIdentity = botIdentity;
    logger.info(`[${account.accountId}] Roam bot persona: ${botIdentity.name} (${botIdentity.id})`);
  } else {
    // Fail-closed for PATs (rmp-): the owner-only filter is this bot's
    // security boundary. Without an ownerId we'd respond to anyone, which is
    // worse than not starting at all. Org tokens (rmk-) lose self-message
    // filtering but the bot is still workspace-scoped, so we let those start.
    if (account.apiKey.startsWith("rmp-")) {
      throw new Error(
        `[${account.accountId}] Personal Access Token but token.info failed after retries — refusing to start. ` +
          "A PAT bot without a discoverable owner would respond to any sender. " +
          "Check the token's scopes/approval status and restart.",
      );
    }
    logger.warn(
      `[${account.accountId}] Could not fetch bot identity from token.info; self-message filtering disabled`,
    );
  }

  // Require a webhook signing secret — matches Telegram/LINE/Feishu behavior.
  const webhookSecret = account.config.webhookSecret?.trim();
  if (!webhookSecret) {
    throw new Error(
      "Roam webhook mode requires a non-empty signing secret. " +
        "Set channels.roam.webhookSecret with your Roam signing key.",
    );
  }

  // Register the HTTP route on the gateway
  const unregister = registerRoamWebhookTarget({
    account,
    config: cfg,
    runtime,
    path: webhookPath,
    botId: botIdentity?.id,
    ownerId: botIdentity?.ownerId,
    secret: webhookSecret,
    statusSink: opts.statusSink,
  });

  // Attempt to subscribe to Roam V1 chat.message webhook events.
  // Uses webhookUrl from account config (full URL including path).
  const webhookUrl = account.config.webhookUrl?.trim() || undefined;

  if (webhookUrl) {
    // Retry once on transient failure — webhook.subscribe is idempotent
    // server-side, so a redundant retry is cheap. Permanent auth failures
    // (token_revoked / invalid_token) skip the retry. Manual fallback note
    // still applies if attempts fail for other reasons.
    let subscribed = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2 && !subscribed; attempt++) {
      try {
        await subscribeRoamWebhooks({
          apiKey: account.apiKey,
          webhookUrl,
          cfg,
          accountApiBaseUrl,
        });
        subscribed = true;
        logger.info(`[${account.accountId}] Roam webhooks subscribed at ${webhookUrl}`);
      } catch (err) {
        lastErr = err;
        if (err instanceof RoamApiError && err.isPermanentAuthFailure) {
          break;
        }
        if (attempt === 0 && process.env.NODE_ENV !== "test") {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    if (!subscribed) {
      const permanent =
        lastErr instanceof RoamApiError && lastErr.isPermanentAuthFailure
          ? ` (${lastErr.code}; discard this API key — retrying will not help)`
          : "";
      logger.warn(
        `[${account.accountId}] Roam webhook subscription failed after retry: ${String(lastErr)}${permanent}. Register webhooks manually in Roam admin.`,
      );
    }
  } else {
    logger.info(
      `[${account.accountId}] Roam webhook route registered at ${webhookPath} (set channels.roam.webhookUrl to enable auto-subscription)`,
    );
  }

  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    unregister();
    // Best-effort unsubscribe on shutdown — never throws.
    if (webhookUrl) {
      void unsubscribeRoamWebhooks({
        apiKey: account.apiKey,
        webhookUrl,
        cfg,
        accountApiBaseUrl,
        log: { warn: (msg) => logger.warn(`[${account.accountId}] ${msg}`) },
      });
    }
  };

  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      stop();
    } else {
      opts.abortSignal.addEventListener("abort", stop, { once: true });
    }
  }

  return { stop };
}
