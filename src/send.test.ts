import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageRoam, sendTypingRoam, uploadItemRoam } from "./send.js";

const mockLoadWebMedia = vi.fn();
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 10_000_000,
}));
vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => mockLoadWebMedia(...args),
  getDefaultLocalRoots: () => ["/Users/test/.openclaw/media"],
}));

const { mockResolveRoamAccount } = vi.hoisted(() => ({
  mockResolveRoamAccount: vi.fn(),
}));

const mockActivityRecord = vi.fn();

vi.mock("./accounts.js", () => ({
  resolveRoamAccount: mockResolveRoamAccount,
}));

vi.mock("./runtime.js", () => ({
  getRoamRuntime: () => ({
    config: { loadConfig: () => ({}) },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "preserve",
        convertMarkdownTables: (text: string) => text,
      },
      activity: { record: mockActivityRecord },
    },
    logging: {
      getChildLogger: () => ({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      }),
    },
  }),
}));

const mockFetchInner = vi.fn();
const mockFetchWithSsrFGuard = vi.fn(async (params: { url: string; init?: RequestInit }) => {
  const response = await mockFetchInner(params.url, params.init);
  return { response, finalUrl: params.url, release: vi.fn() };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => mockFetchWithSsrFGuard(args[0] as never),
}));

function defaultAccount(overrides?: Record<string, unknown>) {
  return {
    accountId: "default",
    enabled: true,
    apiKey: "test-api-key",
    apiKeySource: "config" as const,
    config: {},
    ...overrides,
  };
}

describe("sendMessageRoam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRoamAccount.mockReturnValue(defaultAccount());
    mockFetchInner.mockResolvedValue({
      ok: true,
      json: async () => ({ chat: "chat-1", timestamp: 1000 }),
    });
  });

  it("posts to /v1/chat.post with correct headers and body", async () => {
    await sendMessageRoam("chat-1", "hello world");

    expect(mockFetchInner).toHaveBeenCalledOnce();
    const [url, opts] = mockFetchInner.mock.calls[0];
    expect(url).toBe("https://api.ro.am/v1/chat.post");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-api-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.chatId).toBe("chat-1");
    expect(body.text).toBe("hello world");
    expect(body.markdown).toBe(true);
    expect(body.sync).toBe(true);
  });

  it("includes threadTimestamp when provided", async () => {
    await sendMessageRoam("chat-1", "hello", { threadTimestamp: 1765602474760032 });

    const body = JSON.parse(mockFetchInner.mock.calls[0][1].body);
    expect(body.threadTimestamp).toBe(1765602474760032);
  });

  it("omits threadTimestamp when not provided", async () => {
    await sendMessageRoam("chat-1", "hello");

    const body = JSON.parse(mockFetchInner.mock.calls[0][1].body);
    expect(body.threadTimestamp).toBeUndefined();
  });

  it("strips roam: target prefix from chatId", async () => {
    await sendMessageRoam("roam:group:chat-1", "hello");

    const body = JSON.parse(mockFetchInner.mock.calls[0][1].body);
    expect(body.chatId).toBe("chat-1");
  });

  it("throws on empty text", async () => {
    await expect(sendMessageRoam("chat-1", "   ")).rejects.toThrow("non-empty");
  });

  it("throws on empty chatId", async () => {
    await expect(sendMessageRoam("", "hello")).rejects.toThrow("Chat ID is required");
  });

  it("throws on missing API key", async () => {
    mockResolveRoamAccount.mockReturnValue(defaultAccount({ apiKey: "" }));
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("API key missing");
  });

  it("maps HTTP 401 to auth error", async () => {
    mockFetchInner.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "" });
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("authentication failed");
  });

  it("maps token_revoked to a permanent auth error", async () => {
    mockFetchInner.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"ok":false,"error":"token_revoked"}',
    });
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toMatchObject({
      name: "RoamApiError",
      code: "token_revoked",
      isPermanentAuthFailure: true,
    });
  });

  it("maps invalid_token distinctly from token_revoked", async () => {
    mockFetchInner.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"ok":false,"error":"invalid_token"}',
    });
    const err = await sendMessageRoam("chat-1", "hello").then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(err).toMatchObject({ code: "invalid_token" });
    expect(String(err?.message)).toMatch(/invalid API token/i);
  });

  it("maps HTTP 403 to forbidden error", async () => {
    mockFetchInner.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "" });
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("forbidden");
  });

  it("maps HTTP 404 to chat-not-found error", async () => {
    mockFetchInner.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("chat not found");
  });

  it("maps HTTP 413 to size-limit error", async () => {
    mockFetchInner.mockResolvedValueOnce({ ok: false, status: 413, text: async () => "" });
    await expect(sendMessageRoam("chat-1", "hello")).rejects.toThrow("too large");
  });

  it("records outbound activity", async () => {
    await sendMessageRoam("chat-1", "hello");

    expect(mockActivityRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "roam",
        accountId: "default",
        direction: "outbound",
      }),
    );
  });

  it("returns chatId and timestamp from response", async () => {
    const result = await sendMessageRoam("chat-1", "hello");
    expect(result.chatId).toBe("chat-1");
    expect(result.timestamp).toBe(1000);
  });

  it("uses custom apiBaseUrl from config", async () => {
    await sendMessageRoam("chat-1", "hello", {
      cfg: { channels: { roam: { apiBaseUrl: "https://api.roam.dev" } } },
    });

    const [url] = mockFetchInner.mock.calls[0];
    expect(url).toBe("https://api.roam.dev/v1/chat.post");
  });

  it("uses per-account apiBaseUrl over top-level config", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({ config: { apiBaseUrl: "https://api.account.dev" } }),
    );
    await sendMessageRoam("chat-1", "hello", {
      cfg: { channels: { roam: { apiBaseUrl: "https://api.toplevel.dev" } } },
    });

    const [url] = mockFetchInner.mock.calls[0];
    expect(url).toBe("https://api.account.dev/v1/chat.post");
  });
});

describe("sendTypingRoam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRoamAccount.mockReturnValue(defaultAccount());
    mockFetchInner.mockResolvedValue({ ok: true });
  });

  it("posts to /v1/chat.typing with chatId", async () => {
    await sendTypingRoam("chat-1");

    expect(mockFetchInner).toHaveBeenCalledOnce();
    const [url, opts] = mockFetchInner.mock.calls[0];
    expect(url).toBe("https://api.ro.am/v1/chat.typing");
    const body = JSON.parse(opts.body);
    expect(body.chatId).toBe("chat-1");
  });

  it("strips target prefix", async () => {
    await sendTypingRoam("roam:chat-1");

    const body = JSON.parse(mockFetchInner.mock.calls[0][1].body);
    expect(body.chatId).toBe("chat-1");
  });

  it("rejects on transport failure so callers can log it", async () => {
    // sendTypingRoam used to swallow fetch errors internally, which made the
    // caller's `.catch(logTypingFailure)` dead code. Now it propagates.
    mockFetchInner.mockRejectedValueOnce(new Error("network error"));
    await expect(sendTypingRoam("chat-1")).rejects.toThrow("network error");
  });

  it("rejects on HTTP error status", async () => {
    mockFetchInner.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    });
    await expect(sendTypingRoam("chat-1")).rejects.toThrow(/chat.typing failed \(502\)/);
  });
});

describe("uploadItemRoam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRoamAccount.mockReturnValue(defaultAccount());
  });

  it("fetches the remote URL, POSTs to /v1/item.upload with Content-Disposition, returns the itemId", async () => {
    mockLoadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("imgbytes"),
      contentType: "image/png",
    });
    mockFetchInner.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "item-abc", mime: "image/png" }),
    });

    const result = await uploadItemRoam("https://cdn.example.com/path/to/cat.png");

    expect(mockLoadWebMedia).toHaveBeenCalledWith(
      "https://cdn.example.com/path/to/cat.png",
      expect.objectContaining({ maxBytes: 10_000_000 }),
    );
    expect(mockFetchInner).toHaveBeenCalledOnce();
    const [url, opts] = mockFetchInner.mock.calls[0];
    expect(url).toBe("https://api.ro.am/v1/item.upload");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-api-key");
    expect(opts.headers["Content-Type"]).toBe("image/png");
    expect(opts.headers["Content-Disposition"]).toBe('attachment; filename="cat.png"');
    expect(result).toEqual({ itemId: "item-abc" });
  });

  it("accepts a local filesystem path (host runtime saves outbound media locally before sendMedia)", async () => {
    // The host runtime resolves outbound attachments to a local path under
    // `~/.openclaw/media/outbound/...` before calling `sendMedia`. The plugin
    // delegates to `loadWebMedia`, which the SDK guards against arbitrary
    // filesystem reads via `localRoots`.
    mockLoadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("imgbytes"),
      contentType: "image/png",
      fileName: "snapshot.png",
    });
    mockFetchInner.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "item-local" }),
    });

    const result = await uploadItemRoam(
      "/Users/test/.openclaw/media/outbound/abc---def.png",
    );

    expect(mockLoadWebMedia).toHaveBeenCalledWith(
      "/Users/test/.openclaw/media/outbound/abc---def.png",
      expect.objectContaining({
        maxBytes: 10_000_000,
        localRoots: ["/Users/test/.openclaw/media"],
      }),
    );
    expect(result).toEqual({ itemId: "item-local" });
    // Filename from loadWebMedia's metadata is preferred over the
    // path-derived fallback.
    const opts = mockFetchInner.mock.calls[0][1];
    expect(opts.headers["Content-Disposition"]).toBe('attachment; filename="snapshot.png"');
  });

  it("derives a filename from the content-type when the URL has no extension", async () => {
    mockLoadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("imgbytes"),
      contentType: "image/jpeg",
    });
    mockFetchInner.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "item-xyz" }),
    });

    await uploadItemRoam("https://cdn.example.com/items/12345");

    const opts = mockFetchInner.mock.calls[0][1];
    expect(opts.headers["Content-Disposition"]).toBe('attachment; filename="12345.jpg"');
  });

  it("rejects when item.upload returns no id", async () => {
    mockLoadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      contentType: "image/png",
    });
    mockFetchInner.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await expect(uploadItemRoam("https://cdn.example.com/x.png")).rejects.toThrow(
      /no item id/,
    );
  });

  it("rejects on HTTP error status", async () => {
    mockLoadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      contentType: "image/png",
    });
    mockFetchInner.mockResolvedValueOnce({
      ok: false,
      status: 413,
      text: async () => "too large",
    });

    await expect(uploadItemRoam("https://cdn.example.com/big.png")).rejects.toThrow(
      /item.upload failed \(413\)/,
    );
  });
});

describe("sendMessageRoam — items attachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRoamAccount.mockReturnValue(defaultAccount());
    mockFetchInner.mockResolvedValue({
      ok: true,
      json: async () => ({ chat: "chat-1", timestamp: 1000 }),
    });
  });

  it("passes items through to the chat.post body when provided", async () => {
    await sendMessageRoam("chat-1", "see attached", { items: ["item-1"] });
    const body = JSON.parse(mockFetchInner.mock.calls[0][1].body);
    expect(body.items).toEqual(["item-1"]);
  });

  it("allows an empty text body when items are present (real attachment, no caption)", async () => {
    // Caller may want to send just an image with no caption — previously
    // sendMessageRoam threw on empty text.
    await expect(
      sendMessageRoam("chat-1", "", { items: ["item-1"] }),
    ).resolves.toBeDefined();
  });
});
