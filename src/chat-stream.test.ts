import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROAM_NATIVE_STREAM_MIN_INITIAL_CHARS,
  createRoamAnswerStreamTrack,
  createRoamThinkingStreamTrack,
} from "./chat-stream.js";

type CapturedRequest = {
  url: string;
  auditContext?: string;
  body: Record<string, unknown>;
};

const captured: CapturedRequest[] = [];
let nextResponses: Array<{ status?: number; json?: Record<string, unknown> }> = [];

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(
    async (opts: {
      url: string;
      init: RequestInit & { body?: string };
      auditContext?: string;
    }) => {
      const body = JSON.parse(opts.init.body ?? "{}") as Record<string, unknown>;
      captured.push({ url: opts.url, auditContext: opts.auditContext, body });

      const next = nextResponses.shift() ?? {};
      return {
        response: new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200 }),
        release: async () => {},
      };
    },
  ),
}));

vi.mock("./accounts.js", () => ({
  resolveRoamAccount: () => ({
    accountId: "default",
    apiKey: "test-api-key",
    config: {},
  }),
}));

vi.mock("./api-base.js", async () => {
  const actual = await vi.importActual("./api-base.js");
  return {
    ...(actual as object),
    resolveApiBase: () => "http://127.0.0.1:18789/v1",
  };
});

vi.mock("./runtime.js", () => ({
  getRoamRuntime: () => ({
    logging: {
      getChildLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    },
    config: { loadConfig: () => ({}) },
  }),
}));

beforeEach(() => {
  captured.length = 0;
  nextResponses = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushTimers(): Promise<void> {
  await vi.runOnlyPendingTimersAsync();
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("Roam native chat streams", () => {
  it("uses start/append/stop for answer streams", async () => {
    nextResponses.push(
      { json: { streamId: "stream-1", chatId: "chat-1" } }, // startStream
      { json: { streamId: "stream-1", chatId: "chat-1" } }, // appendStream (initial text)
      { json: { streamId: "stream-1", chatId: "chat-1" } }, // appendStream (next snapshot)
      { json: { streamId: "stream-1", chatId: "chat-1", timestamp: 1234 } }, // stopStream
    );

    const track = createRoamAnswerStreamTrack({
      chatId: "chat-1",
      accountId: "default",
      throttleMs: 1,
    });

    const snapshot1 = "a".repeat(ROAM_NATIVE_STREAM_MIN_INITIAL_CHARS);
    const snapshot2 = snapshot1 + "b".repeat(5);
    await track.pushAccumulated(snapshot1);
    await flushTimers();
    await track.pushAccumulated(snapshot2);
    await flushTimers();
    await track.finalize();

    expect(captured).toHaveLength(4);
    expect(captured[0]).toMatchObject({
      url: "http://127.0.0.1:18789/v1/chat.startStream",
      auditContext: "roam-chat-start-stream-text",
    });
    expect(captured[0].body).toEqual({ chatId: "chat-1", kind: "text" });
    expect(captured[1]).toMatchObject({
      url: "http://127.0.0.1:18789/v1/chat.appendStream",
      auditContext: "roam-chat-append-stream-text",
    });
    // Each append sends the FULL snapshot with snapshot:true so the server
    // replaces (rather than appends) the content. This is robust against
    // non-monotonic updates from the agent runtime.
    expect(captured[1].body).toEqual({
      streamId: "stream-1",
      text: snapshot1,
      snapshot: true,
    });
    expect(captured[2]).toMatchObject({
      url: "http://127.0.0.1:18789/v1/chat.appendStream",
    });
    expect(captured[2].body).toEqual({
      streamId: "stream-1",
      text: snapshot2,
      snapshot: true,
    });
    expect(captured[3]).toMatchObject({
      url: "http://127.0.0.1:18789/v1/chat.stopStream",
      auditContext: "roam-chat-stop-stream-text",
    });
    // stop sends only {streamId}: appendStream with snapshot:true already
    // committed the final content; stopStream.text would APPEND a duplicate.
    expect(captured[3].body).toEqual({ streamId: "stream-1" });
  });

  it("emits kind=thinking for the thinking lane", async () => {
    nextResponses.push(
      { json: { streamId: "stream-2", chatId: "chat-2" } }, // start
      { json: { streamId: "stream-2", chatId: "chat-2" } }, // append (initial)
      { json: { streamId: "stream-2", chatId: "chat-2", timestamp: 222 } }, // stop
    );

    const track = createRoamThinkingStreamTrack({
      chatId: "chat-2",
      accountId: "default",
      minInitialChars: 1,
      throttleMs: 1,
    });

    await track.pushAccumulated("reasoning");
    await flushTimers();
    await track.finalize();

    expect(captured[0].body).toEqual({ chatId: "chat-2", kind: "thinking" });
    expect(captured[1].url).toBe("http://127.0.0.1:18789/v1/chat.appendStream");
    expect(captured[1].body).toEqual({
      streamId: "stream-2",
      text: "reasoning",
      snapshot: true,
    });
    expect(captured[2].url).toBe("http://127.0.0.1:18789/v1/chat.stopStream");
  });

  it("marks the track failed when the server rejects a native stream call", async () => {
    nextResponses.push({ status: 500, json: { error: "boom" } });
    const onError = vi.fn();
    const track = createRoamAnswerStreamTrack({
      chatId: "chat-1",
      accountId: "default",
      minInitialChars: 1,
      throttleMs: 1,
      onError,
    });

    await track.pushAccumulated("hello");
    await flushTimers();

    expect(track.isFailed()).toBe(true);
    expect(onError).toHaveBeenCalled();
  });
});
