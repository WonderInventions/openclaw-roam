import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROAM_DEFAULT_THROTTLE_MS,
  ROAM_MIN_INITIAL_CHARS,
  createRoamLiveMessageTrack,
  sliceByByteBudget,
} from "./streaming.js";

const sendMessageRoam = vi.fn();
const updateMessageRoam = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageRoam: (...args: unknown[]) => sendMessageRoam(...args),
  updateMessageRoam: (...args: unknown[]) => updateMessageRoam(...args),
}));

beforeEach(() => {
  sendMessageRoam.mockReset();
  updateMessageRoam.mockReset();
  // Default: send returns a timestamp; update succeeds.
  sendMessageRoam.mockResolvedValue({ chatId: "c1", timestamp: 100 });
  updateMessageRoam.mockResolvedValue({ chatId: "c1", timestamp: 100 });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Drain microtasks plus advance fake timers so a single throttled flush has
 * a chance to run. Repeated several times so chained microtasks (await
 * sendMessageRoam → set state → onActivity → finally) all complete before
 * the assertion.
 */
async function tickThrottle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(ROAM_DEFAULT_THROTTLE_MS);
  // Yield to microtasks so the flush() chain settles.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("sliceByByteBudget", () => {
  it("returns 0 for non-positive budgets", () => {
    expect(sliceByByteBudget("hello", 0)).toBe(0);
    expect(sliceByByteBudget("hello", -1)).toBe(0);
  });

  it("counts ASCII as one byte per char", () => {
    expect(sliceByByteBudget("hello", 5)).toBe(5);
    expect(sliceByByteBudget("hello world", 5)).toBe(5);
  });

  it("counts multi-byte UTF-8 codepoints by their byte length", () => {
    expect(sliceByByteBudget("éééé", 4)).toBe(2);
    expect(sliceByByteBudget("éééé", 3)).toBe(1);
  });

  it("never splits a surrogate pair", () => {
    const text = "😀😀";
    expect(sliceByByteBudget(text, 4)).toBe(2);
    expect(sliceByByteBudget(text, 3)).toBe(0);
  });
});

describe("createRoamLiveMessageTrack", () => {
  it("does not chat.post until the initial-char threshold is met", async () => {
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
    });

    // Under threshold: no send scheduled.
    await track.pushAccumulated("hi");
    await tickThrottle();
    expect(sendMessageRoam).not.toHaveBeenCalled();

    // Over threshold: schedules a send.
    await track.pushAccumulated("a".repeat(ROAM_MIN_INITIAL_CHARS));
    await tickThrottle();
    expect(sendMessageRoam).toHaveBeenCalledTimes(1);
    expect(sendMessageRoam.mock.calls[0][1]).toBe("a".repeat(ROAM_MIN_INITIAL_CHARS));
    expect(updateMessageRoam).not.toHaveBeenCalled();
  });

  it("debounces two pushes within the throttle window into one update", async () => {
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
    });

    await track.pushAccumulated("hello");
    await track.pushAccumulated("hello world");
    await tickThrottle();

    expect(sendMessageRoam).toHaveBeenCalledTimes(1);
    expect(sendMessageRoam.mock.calls[0][1]).toBe("hello world");
    expect(updateMessageRoam).not.toHaveBeenCalled();
  });

  it("issues chat.update for subsequent pushes after the first chat.post", async () => {
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
    });

    await track.pushAccumulated("hello");
    await tickThrottle();
    expect(sendMessageRoam).toHaveBeenCalledTimes(1);

    await track.pushAccumulated("hello world");
    await tickThrottle();
    expect(updateMessageRoam).toHaveBeenCalledTimes(1);
    expect(updateMessageRoam.mock.calls[0][1]).toBe(100); // timestamp from chat.post
    expect(updateMessageRoam.mock.calls[0][2]).toBe("hello world");
  });

  it("rotate() opens a fresh chat.post on the next push and resets committed length", async () => {
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
    });

    await track.pushAccumulated("first message");
    await tickThrottle();
    expect(sendMessageRoam).toHaveBeenCalledTimes(1);

    await track.rotate();
    expect(track.getCommittedLength()).toBe(0);

    await track.pushAccumulated("second message");
    await tickThrottle();
    expect(sendMessageRoam).toHaveBeenCalledTimes(2);
    expect(sendMessageRoam.mock.calls[1][1]).toBe("second message");
  });

  it("splits across two chat.post calls when the byte budget is exceeded", async () => {
    sendMessageRoam.mockResolvedValueOnce({ chatId: "c1", timestamp: 100 });
    sendMessageRoam.mockResolvedValueOnce({ chatId: "c1", timestamp: 200 });

    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
      messageByteBudget: 5,
    });

    // 8 ASCII chars → 8 bytes; budget is 5 so first 5 go to message #1 and the
    // remaining 3 spill into a fresh chat.post for message #2.
    await track.pushAccumulated("abcdefgh");
    await tickThrottle();
    // Loop may need extra microtasks for the suffix to land.
    await tickThrottle();

    expect(sendMessageRoam).toHaveBeenCalledTimes(2);
    expect(sendMessageRoam.mock.calls[0][1]).toBe("abcde");
    expect(sendMessageRoam.mock.calls[1][1]).toBe("fgh");
    expect(track.getCommittedLength()).toBe(5);
  });

  it("finalize(finalText) flushes synchronously and bypasses the initial-char threshold", async () => {
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
    });

    // Push a short text that wouldn't pass the threshold on its own.
    await track.pushAccumulated("hi");
    await tickThrottle();
    expect(sendMessageRoam).not.toHaveBeenCalled();

    // Finalize: should chat.post the short text immediately.
    await track.finalize("hi.");
    expect(sendMessageRoam).toHaveBeenCalledTimes(1);
    expect(sendMessageRoam.mock.calls[0][1]).toBe("hi.");
  });

  it("finalize() flushes the queued text after a chat.post via chat.update", async () => {
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
    });

    await track.pushAccumulated("hello");
    await tickThrottle();
    expect(sendMessageRoam).toHaveBeenCalledTimes(1);

    // Queue more text but call finalize before the throttle window opens.
    await track.pushAccumulated("hello world");
    await track.finalize();

    expect(updateMessageRoam).toHaveBeenCalledTimes(1);
    expect(updateMessageRoam.mock.calls[0][2]).toBe("hello world");
  });

  it("marks the track failed when chat.post throws and stops further sends", async () => {
    sendMessageRoam.mockRejectedValueOnce(new Error("boom"));

    const onError = vi.fn();
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
      onError,
    });

    await track.pushAccumulated("hello");
    await tickThrottle();

    expect(track.isFailed()).toBe(true);
    expect(onError).toHaveBeenCalled();

    // Subsequent pushes are no-ops.
    await track.pushAccumulated("hello world");
    await tickThrottle();
    expect(sendMessageRoam).toHaveBeenCalledTimes(1);
    expect(updateMessageRoam).not.toHaveBeenCalled();
  });

  it("marks the track failed when chat.update throws but preserves committed length", async () => {
    sendMessageRoam.mockResolvedValueOnce({ chatId: "c1", timestamp: 100 });
    sendMessageRoam.mockResolvedValueOnce({ chatId: "c1", timestamp: 200 });
    updateMessageRoam.mockRejectedValueOnce(new Error("update boom"));

    const onError = vi.fn();
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
      messageByteBudget: 5,
      onError,
    });

    // Force a byte-cap split so committedPrefixLength advances past 0 first.
    await track.pushAccumulated("abcdefgh");
    await tickThrottle();
    await tickThrottle();
    expect(track.getCommittedLength()).toBe(5);
    expect(track.isFailed()).toBe(false);

    // Now push more text to trigger an update on the second message; that
    // update will throw and mark the track failed.
    await track.pushAccumulated("abcdefghIJK");
    await tickThrottle();

    expect(track.isFailed()).toBe(true);
    // Committed length advances past every char Roam already accepted: 5 in
    // message #1 (the cap-split head) plus 3 in message #2 ("fgh" posted
    // before the failing update). The deliver fallback uses this to chat.post
    // only the unsent suffix instead of duplicating committed text.
    expect(track.getCommittedLength()).toBe(8);
    expect(onError).toHaveBeenCalled();
  });

  it("getCommittedLength is 0 when no byte-cap split has occurred", async () => {
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
    });

    await track.pushAccumulated("hello world");
    await tickThrottle();
    expect(track.getCommittedLength()).toBe(0);
  });

  it("calls onActivity on every successful send", async () => {
    const onActivity = vi.fn();
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
      onActivity,
    });

    await track.pushAccumulated("hello");
    await tickThrottle();
    expect(onActivity).toHaveBeenCalledTimes(1);

    await track.pushAccumulated("hello world");
    await tickThrottle();
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it("dedups identical accumulated text", async () => {
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
    });

    await track.pushAccumulated("hello world");
    await tickThrottle();
    expect(sendMessageRoam).toHaveBeenCalledTimes(1);

    await track.pushAccumulated("hello world");
    await tickThrottle();
    expect(updateMessageRoam).not.toHaveBeenCalled();
  });

  it("fails closed when a single grapheme exceeds the byte budget (cap-split stuck)", async () => {
    // 4-byte UTF-8 codepoint (😀) with a budget smaller than one full
    // codepoint. sliceByByteBudget returns 0 — the loop would otherwise
    // spin forever, so the track marks itself failed and surfaces the
    // reason via onError.
    const onError = vi.fn();
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
      messageByteBudget: 2,
      onError,
    });

    await track.pushAccumulated("😀");
    await tickThrottle();

    expect(sendMessageRoam).not.toHaveBeenCalled();
    expect(track.isFailed()).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("cap-split could not advance"),
    );
  });

  it("propagates failure when the second cap-split message fails", async () => {
    // First message succeeds, second message (the spillover) throws — the
    // track must mark failed and keep the committed length so the deliver
    // fallback only re-posts the unsent suffix.
    sendMessageRoam.mockResolvedValueOnce({ chatId: "c1", timestamp: 100 });
    sendMessageRoam.mockRejectedValueOnce(new Error("network error"));

    const onError = vi.fn();
    const track = createRoamLiveMessageTrack({
      chatId: "c1",
      accountId: "default",
      minInitialChars: 1,
      messageByteBudget: 5,
      onError,
    });

    await track.pushAccumulated("abcdefgh");
    await tickThrottle();
    await tickThrottle();

    expect(sendMessageRoam).toHaveBeenCalledTimes(2);
    expect(track.isFailed()).toBe(true);
    // First message's 5 chars committed; the failed second message resets
    // committed by the lastSentText length (0 since lastSentText was cleared
    // post-rotation). The first 5 stay committed.
    expect(track.getCommittedLength()).toBe(5);
    expect(onError).toHaveBeenCalled();
  });
});
