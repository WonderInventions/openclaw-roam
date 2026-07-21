import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  monitorRoamProvider,
  parseRoamWebhookEvent,
  parseRoamWebhookVerification,
  shouldDispatchChatMessage,
  unwrapRoamWebhookEnvelope,
  verifyStandardWebhookSignature,
  webhookEventToInbound,
} from "./monitor.js";
import type { CoreConfig, RoamWebhookEvent } from "./types.js";

const {
  mockResolveRoamAccount,
  mockResolveLoggerBackedRuntime,
  mockReadWebhookBodyOrReject,
  mockWebhookPipeline,
  webhookRegistration,
} = vi.hoisted(() => ({
  mockResolveRoamAccount: vi.fn(),
  mockResolveLoggerBackedRuntime: vi.fn((_runtime: unknown, logger: unknown) => ({
    log: vi.fn(),
    error: vi.fn(),
    ...(logger as object),
  })),
  mockReadWebhookBodyOrReject: vi.fn(),
  mockWebhookPipeline: vi.fn(),
  webhookRegistration: {} as { target?: unknown; handler?: (req: unknown, res: unknown) => Promise<void> },
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockRegisterUnregister = vi.fn();
const mockActivityRecord = vi.fn();

vi.mock("openclaw/plugin-sdk/extension-shared", () => ({
  resolveLoggerBackedRuntime: mockResolveLoggerBackedRuntime,
}));

vi.mock("./accounts.js", () => ({
  resolveRoamAccount: mockResolveRoamAccount,
}));

vi.mock("./runtime.js", () => ({
  getRoamRuntime: () => ({
    config: { loadConfig: () => ({}) },
    logging: {
      getChildLogger: (_opts?: unknown) => mockLogger,
    },
    channel: {
      activity: { record: mockActivityRecord },
    },
  }),
}));

vi.mock("./inbound.js", () => ({
  handleRoamInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../runtime-api.js", () => ({
  createWebhookInFlightLimiter: () => ({ acquire: vi.fn(), release: vi.fn() }),
  readWebhookBodyOrReject: mockReadWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute: (opts: {
    target: unknown;
    route: { handler: (req: unknown, res: unknown) => Promise<void> };
  }) => {
    webhookRegistration.target = opts.target;
    webhookRegistration.handler = opts.route.handler;
    return { unregister: mockRegisterUnregister };
  },
  resolveWebhookPath: (opts: {
    webhookPath?: string;
    webhookUrl?: string;
    defaultPath: string;
  }) => {
    if (opts.webhookPath) {
      return opts.webhookPath;
    }
    if (opts.webhookUrl) {
      try {
        return new URL(opts.webhookUrl).pathname;
      } catch {
        return opts.defaultPath;
      }
    }
    return opts.defaultPath;
  },
  withResolvedWebhookRequestPipeline: mockWebhookPipeline,
}));

const mockFetchInner = vi.fn();
/** Wraps mockFetchInner to return { response, release } matching fetchWithSsrFGuard shape. */
const mockFetchWithSsrFGuard = vi.fn(async (params: { url: string; init?: RequestInit }) => {
  const response = await mockFetchInner(params.url, params.init);
  return { response, finalUrl: params.url, release: vi.fn() };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => mockFetchWithSsrFGuard(args[0] as never),
}));

function defaultAccount(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    accountId: "default",
    enabled: true,
    apiKey: "test-api-key",
    apiKeySource: "config",
    config: { webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" },
    ...overrides,
  };
}

describe("monitorRoamProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webhookRegistration.target = undefined;
    webhookRegistration.handler = undefined;
    mockResolveRoamAccount.mockReturnValue(defaultAccount());
  });

  afterEach(() => {
    mockFetchInner.mockReset();
  });

  it("fetches bot identity from /v1/token.info at startup", async () => {
    mockFetchInner.mockResolvedValue({
      ok: true,
      json: async () => ({
        bot: { id: "bot-uuid", name: "TestBot", imageUrl: "https://img.test/bot.png" },
      }),
    });

    const { stop } = await monitorRoamProvider({});
    stop();

    const tokenInfoCall = mockFetchInner.mock.calls.find(([url]: string[]) =>
      url.includes("/v1/token.info"),
    );
    expect(tokenInfoCall).toBeDefined();
    expect(tokenInfoCall![1].method).toBe("GET");
    expect(tokenInfoCall![1].headers.Authorization).toBe("Bearer test-api-key");
  });

  it("echoes a valid signed webhook verification before event parsing", async () => {
    const secretBytes = Buffer.from("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "base64");
    const body = JSON.stringify({
      type: "webhook.verification",
      eventId: "evt-verify",
      timestamp: "2026-07-20T12:00:00Z",
      apiVersion: "2026-07-07",
      data: { challenge: "challenge-token", event: "chat.message" },
    });
    const msgId = "msg_verify";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secretBytes)
      .update(`${msgId}.${timestamp}.${body}`)
      .digest("base64");
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });
    mockReadWebhookBodyOrReject.mockResolvedValue({ ok: true, value: body });
    mockWebhookPipeline.mockImplementation(
      async (opts: { handle: (args: { targets: unknown[] }) => Promise<boolean> }) =>
        await opts.handle({ targets: [webhookRegistration.target] }),
    );

    const { stop } = await monitorRoamProvider({});
    const responseBody = vi.fn();
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader: vi.fn(),
      end: responseBody,
    };
    await webhookRegistration.handler?.(
      {
        headers: {
          "webhook-id": msgId,
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${signature}`,
        },
      },
      res,
    );
    stop();

    expect(res.statusCode).toBe(200);
    expect(responseBody).toHaveBeenCalledWith('{"challenge":"challenge-token"}');
  });

  it("rejects a verification with an invalid signature", async () => {
    const body = '{"type":"webhook.verification","data":{"challenge":"token"}}';
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });
    mockReadWebhookBodyOrReject.mockResolvedValue({ ok: true, value: body });
    mockWebhookPipeline.mockImplementation(
      async (opts: { handle: (args: { targets: unknown[] }) => Promise<boolean> }) =>
        await opts.handle({ targets: [webhookRegistration.target] }),
    );

    const { stop } = await monitorRoamProvider({});
    const responseBody = vi.fn();
    const res = { statusCode: 0, headersSent: false, setHeader: vi.fn(), end: responseBody };
    await webhookRegistration.handler?.(
      {
        headers: {
          "webhook-id": "msg_verify",
          "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
          "webhook-signature": "v1,invalid",
        },
      },
      res,
    );
    stop();

    expect(res.statusCode).toBe(401);
    expect(responseBody).toHaveBeenCalledWith("invalid webhook signature");
  });

  it("stores bot identity on account when token.info succeeds (org token shape)", async () => {
    // Org tokens (rmk-) return only `user`, which IS the bot identity. No owner.
    const account = defaultAccount();
    mockResolveRoamAccount.mockReturnValue(account);
    mockFetchInner.mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: "bot-uuid", name: "TestBot" } }),
    });

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(account.botIdentity).toEqual({
      id: "bot-uuid",
      name: "TestBot",
      imageUrl: undefined,
      ownerId: undefined,
    });
  });

  it("captures the owner id from token.info for PATs", async () => {
    // PATs (rmp-) return both `user` (human owner) and `bot` (the PAT's own
    // address). The plugin uses `bot.id` as its self-message identity and
    // `user.id` as the owner the personal bot will respond to.
    const account = defaultAccount();
    mockResolveRoamAccount.mockReturnValue(account);
    mockFetchInner.mockResolvedValue({
      ok: true,
      json: async () => ({
        user: { id: "owner-uuid", name: "Alice" },
        bot: { id: "pat-bot-uuid", name: "Alice's Bot" },
      }),
    });

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(account.botIdentity).toEqual({
      id: "pat-bot-uuid",
      name: "Alice's Bot",
      imageUrl: undefined,
      ownerId: "owner-uuid",
    });
  });

  it("continues without botId when token.info fails", async () => {
    mockFetchInner.mockRejectedValue(new Error("network error"));

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch bot identity"),
    );
  });

  it("continues without botId when token.info returns no bot", async () => {
    mockFetchInner.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch bot identity"),
    );
  });

  it("continues without botId when token.info returns HTTP error", async () => {
    mockFetchInner.mockResolvedValue({ ok: false, status: 401, text: async () => "" });

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch bot identity"),
    );
  });

  it("refuses to start when token.info returns token_revoked (no retry)", async () => {
    mockResolveRoamAccount.mockReturnValue(defaultAccount({ apiKey: "rmk-orgkey" }));
    mockFetchInner.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"ok":false,"error":"token_revoked"}',
    });

    await expect(monitorRoamProvider({})).rejects.toThrow(/token_revoked/);

    const tokenInfoCalls = mockFetchInner.mock.calls.filter(([url]: string[]) =>
      url.includes("token.info"),
    );
    // Permanent auth failure must not retry.
    expect(tokenInfoCalls).toHaveLength(1);
  });

  it("refuses to start when token.info returns invalid_token (no retry)", async () => {
    mockResolveRoamAccount.mockReturnValue(defaultAccount({ apiKey: "rmp-abc123" }));
    mockFetchInner.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"ok":false,"error":"invalid_token"}',
    });

    await expect(monitorRoamProvider({})).rejects.toThrow(/invalid_token/);
    const tokenInfoCalls = mockFetchInner.mock.calls.filter(([url]: string[]) =>
      url.includes("token.info"),
    );
    expect(tokenInfoCalls).toHaveLength(1);
  });

  it("refuses to start a PAT bot (rmp- prefix) when token.info keeps failing", async () => {
    // PATs depend on the owner-only filter for security; without an ownerId
    // the bot would respond to anyone. Fail-closed is safer than degrading.
    mockResolveRoamAccount.mockReturnValue(defaultAccount({ apiKey: "rmp-abc123" }));
    mockFetchInner.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "",
    });

    await expect(monitorRoamProvider({})).rejects.toThrow(
      /Personal Access Token but token.info failed/,
    );
  });

  it("retries token.info before giving up", async () => {
    // First two attempts fail, third succeeds — the warning-then-recover path.
    mockResolveRoamAccount.mockReturnValue(defaultAccount({ apiKey: "rmk-orgkey" }));
    mockFetchInner
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "" })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "" })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { id: "u", name: "n" } }),
      });

    const { stop } = await monitorRoamProvider({});
    stop();

    const tokenInfoCalls = mockFetchInner.mock.calls.filter(([url]: string[]) =>
      url.includes("token.info"),
    );
    expect(tokenInfoCalls).toHaveLength(3);
  });

  it("subscribes webhooks when webhookUrl is configured", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({
        config: {
          webhookUrl: "https://example.com/roam-webhook",
          webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        },
      }),
    );
    // token.info → no bot, webhook.subscribe → ok
    mockFetchInner
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true });

    const { stop } = await monitorRoamProvider({});
    stop();

    const subscribeCall = mockFetchInner.mock.calls.find(([url]: string[]) =>
      url.includes("/v1/webhook.subscribe"),
    );
    expect(subscribeCall).toBeDefined();
    const body = JSON.parse(subscribeCall![1].body);
    expect(body.url).toBe("https://example.com/roam-webhook");
    expect(body.event).toBe("chat.message");
    expect(body.version).toBe("2026-07-07");
  });

  it("skips subscription when webhookUrl is not configured", async () => {
    mockFetchInner.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { stop } = await monitorRoamProvider({});
    stop();

    const subscribeCall = mockFetchInner.mock.calls.find(([url]: string[]) =>
      url.includes("/v1/webhook.subscribe"),
    );
    expect(subscribeCall).toBeUndefined();
  });

  it("logs warning when subscription fails", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({
        config: {
          webhookUrl: "https://example.com/hook",
          webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        },
      }),
    );
    // token.info succeeds, webhook.subscribe fails
    mockFetchInner
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // token.info
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "server error" }); // subscribe

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("webhook subscription failed"),
    );
  });

  it("stop() unregisters webhook target", async () => {
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockRegisterUnregister).toHaveBeenCalled();
  });

  it("stop() unsubscribes webhooks when webhookUrl is configured", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({
        config: {
          webhookUrl: "https://example.com/hook",
          webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        },
      }),
    );
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({});
    stop();

    // Unsubscribe is fire-and-forget; flush microtasks
    await vi.waitFor(() => {
      const unsubscribeCall = mockFetchInner.mock.calls.find(([url]: string[]) =>
        url.includes("/v1/webhook.unsubscribe"),
      );
      expect(unsubscribeCall).toBeDefined();
    });
  });

  it("respects abortSignal", async () => {
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });

    const controller = new AbortController();
    await monitorRoamProvider({ abortSignal: controller.signal });

    controller.abort();
    expect(mockRegisterUnregister).toHaveBeenCalled();
  });

  it("calls stop immediately when abortSignal is already aborted", async () => {
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });

    const controller = new AbortController();
    controller.abort();
    await monitorRoamProvider({ abortSignal: controller.signal });

    expect(mockRegisterUnregister).toHaveBeenCalled();
  });

  it("stop() is idempotent — second call is a no-op", async () => {
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({});
    stop();
    stop(); // second call

    expect(mockRegisterUnregister).toHaveBeenCalledTimes(1);
  });

  it("throws when API key is not configured", async () => {
    mockResolveRoamAccount.mockReturnValue(defaultAccount({ apiKey: "" }));

    await expect(monitorRoamProvider({})).rejects.toThrow("API key not configured");
  });

  it("throws when webhookSecret is not configured", async () => {
    mockResolveRoamAccount.mockReturnValue(defaultAccount({ config: {} }));
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });

    await expect(monitorRoamProvider({})).rejects.toThrow("requires a non-empty signing secret");
  });

  it("uses custom apiBaseUrl for token.info", async () => {
    const cfg = {
      channels: { roam: { apiBaseUrl: "https://api.roam.dev" } },
    } as CoreConfig;
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({ config: cfg });
    stop();

    const tokenInfoCall = mockFetchInner.mock.calls.find(([url]: string[]) =>
      url.includes("token.info"),
    );
    expect(tokenInfoCall).toBeDefined();
    expect(tokenInfoCall![0]).toBe("https://api.roam.dev/v1/token.info");
  });

  it("uses per-account apiBaseUrl over top-level config", async () => {
    const cfg = {
      channels: { roam: { apiBaseUrl: "https://api.toplevel.dev" } },
    } as CoreConfig;
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({
        config: {
          apiBaseUrl: "https://api.account.dev",
          webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        },
      }),
    );
    // Return a valid identity so the token.info retry path doesn't fire and
    // pad the test with 3s of sleeps. The assertion below only cares about
    // the URL, not the body shape.
    mockFetchInner.mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: "u", name: "n" } }),
    });

    const { stop } = await monitorRoamProvider({ config: cfg });
    stop();

    const tokenInfoCall = mockFetchInner.mock.calls.find(([url]: string[]) =>
      url.includes("token.info"),
    );
    expect(tokenInfoCall![0]).toBe("https://api.account.dev/v1/token.info");
  });

  it("uses per-account apiBaseUrl for webhook subscription", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({
        config: {
          webhookUrl: "https://example.com/hook",
          apiBaseUrl: "https://api.account.dev",
          webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        },
      }),
    );
    mockFetchInner.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({});
    stop();

    const subscribeCall = mockFetchInner.mock.calls.find(([url]: string[]) =>
      url.includes("webhook.subscribe"),
    );
    expect(subscribeCall).toBeDefined();
    expect(subscribeCall![0]).toBe("https://api.account.dev/v1/webhook.subscribe");
  });
});

describe("unwrapRoamWebhookEnvelope / parseRoamWebhookEvent", () => {
  const bareMessage = {
    type: "message",
    contentType: "text",
    userId: "user-1",
    chatId: "chat-1",
    text: "hello",
    timestamp: 1718900000000000,
    chatType: "dm" as const,
    version: 1,
  };

  it("passes bare baseline payloads through unchanged", () => {
    expect(unwrapRoamWebhookEnvelope(bareMessage)).toEqual(bareMessage);
    expect(parseRoamWebhookEvent(bareMessage)?.chatId).toBe("chat-1");
  });

  it("unwraps 2026-07-07 envelope via apiVersion + data", () => {
    const enveloped = {
      type: "chat.message",
      eventId: "0197f9a1-7d2e-7cc3-9f6a-8b1c2d3e4f5a",
      timestamp: "2026-07-07T18:23:45.123456Z",
      apiVersion: "2026-07-07",
      data: {
        // envelope omits inner type: "message"
        contentType: "text",
        userId: "user-1",
        chatId: "chat-env",
        text: "from envelope",
        timestamp: 1718900000000000,
        chatType: "dm",
        version: 1,
      },
    };
    const unwrapped = unwrapRoamWebhookEnvelope(enveloped) as Record<string, unknown>;
    expect(unwrapped.type).toBe("message");
    expect(unwrapped.chatId).toBe("chat-env");
    expect(unwrapped.text).toBe("from envelope");

    const parsed = parseRoamWebhookEvent(enveloped);
    expect(parsed).not.toBeNull();
    expect(parsed!.chatId).toBe("chat-env");
    expect(parsed!.text).toBe("from envelope");
    expect(shouldDispatchChatMessage(parsed!)).toBe(true);
  });

  it("does not treat random objects with apiVersion but no data as envelopes", () => {
    const notEnvelope = { ...bareMessage, apiVersion: "2026-07-07" };
    expect(unwrapRoamWebhookEnvelope(notEnvelope)).toEqual(notEnvelope);
  });

  it("still drops enveloped edits/deletes after unwrap", () => {
    const edit = {
      type: "chat.message",
      eventId: "e1",
      timestamp: "2026-07-07T18:23:45Z",
      apiVersion: "2026-07-07",
      data: { ...bareMessage, version: 2, text: "edited" },
    };
    const parsed = parseRoamWebhookEvent(edit);
    expect(parsed).not.toBeNull();
    expect(shouldDispatchChatMessage(parsed!)).toBe(false);
  });
});

describe("parseRoamWebhookVerification", () => {
  it("returns the challenge from a verification envelope", () => {
    expect(
      parseRoamWebhookVerification({
        type: "webhook.verification",
        eventId: "evt-verify",
        timestamp: "2026-07-20T12:00:00Z",
        apiVersion: "2026-07-07",
        data: { challenge: "challenge-token", event: "chat.message" },
      }),
    ).toBe("challenge-token");
  });

  it("rejects malformed and unrelated envelopes", () => {
    expect(parseRoamWebhookVerification({ type: "chat.message", data: {} })).toBeNull();
    expect(parseRoamWebhookVerification({ type: "webhook.verification", data: {} })).toBeNull();
  });
});

describe("shouldDispatchChatMessage", () => {
  // v1 chat.message fires for create/edit/delete. The agent must only see
  // creates — otherwise every edit re-drives a full agent turn.
  const base: RoamWebhookEvent = {
    type: "message",
    contentType: "text",
    userId: "user-1",
    chatId: "chat-1",
    text: "hello",
    timestamp: 1718900000000000,
    chatType: "group",
  };

  it("dispatches creates (version missing or 1)", () => {
    expect(shouldDispatchChatMessage(base)).toBe(true);
    expect(shouldDispatchChatMessage({ ...base, version: 1 })).toBe(true);
  });

  it("drops edits (version > 1)", () => {
    expect(shouldDispatchChatMessage({ ...base, version: 2, text: "edited" })).toBe(
      false,
    );
    expect(shouldDispatchChatMessage({ ...base, version: 5 })).toBe(false);
  });

  it("drops delete tombstones (contentType deleted)", () => {
    expect(
      shouldDispatchChatMessage({
        ...base,
        version: 3,
        contentType: "deleted",
        text: "",
      }),
    ).toBe(false);
    // Even without version, deleted content must never reach the agent.
    expect(
      shouldDispatchChatMessage({
        ...base,
        contentType: "deleted",
        text: "",
      }),
    ).toBe(false);
  });
});

describe("webhookEventToInbound", () => {
  // Roam timestamps are microsecond-precision and Roam indexes messages by
  // the exact µs value. The plugin must carry the raw µs through unchanged
  // so a downstream `chat.post` with `threadTimestamp = msg.timestampMicros`
  // matches an actual message id. Multiplying ms back to µs (the older
  // shortcut) silently loses the remainder and Roam returns 400
  // "threadTimestamp X is not an existing message".
  it("preserves microsecond precision in timestampMicros", () => {
    const inbound = webhookEventToInbound({
      type: "message",
      contentType: "text",
      userId: "user-1",
      chatId: "chat-1",
      text: "hello",
      timestamp: 1779380025366001, // µs with non-zero remainder
      chatType: "group",
    });
    expect(inbound.timestampMicros).toBe(1779380025366001);
    // The inbound message carries ONLY the µs identifier. Consumers that need ms
    // convert at the boundary with Math.floor(timestampMicros / 1000); the lossy
    // form is never stored on the message itself.
    expect(Math.floor(inbound.timestampMicros / 1000) * 1000).not.toBe(
      inbound.timestampMicros,
    );
  });

  it("uses progressive attachment URLs when present (even with assetId)", () => {
    // wonder#45443: webhook items may include a usable `url` while the asset
    // is still finishing ingestion. Prefer the url; never require url to be
    // absent just because assetId is set.
    const inbound = webhookEventToInbound({
      type: "message",
      contentType: "text",
      userId: "user-1",
      chatId: "chat-1",
      text: "see this",
      timestamp: 1718900000000000,
      chatType: "group",
      items: [
        {
          id: "item-1",
          type: "photo",
          mime: "image/png",
          name: "shot.png",
          assetId: "asset-still-ingesting",
          url: "https://assets-cdn.ro.am/content/progressive?sig=1",
        },
        {
          // Metadata-only item without url — skipped, does not block others.
          id: "item-2",
          type: "file",
          mime: "application/pdf",
          assetId: "asset-no-url-yet",
        },
      ],
    });
    expect(inbound.mediaUrls).toEqual([
      "https://assets-cdn.ro.am/content/progressive?sig=1",
    ]);
    expect(inbound.mediaTypes).toEqual(["image/png"]);
  });
});

describe("verifyStandardWebhookSignature", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  // Base64-decode the secret (after stripping whsec_ prefix)
  const secretBytes = Buffer.from("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "base64");

  function signPayload(msgId: string, timestamp: string, body: string): string {
    const content = `${msgId}.${timestamp}.${body}`;
    const sig = createHmac("sha256", secretBytes).update(content).digest("base64");
    return `v1,${sig}`;
  }

  it("accepts a valid signature", () => {
    const msgId = "msg_abc123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"message","userId":"u1"}';
    const signature = signPayload(msgId, timestamp, body);

    const result = verifyStandardWebhookSignature(
      secret,
      {
        "webhook-id": msgId,
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
      },
      body,
    );

    expect(result).toBe(true);
  });

  it("accepts secret without whsec_ prefix", () => {
    const rawSecret = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const msgId = "msg_abc123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"test":true}';
    const signature = signPayload(msgId, timestamp, body);

    const result = verifyStandardWebhookSignature(
      rawSecret,
      {
        "webhook-id": msgId,
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
      },
      body,
    );

    expect(result).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const msgId = "msg_abc123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"message"}';

    const result = verifyStandardWebhookSignature(
      secret,
      {
        "webhook-id": msgId,
        "webhook-timestamp": timestamp,
        "webhook-signature": "v1,invalidsignature==",
      },
      body,
    );

    expect(result).toBe(false);
  });

  it("rejects a wrong-length signature without throwing (timingSafeEqual requires equal lengths)", () => {
    const msgId = "msg_abc123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"message"}';

    // 4 raw bytes vs HMAC-SHA256's 32 — must short-circuit, not crash.
    const result = verifyStandardWebhookSignature(
      secret,
      {
        "webhook-id": msgId,
        "webhook-timestamp": timestamp,
        "webhook-signature": "v1,AAAA",
      },
      body,
    );

    expect(result).toBe(false);
  });

  it("accepts a valid signature when multiple space-separated candidates are sent", () => {
    const msgId = "msg_abc123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"message"}';

    const valid = signPayload(msgId, timestamp, body);
    const result = verifyStandardWebhookSignature(
      secret,
      {
        "webhook-id": msgId,
        "webhook-timestamp": timestamp,
        // Roam may send multiple v1 candidates separated by space; any match wins.
        "webhook-signature": `v1,AAAA ${valid}`,
      },
      body,
    );

    expect(result).toBe(true);
  });

  it("rejects when headers are missing", () => {
    expect(verifyStandardWebhookSignature(secret, {}, '{"test":true}')).toBe(false);
    expect(verifyStandardWebhookSignature(secret, { "webhook-id": "msg_1" }, '{"test":true}')).toBe(
      false,
    );
    expect(
      verifyStandardWebhookSignature(
        secret,
        { "webhook-id": "msg_1", "webhook-timestamp": "123" },
        '{"test":true}',
      ),
    ).toBe(false);
  });

  it("rejects stale timestamps (replay protection)", () => {
    const msgId = "msg_abc123";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
    const body = '{"type":"message"}';
    const signature = signPayload(msgId, staleTimestamp, body);

    const result = verifyStandardWebhookSignature(
      secret,
      {
        "webhook-id": msgId,
        "webhook-timestamp": staleTimestamp,
        "webhook-signature": signature,
      },
      body,
    );

    expect(result).toBe(false);
  });

  it("accepts multiple signatures (picks correct one)", () => {
    const msgId = "msg_abc123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"message"}';
    const validSig = signPayload(msgId, timestamp, body);

    const result = verifyStandardWebhookSignature(
      secret,
      {
        "webhook-id": msgId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,oldsig== ${validSig}`,
      },
      body,
    );

    expect(result).toBe(true);
  });

  it("rejects tampered body", () => {
    const msgId = "msg_abc123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const originalBody = '{"type":"message","userId":"u1"}';
    const signature = signPayload(msgId, timestamp, originalBody);

    const result = verifyStandardWebhookSignature(
      secret,
      {
        "webhook-id": msgId,
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
      },
      '{"type":"message","userId":"attacker"}',
    );

    expect(result).toBe(false);
  });
});
