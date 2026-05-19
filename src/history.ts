import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveApiBase } from "./api-base.js";
import { stripRoamTargetPrefix } from "./normalize.js";
import { getRoamRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

export type RoamHistoryMessage = {
  sender: string;
  text?: string;
  timestamp: number;
  threadTimestamp?: number;
};

export type FetchRoamChatHistoryParams = {
  cfg: CoreConfig;
  accountId: string;
  apiKey: string;
  apiBaseUrl?: string;
  chatId: string;
  /** When set, fetch only replies of the thread parented at this microsecond timestamp. */
  threadTimestamp?: number;
  /** Max messages to return (default 10, server max 200). */
  limit?: number;
};

const DEFAULT_HISTORY_LIMIT = 20;

/**
 * GET /v1/chat.history — list recent messages in a chat (optionally scoped to a
 * thread by `threadTimestamp`). Used by the channel to fetch context the agent
 * should see before replying.
 */
export async function fetchRoamChatHistory(
  params: FetchRoamChatHistoryParams,
): Promise<RoamHistoryMessage[]> {
  const chatId = stripRoamTargetPrefix(params.chatId);
  if (!chatId) {
    return [];
  }

  const apiBase = resolveApiBase(params.cfg, params.apiBaseUrl);
  const url = new URL(`${apiBase}/chat.history`);
  // Deployed v1 API expects `chatId` here even though the OpenAPI draft names it `chat`.
  url.searchParams.set("chatId", chatId);
  if (params.threadTimestamp !== undefined) {
    url.searchParams.set("threadTimestamp", String(params.threadTimestamp));
  }
  url.searchParams.set("limit", String(params.limit ?? DEFAULT_HISTORY_LIMIT));

  const logger = getRoamRuntime().logging.getChildLogger({
    channel: "roam",
    accountId: params.accountId,
  });
  const startedAt = Date.now();

  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      method: "GET",
      headers: { Authorization: `Bearer ${params.apiKey}` },
    },
    auditContext: "roam-chat-history",
  });

  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      logger.warn(
        `[roam-history] FAIL chat=${chatId} thread=${params.threadTimestamp ?? "-"} status=${response.status} dt=${Date.now() - startedAt}ms body=${errorBody.slice(0, 200)}`,
      );
      return [];
    }
    const data = (await response.json()) as {
      messages?: Array<{
        sender?: string;
        text?: string;
        timestamp?: number;
        threadTimestamp?: number;
      }>;
    };
    const messages = (data.messages ?? []).flatMap<RoamHistoryMessage>((m) => {
      if (typeof m.sender !== "string" || typeof m.timestamp !== "number") {
        return [];
      }
      return [
        {
          sender: m.sender,
          text: typeof m.text === "string" ? m.text : undefined,
          timestamp: m.timestamp,
          threadTimestamp: typeof m.threadTimestamp === "number" ? m.threadTimestamp : undefined,
        },
      ];
    });
    logger.info(
      `[roam-history] OK chat=${chatId} thread=${params.threadTimestamp ?? "-"} count=${messages.length} dt=${Date.now() - startedAt}ms`,
    );
    return messages;
  } finally {
    await release();
  }
}
