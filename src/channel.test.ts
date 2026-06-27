import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendMessageRoam = vi.fn();
const mockUploadItemRoam = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageRoam: (...args: unknown[]) => mockSendMessageRoam(...args),
  uploadItemRoam: (...args: unknown[]) => mockUploadItemRoam(...args),
}));

import { coerceThreadTimestamp, sendMediaViaUpload } from "./channel.js";
import type { CoreConfig } from "./types.js";

describe("coerceThreadTimestamp", () => {
  // Roam indexes messages by exact µs-since-epoch. Anything that can't be
  // coerced to a positive finite number must become undefined — sending
  // `threadTimestamp: 0` or NaN previously caused 400s.

  it("returns undefined for null and undefined", () => {
    expect(coerceThreadTimestamp(null)).toBeUndefined();
    expect(coerceThreadTimestamp(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string (Number('') is 0, not a valid µs)", () => {
    expect(coerceThreadTimestamp("")).toBeUndefined();
  });

  it("returns undefined for non-numeric strings", () => {
    expect(coerceThreadTimestamp("abc")).toBeUndefined();
    expect(coerceThreadTimestamp("12abc")).toBeUndefined();
  });

  it("returns undefined for zero (both forms)", () => {
    expect(coerceThreadTimestamp(0)).toBeUndefined();
    expect(coerceThreadTimestamp("0")).toBeUndefined();
  });

  it("returns undefined for negative numbers", () => {
    expect(coerceThreadTimestamp(-1)).toBeUndefined();
    expect(coerceThreadTimestamp("-1000000")).toBeUndefined();
  });

  it("returns undefined for non-finite numbers", () => {
    expect(coerceThreadTimestamp(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(coerceThreadTimestamp(Number.NaN)).toBeUndefined();
  });

  it("returns the parsed µs value for positive finite inputs", () => {
    expect(coerceThreadTimestamp(1779380025366001)).toBe(1779380025366001);
    expect(coerceThreadTimestamp("1779380025366001")).toBe(1779380025366001);
  });
});

describe("sendMediaViaUpload", () => {
  const cfg: CoreConfig = {} as CoreConfig;

  beforeEach(() => {
    mockSendMessageRoam.mockReset();
    mockUploadItemRoam.mockReset();
    mockSendMessageRoam.mockResolvedValue({ chatId: "chat-1", timestamp: 100 });
    mockUploadItemRoam.mockResolvedValue({ itemId: "item-abc" });
  });

  it("uploads first, then chat.posts with the returned itemId", async () => {
    const result = await sendMediaViaUpload({
      cfg,
      to: "chat-1",
      text: "look at this",
      mediaUrl: "https://cdn.example.com/cat.png",
      accountId: "default",
      threadId: null,
    });

    expect(mockUploadItemRoam).toHaveBeenCalledOnce();
    expect(mockUploadItemRoam.mock.calls[0][0]).toBe("https://cdn.example.com/cat.png");

    expect(mockSendMessageRoam).toHaveBeenCalledOnce();
    const [chatId, text, sendOpts] = mockSendMessageRoam.mock.calls[0];
    expect(chatId).toBe("chat-1");
    expect(text).toBe("look at this");
    expect(sendOpts.items).toEqual(["item-abc"]);

    expect(result).toEqual({ messageId: "chat-1" });
  });

  it("calls upload before post (order matters — itemId from upload is required for post)", async () => {
    const callOrder: string[] = [];
    mockUploadItemRoam.mockImplementationOnce(async () => {
      callOrder.push("upload");
      return { itemId: "item-abc" };
    });
    mockSendMessageRoam.mockImplementationOnce(async () => {
      callOrder.push("post");
      return { chatId: "chat-1", timestamp: 100 };
    });

    await sendMediaViaUpload({
      cfg,
      to: "chat-1",
      text: "",
      mediaUrl: "https://cdn.example.com/cat.png",
      accountId: "default",
      threadId: null,
    });

    expect(callOrder).toEqual(["upload", "post"]);
  });

  it("forwards threadId through coerceThreadTimestamp to both upload and post", async () => {
    await sendMediaViaUpload({
      cfg,
      to: "chat-1",
      text: "hi",
      mediaUrl: "https://cdn.example.com/cat.png",
      accountId: "org",
      threadId: 1779380025366001,
    });

    const uploadOpts = mockUploadItemRoam.mock.calls[0][1];
    expect(uploadOpts.threadTimestamp).toBe(1779380025366001);
    expect(uploadOpts.accountId).toBe("org");

    const postOpts = mockSendMessageRoam.mock.calls[0][2];
    expect(postOpts.threadTimestamp).toBe(1779380025366001);
    expect(postOpts.items).toEqual(["item-abc"]);
  });

  it("falls back to plain chat.post when mediaUrl is null", async () => {
    await sendMediaViaUpload({
      cfg,
      to: "chat-1",
      text: "just text",
      mediaUrl: null,
      accountId: "default",
      threadId: null,
    });

    expect(mockUploadItemRoam).not.toHaveBeenCalled();
    expect(mockSendMessageRoam).toHaveBeenCalledOnce();
    const sendOpts = mockSendMessageRoam.mock.calls[0][2];
    expect(sendOpts.items).toBeUndefined();
  });

  it("propagates upload failures (no fallback to plain post)", async () => {
    mockUploadItemRoam.mockRejectedValueOnce(new Error("upload exploded"));
    await expect(
      sendMediaViaUpload({
        cfg,
        to: "chat-1",
        text: "look",
        mediaUrl: "https://cdn.example.com/cat.png",
        accountId: "default",
        threadId: null,
      }),
    ).rejects.toThrow("upload exploded");
    // Critically: we did NOT silently fall back to chat.post on upload
    // failure. The agent learns about the failure rather than producing
    // a message that looks like it has an attachment but doesn't.
    expect(mockSendMessageRoam).not.toHaveBeenCalled();
  });
});
