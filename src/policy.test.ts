import { describe, expect, it } from "vitest";
import {
  normalizeRoamAllowlist,
  resolveRoamAllowlistMatch,
  resolveRoamGroupSystemPrompt,
  resolveRoamReplyInThread,
} from "./policy.js";

describe("normalizeRoamAllowlist", () => {
  it("strips roam: prefix", () => {
    expect(normalizeRoamAllowlist(["roam:abc"])).toEqual(["abc"]);
  });

  it("strips roam-hq: prefix", () => {
    expect(normalizeRoamAllowlist(["roam-hq:abc"])).toEqual(["abc"]);
  });

  it("lowercases entries", () => {
    expect(normalizeRoamAllowlist(["ABC"])).toEqual(["abc"]);
  });

  it("handles empty input", () => {
    expect(normalizeRoamAllowlist(undefined)).toEqual([]);
  });
});

describe("resolveRoamAllowlistMatch", () => {
  it("matches bare UUID sender against allowFrom", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: ["01234567-abcd-4000-8000-000000000000"],
      senderId: "01234567-abcd-4000-8000-000000000000",
    });
    expect(result.allowed).toBe(true);
  });

  it("matches with roam: prefix in allowFrom", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: ["roam:01234567-abcd-4000-8000-000000000000"],
      senderId: "01234567-abcd-4000-8000-000000000000",
    });
    expect(result.allowed).toBe(true);
  });

  it("matches wildcard", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: ["*"],
      senderId: "anything",
    });
    expect(result.allowed).toBe(true);
    expect(result.matchSource).toBe("wildcard");
  });

  it("rejects unmatched sender", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: ["allowed-user"],
      senderId: "different-user",
    });
    expect(result.allowed).toBe(false);
  });

  it("returns not-allowed for empty allowFrom", () => {
    const result = resolveRoamAllowlistMatch({
      allowFrom: [],
      senderId: "any",
    });
    expect(result.allowed).toBe(false);
  });
});

describe("resolveRoamGroupSystemPrompt", () => {
  it("returns a trimmed direct group prompt", () => {
    expect(
      resolveRoamGroupSystemPrompt({
        groupConfig: { systemPrompt: "  Use concise answers.  " },
      }),
    ).toBe("Use concise answers.");
  });

  it("falls back to wildcard prompt", () => {
    expect(
      resolveRoamGroupSystemPrompt({
        wildcardConfig: { systemPrompt: "Use the shared group persona." },
      }),
    ).toBe("Use the shared group persona.");
  });

  it("prefers direct prompt over wildcard prompt", () => {
    expect(
      resolveRoamGroupSystemPrompt({
        groupConfig: { systemPrompt: "Use direct group instructions." },
        wildcardConfig: { systemPrompt: "Use wildcard instructions." },
      }),
    ).toBe("Use direct group instructions.");
  });

  it("treats blank direct prompt as unset and uses wildcard prompt", () => {
    expect(
      resolveRoamGroupSystemPrompt({
        groupConfig: { systemPrompt: "   " },
        wildcardConfig: { systemPrompt: "Use wildcard instructions." },
      }),
    ).toBe("Use wildcard instructions.");
  });

  it("returns undefined when all prompts are blank or missing", () => {
    expect(
      resolveRoamGroupSystemPrompt({
        groupConfig: { systemPrompt: "   " },
        wildcardConfig: { systemPrompt: "" },
      }),
    ).toBeUndefined();
  });
});

describe("resolveRoamReplyInThread", () => {
  // Smart default: proactive bots (requireMention: false) need threading;
  // mention-only bots reply at top level. Explicit settings always win.

  it("defaults to true when proactive (requireMention: false)", () => {
    expect(resolveRoamReplyInThread({ groupConfig: { requireMention: false } })).toBe(
      true,
    );
  });

  it("defaults to false when mention-only (no requireMention override = true)", () => {
    expect(resolveRoamReplyInThread({})).toBe(false);
  });

  it("explicit groupConfig.replyInThread overrides the smart default", () => {
    expect(
      resolveRoamReplyInThread({
        groupConfig: { requireMention: false, replyInThread: false },
      }),
    ).toBe(false);
    expect(
      resolveRoamReplyInThread({
        groupConfig: { requireMention: true, replyInThread: true },
      }),
    ).toBe(true);
  });

  it("inherits requireMention from wildcardConfig for the smart default", () => {
    expect(
      resolveRoamReplyInThread({ wildcardConfig: { requireMention: false } }),
    ).toBe(true);
  });
});
