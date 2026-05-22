import { describe, expect, it } from "vitest";
import { RoamConfigSchema } from "./config-schema.js";

describe("RoamConfigSchema", () => {
  it("accepts apiBaseUrl", () => {
    const result = RoamConfigSchema.safeParse({ apiBaseUrl: "https://api.roam.dev" });
    expect(result.success).toBe(true);
  });

  it("accepts webhookUrl", () => {
    const result = RoamConfigSchema.safeParse({
      webhookUrl: "https://example.com/roam-webhook",
    });
    expect(result.success).toBe(true);
  });

  it("accepts both apiBaseUrl and webhookUrl together", () => {
    const result = RoamConfigSchema.safeParse({
      apiBaseUrl: "https://api.roam.dev",
      webhookUrl: "https://example.com/roam-webhook",
    });
    expect(result.success).toBe(true);
  });

  it("accepts streaming.nativeTransport", () => {
    const result = RoamConfigSchema.safeParse({
      streaming: { nativeTransport: true },
    });
    expect(result.success).toBe(true);
  });

  it("accepts per-group systemPrompt", () => {
    const result = RoamConfigSchema.safeParse({
      groups: {
        "01234567-abcd-4000-8000-000000000000": {
          systemPrompt: "Use the group-specific persona.",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields", () => {
    const result = RoamConfigSchema.safeParse({ bogusField: "nope" });
    expect(result.success).toBe(false);
  });

  it("defaults dmPolicy to 'open' (no opt-in needed for workspace DMs)", () => {
    const result = RoamConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dmPolicy).toBe("open");
    }
  });

  it("accepts dmPolicy='open' without requiring allowFrom: ['*']", () => {
    // Personal bots are owner-locked above this layer; org bots are
    // intentionally workspace-open by default. Removing the SDK's
    // requireChannelOpenAllowFrom guard is deliberate.
    const result = RoamConfigSchema.safeParse({ dmPolicy: "open" });
    expect(result.success).toBe(true);
  });

  it("still accepts dmPolicy='pairing' as opt-in", () => {
    const result = RoamConfigSchema.safeParse({ dmPolicy: "pairing" });
    expect(result.success).toBe(true);
  });

  it("defaults groupPolicy to 'open' for symmetry with dmPolicy", () => {
    const result = RoamConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groupPolicy).toBe("open");
    }
  });

  it("still accepts groupPolicy='allowlist' as opt-in", () => {
    const result = RoamConfigSchema.safeParse({ groupPolicy: "allowlist" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-HTTPS apiBaseUrl (would leak the bearer token)", () => {
    const result = RoamConfigSchema.safeParse({
      apiBaseUrl: "http://api.example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unparseable apiBaseUrl", () => {
    const result = RoamConfigSchema.safeParse({ apiBaseUrl: "not a url" });
    expect(result.success).toBe(false);
  });

  it("allows http://localhost (dev convenience)", () => {
    const result = RoamConfigSchema.safeParse({ apiBaseUrl: "http://localhost:8080" });
    expect(result.success).toBe(true);
  });

  it("allows http://127.0.0.1 (dev convenience)", () => {
    const result = RoamConfigSchema.safeParse({ apiBaseUrl: "http://127.0.0.1:8080" });
    expect(result.success).toBe(true);
  });
});
