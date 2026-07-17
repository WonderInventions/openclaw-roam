import { MAX_IMAGE_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { getDefaultLocalRoots, loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { fetchRoamApi, roamApiErrorFromResponse } from "./http.js";
import { resolveRoamAccount } from "./accounts.js";
import { resolveApiBase } from "./api-base.js";
import { stripRoamTargetPrefix } from "./normalize.js";
import { getRoamRuntime } from "./runtime.js";
import type { CoreConfig, RoamSendResult } from "./types.js";

type RoamSendOpts = {
  apiKey?: string;
  accountId?: string;
  /** Microsecond parent-message timestamp; posts into the same Roam thread. */
  threadTimestamp?: number;
  /**
   * Item IDs to attach to the message (from a prior `/v1/item.upload`).
   * Roam renders these inline as images/files alongside the text.
   */
  items?: string[];
  cfg?: CoreConfig;
};

function resolveCredentials(
  explicit: { apiKey?: string },
  account: { apiKey: string; accountId: string },
): { apiKey: string } {
  const apiKey = explicit.apiKey?.trim() ?? account.apiKey;
  if (!apiKey) {
    throw new Error(
      `Roam API key missing for account "${account.accountId}" (set channels.roam.apiKey or ROAM_API_KEY for default).`,
    );
  }
  return { apiKey };
}

/**
 * Extract any tracing identifier the Roam edge attached to the response, for
 * inclusion in our own log lines. Helps when correlating a plugin-side error
 * back to a Roam appserver request. Returns an empty string when nothing's
 * present so callers can interpolate unconditionally.
 */
function responseTraceTail(response: Response): string {
  // Defensive — test mocks sometimes return bare `{ ok, status, text }` shapes
  // without a real `Headers` instance. Production responses always have one.
  const headers = response.headers as Headers | undefined;
  const reqId =
    headers?.get("x-request-id") ?? headers?.get("request-id") ?? "";
  return reqId ? ` reqId=${reqId}` : "";
}

function normalizeChatId(to: string): string {
  const normalized = stripRoamTargetPrefix(to);
  if (!normalized) {
    throw new Error("Chat ID is required for Roam sends");
  }
  return normalized;
}

function resolveRoamSendContext(opts: RoamSendOpts): {
  cfg: CoreConfig;
  account: ReturnType<typeof resolveRoamAccount>;
  apiKey: string;
} {
  const cfg = (opts.cfg ?? getRoamRuntime().config.loadConfig()) as CoreConfig;
  const account = resolveRoamAccount({ cfg, accountId: opts.accountId });
  const { apiKey } = resolveCredentials({ apiKey: opts.apiKey }, account);
  return { cfg, account, apiKey };
}

export async function sendMessageRoam(
  to: string,
  text: string,
  opts: RoamSendOpts = {},
): Promise<RoamSendResult> {
  const { cfg, account, apiKey } = resolveRoamSendContext(opts);
  const chatId = normalizeChatId(to);

  const hasItems = (opts.items?.length ?? 0) > 0;
  if (!text?.trim() && !hasItems) {
    throw new Error("Message must be non-empty for Roam sends");
  }

  const tableMode = getRoamRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "roam",
    accountId: account.accountId,
  });
  const message = getRoamRuntime().channel.text.convertMarkdownTables(text.trim(), tableMode);

  const body: Record<string, unknown> = {
    chatId,
    text: message,
    markdown: true,
    sync: true,
  };
  if (opts.threadTimestamp !== undefined) {
    body.threadTimestamp = opts.threadTimestamp;
  }
  if (hasItems) {
    body.items = opts.items;
  }

  const apiBase = resolveApiBase(cfg, account.config.apiBaseUrl);

  const logger = getRoamRuntime().logging.getChildLogger({
    channel: "roam",
    accountId: account.accountId,
  });
  const startedAt = Date.now();
  logger.info(
    `[roam-send] chat.post req chat=${chatId} bytes=${Buffer.byteLength(message, "utf8")} thread=${opts.threadTimestamp ?? "no"}`,
  );

  const { response, release } = await fetchRoamApi({
    url: `${apiBase}/chat.post`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    auditContext: "roam-chat-post",
  });

  let timestamp: number | undefined;
  let responseChatId = chatId;
  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const status = response.status;
      const apiErr = roamApiErrorFromResponse({
        status,
        body: errorBody,
        action: "send",
      });
      // Preserve the more specific chat-not-found wording for bare 404s.
      if (status === 404 && !apiErr.code) {
        apiErr.message = `Roam: chat not found (id=${chatId})`;
      } else if (status === 400 && !errorBody.trim()) {
        apiErr.message = "Roam: bad request - invalid message format";
      }

      logger.warn(
        `[roam-send] chat.post FAIL chat=${chatId} status=${status}${apiErr.code ? ` code=${apiErr.code}` : ""} dt=${Date.now() - startedAt}ms reqBytes=${Buffer.byteLength(message, "utf8")}${responseTraceTail(response)} body=${errorBody.slice(0, 200)}`,
      );
      throw apiErr;
    }

    try {
      const data = (await response.json()) as {
        chat?: string;
        timestamp?: number;
      };
      if (data.chat) {
        responseChatId = data.chat;
      }
      if (typeof data.timestamp === "number") {
        timestamp = data.timestamp;
      }
    } catch {
      // Response parsing failed, but message was sent.
    }
  } finally {
    await release();
  }

  logger.info(
    `[roam-send] chat.post OK  chat=${responseChatId} ts=${timestamp ?? "missing"} dt=${Date.now() - startedAt}ms`,
  );

  getRoamRuntime().channel.activity.record({
    channel: "roam",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { chatId: responseChatId, timestamp };
}

export async function updateMessageRoam(
  to: string,
  timestamp: number,
  text: string,
  opts: RoamSendOpts = {},
): Promise<RoamSendResult> {
  const { cfg, account, apiKey } = resolveRoamSendContext(opts);
  const chatId = normalizeChatId(to);

  if (!Number.isFinite(timestamp)) {
    throw new Error("Roam update requires the original message timestamp");
  }
  if (!text?.trim()) {
    throw new Error("Message must be non-empty for Roam updates");
  }

  const tableMode = getRoamRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "roam",
    accountId: account.accountId,
  });
  const message = getRoamRuntime().channel.text.convertMarkdownTables(text.trim(), tableMode);

  const body: Record<string, unknown> = {
    chatId,
    timestamp,
    text: message,
    markdown: true,
    sync: true,
  };
  if (opts.threadTimestamp !== undefined) {
    body.threadTimestamp = opts.threadTimestamp;
  }

  const apiBase = resolveApiBase(cfg, account.config.apiBaseUrl);

  const logger = getRoamRuntime().logging.getChildLogger({
    channel: "roam",
    accountId: account.accountId,
  });
  const startedAt = Date.now();
  logger.info(
    `[roam-send] chat.update req chat=${chatId} ts=${timestamp} bytes=${Buffer.byteLength(message, "utf8")} thread=${opts.threadTimestamp ?? "no"}`,
  );

  const { response, release } = await fetchRoamApi({
    url: `${apiBase}/chat.update`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    auditContext: "roam-chat-update",
  });

  let responseTimestamp: number | undefined = timestamp;
  let responseChatId = chatId;
  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const status = response.status;
      const apiErr = roamApiErrorFromResponse({
        status,
        body: errorBody,
        action: "update",
      });
      if (status === 404 && !apiErr.code) {
        apiErr.message = `Roam: message not found (chat=${chatId} timestamp=${timestamp})`;
      } else if (status === 400 && !errorBody.trim()) {
        apiErr.message = "Roam: bad request - invalid update";
      }

      logger.warn(
        `[roam-send] chat.update FAIL chat=${chatId} ts=${timestamp} status=${status}${apiErr.code ? ` code=${apiErr.code}` : ""} dt=${Date.now() - startedAt}ms reqBytes=${Buffer.byteLength(message, "utf8")}${responseTraceTail(response)} body=${errorBody.slice(0, 200)}`,
      );
      throw apiErr;
    }

    try {
      const data = (await response.json()) as {
        chat?: string;
        timestamp?: number;
      };
      if (data.chat) {
        responseChatId = data.chat;
      }
      if (typeof data.timestamp === "number") {
        responseTimestamp = data.timestamp;
      }
    } catch {
      // Response parsing failed, but the update was accepted.
    }
  } finally {
    await release();
  }

  logger.info(
    `[roam-send] chat.update OK  chat=${responseChatId} ts=${responseTimestamp} dt=${Date.now() - startedAt}ms`,
  );

  getRoamRuntime().channel.activity.record({
    channel: "roam",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { chatId: responseChatId, timestamp: responseTimestamp };
}

/**
 * Derive a filename from a URL or local-file path. Falls back to a generic
 * name when there's no useful tail segment. Roam requires
 * `Content-Disposition` with a filename on item.upload.
 */
function filenameFromMediaRef(ref: string, contentType: string): string {
  try {
    // Try URL parsing first — works for http(s)://, file://, etc.
    const path = new URL(ref).pathname;
    const last = path.split("/").filter(Boolean).pop();
    if (last && last.includes(".")) return last;
    if (last) return contentTypeFilename(last, contentType);
  } catch {
    // Not a parseable URL — assume a filesystem path.
    const last = ref.split("/").filter(Boolean).pop();
    if (last && last.includes(".")) return last;
    if (last) return contentTypeFilename(last, contentType);
  }
  return contentTypeFilename("attachment", contentType);
}

function contentTypeFilename(base: string, contentType: string): string {
  const ext = contentType === "image/jpeg" ? "jpg"
    : contentType === "image/png" ? "png"
    : contentType === "image/gif" ? "gif"
    : contentType === "image/webp" ? "webp"
    : contentType === "application/pdf" ? "pdf"
    : "bin";
  return `${base}.${ext}`;
}

/**
 * Upload the bytes referenced by `mediaRef` to Roam's `/v1/item.upload` and
 * return the resulting itemId. Pass that itemId in `sendMessageRoam`'s
 * `items` option to attach the upload to a chat message.
 *
 * `mediaRef` may be either:
 * - An HTTP(S) URL (SSRF-guarded fetch), OR
 * - A local filesystem path under one of the OpenClaw media roots
 *   (`~/.openclaw/media/outbound/...`, agent workspace, etc.). The host
 *   runtime resolves outbound attachments to a local path before calling
 *   `sendMedia`, so this is the common case.
 *
 * Local paths are checked against `getDefaultLocalRoots()` for safety — the
 * SDK guards prevent reading arbitrary filesystem locations.
 *
 * Native streaming (`chat.startStream`) doesn't support attachments, so callers
 * that want to send media must use the chat.post path (which is what
 * `deliverRoamReply` always does for media payloads).
 */
export async function uploadItemRoam(
  mediaRef: string,
  opts: RoamSendOpts = {},
): Promise<{ itemId: string }> {
  const { cfg, account, apiKey } = resolveRoamSendContext(opts);
  const apiBase = resolveApiBase(cfg, account.config.apiBaseUrl);
  const logger = getRoamRuntime().logging.getChildLogger({
    channel: "roam",
    accountId: account.accountId,
  });

  // 1. Load the source bytes. `loadWebMedia` accepts both HTTPS URLs (with
  //    SSRF guards) and local file paths (sandboxed to the OpenClaw media
  //    roots). The host runtime saves outbound attachments to a local path
  //    under `~/.openclaw/media/outbound/...` before calling `sendMedia`,
  //    so the local-path branch is the common case in practice.
  //
  //    `optimizeImages: false` keeps the original bytes. The previous
  //    `fetchRemoteMedia` path uploaded the source verbatim; `loadWebMedia`
  //    defaults to re-encoding/resizing images to fit `maxBytes`, which would
  //    silently alter what the user attached (and change the content-type).
  //    Roam accepts up to its 10MB cap, so we enforce `maxBytes` strictly and
  //    let an oversized upload surface as an error rather than mutating it.
  const fetched = await loadWebMedia(mediaRef, {
    maxBytes: MAX_IMAGE_BYTES,
    optimizeImages: false,
    localRoots: getDefaultLocalRoots(),
  });
  const contentType = fetched.contentType ?? "application/octet-stream";
  const filename = fetched.fileName ?? filenameFromMediaRef(mediaRef, contentType);

  // 2. POST to /v1/item.upload with the bytes. Roam requires Content-Type +
  //    Content-Disposition: attachment; filename=...
  const startedAt = Date.now();
  logger.info(
    `[roam-send] item.upload req bytes=${fetched.buffer.length} mime=${contentType} filename=${filename}`,
  );
  const { response, release } = await fetchRoamApi({
    url: `${apiBase}/item.upload`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
      },
      // Buffer is a Uint8Array; cast through Uint8Array for the BodyInit type
      // (Buffer's extra methods make TS reject the direct assignment).
      body: new Uint8Array(fetched.buffer),
    },
    auditContext: "roam-item-upload",
  });
  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const apiErr = roamApiErrorFromResponse({
        status: response.status,
        body: errorBody,
        action: "item.upload",
      });
      logger.warn(
        `[roam-send] item.upload FAIL status=${response.status}${apiErr.code ? ` code=${apiErr.code}` : ""} dt=${Date.now() - startedAt}ms${responseTraceTail(response)} body=${errorBody.slice(0, 200)}`,
      );
      throw apiErr;
    }
    const data = (await response.json()) as { id?: string; mime?: string };
    if (!data.id) {
      throw new Error("Roam item.upload returned no item id");
    }
    logger.info(
      `[roam-send] item.upload OK  id=${data.id} mime=${data.mime ?? contentType} dt=${Date.now() - startedAt}ms`,
    );
    return { itemId: data.id };
  } finally {
    await release();
  }
}

/**
 * Send a typing indicator to a Roam chat. The promise rejects on failure so
 * the caller's `.catch` (typically `logTypingFailure`) actually fires — the
 * indicator itself is non-critical, but losing visibility into repeated
 * typing failures masks real auth / network issues.
 */
export async function sendTypingRoam(
  chatId: string,
  opts: RoamSendOpts = {},
): Promise<void> {
  const { cfg, account, apiKey } = resolveRoamSendContext(opts);
  const normalizedChatId = normalizeChatId(chatId);
  const apiBase = resolveApiBase(cfg, account.config.apiBaseUrl);

  const body: Record<string, unknown> = { chatId: normalizedChatId };
  if (opts.threadTimestamp !== undefined) {
    body.threadTimestamp = opts.threadTimestamp;
  }

  const { response, release } = await fetchRoamApi({
    url: `${apiBase}/chat.typing`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    auditContext: "roam-chat-typing",
  });
  try {
    if (!response.ok) {
      throw new Error(`Roam chat.typing failed (${response.status})`);
    }
  } finally {
    await release();
  }
}
