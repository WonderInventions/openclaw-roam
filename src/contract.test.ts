/**
 * Shared-fixture contract tests.
 *
 * Each JSON fixture under `testdata/openclaw-fixtures/` pins one half of the
 * Roam ↔ openclaw-roam plugin contract: the inbound webhook payload Roam
 * delivers, and the API calls the plugin must make in response. The wonder
 * repo runs the same fixtures against a live Roam appserver
 * (e2e_openclaw_webhook_contract_test.go); this test runs them in-process
 * against the plugin. Same JSON, opposite directions.
 *
 * Strategy: mock the HTTP transport (`fetchWithSsrFGuard`) so every outbound
 * request the plugin makes is captured; mock `dispatchInboundReplyWithBase`
 * to invoke `deliver({ text: ... })` synchronously (the agent runtime isn't
 * available in unit tests). The real `sendMessageRoam` / `sendTypingRoam` /
 * `fetchRoamChatHistory` code paths execute, so the captured HTTP shape is
 * exactly what the plugin would send in production.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedRoamAccount } from "./accounts.js";
import { handleRoamInbound } from "./inbound.js";
import { webhookEventToInbound } from "./monitor.js";
import type { CoreConfig, RoamInboundMessage, RoamWebhookEvent } from "./types.js";

// --- Captured-call shape -------------------------------------------------

type CapturedCall = {
  method: string;
  urlPath: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

// --- Hoisted mocks -------------------------------------------------------

const {
  captured,
  mockFetchWithSsrFGuard,
  mockDispatchInboundReplyWithBase,
  mockFetchRemoteMedia,
  mockSaveMediaBuffer,
} = vi.hoisted(() => ({
  captured: [] as CapturedCall[],
  mockFetchWithSsrFGuard: vi.fn(),
  mockDispatchInboundReplyWithBase: vi.fn(),
  mockFetchRemoteMedia: vi.fn(),
  mockSaveMediaBuffer: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mockFetchWithSsrFGuard,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 20 * 1024 * 1024,
  fetchRemoteMedia: mockFetchRemoteMedia,
  saveMediaBuffer: mockSaveMediaBuffer,
}));

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    dispatchInboundReplyWithBase: mockDispatchInboundReplyWithBase,
    // The contract is "what the plugin sends to Roam". Access gating is
    // exercised in inbound.test.ts; here, allow every inbound through so the
    // remaining drop logic (self-message, empty body, group allowlist,
    // mention gate) decides on its own.
    resolveDmGroupAccessWithCommandGate: vi.fn(() => ({
      decision: "allow",
      reason: "open",
      commandAuthorized: true,
      shouldBlockControlCommand: false,
      effectiveGroupAllowFrom: undefined,
    })),
    resolveAllowlistProviderRuntimeGroupPolicy: vi.fn(() => ({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    })),
    resolveDefaultGroupPolicy: vi.fn(() => "open"),
    readStoreAllowFromForDmPolicy: vi.fn().mockResolvedValue([]),
  };
});

// Runtime core mock — same shape as inbound.test.ts; reproduced locally so
// this test file is self-contained.
const runtimeCore = {
  channel: {
    activity: { record: vi.fn() },
    session: {
      recordInboundSession: vi.fn().mockResolvedValue(undefined),
      resolveStorePath: vi.fn(() => "/tmp/store"),
      readSessionUpdatedAt: vi.fn(() => undefined),
    },
    routing: {
      resolveAgentRoute: vi.fn(() => ({
        agentId: "default",
        sessionKey: "roam:test:session",
        accountId: "default",
      })),
    },
    reply: {
      resolveEnvelopeFormatOptions: vi.fn(() => ({})),
      formatAgentEnvelope: vi.fn((p: { body: string }) => p.body),
      finalizeInboundContext: vi.fn((p: Record<string, unknown>) => p),
      dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue(undefined),
    },
    commands: { shouldHandleTextCommands: vi.fn(() => true) },
    text: {
      hasControlCommand: vi.fn(() => false),
      chunkMarkdownText: vi.fn((text: string) => [text]),
      resolveMarkdownTableMode: vi.fn(() => "preserve"),
      convertMarkdownTables: vi.fn((text: string) => text),
    },
    mentions: {
      buildMentionRegexes: vi.fn(() => []),
      matchesMentionPatterns: vi.fn(() => false),
    },
  },
  logging: {
    getChildLogger: vi.fn(() => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    })),
  },
  config: { loadConfig: vi.fn(() => ({})) },
};

vi.mock("./runtime.js", () => ({
  getRoamRuntime: () => runtimeCore,
}));

// `resolveRoamAccount` is consulted by `sendMessageRoam` / `sendTypingRoam`
// when the caller didn't pre-thread the credentials. Our handler does pass
// `accountId`, so the only thing this needs to return is a record with the
// right apiKey + apiBaseUrl.
vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    resolveRoamAccount: vi.fn(({ cfg }) => ({
      accountId: "default",
      enabled: true,
      apiKey: "test-api-key",
      apiKeySource: "config" as const,
      config: (cfg as CoreConfig).channels?.roam ?? {},
    })),
  };
});

// --- Fixture types -------------------------------------------------------

type FixtureExpectedCall = {
  name?: string;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  verifyOnThread?: boolean;
};

type Fixture = {
  name: string;
  summary?: string;
  setup: {
    actor: "alice" | "owner" | "bot";
    chatType: "dm" | "group";
    groupName?: string;
    botIsMember?: boolean;
    thread?: { parentActor: string; parentText: string };
    trigger: { text: string; inThread?: boolean; withItem?: string };
  };
  webhook: { expectMissing?: boolean; body?: Record<string, unknown> };
  expectedApiCalls: FixtureExpectedCall[];
};

// --- Placeholders --------------------------------------------------------

type Placeholders = {
  "alice.addrId": string;
  "owner.addrId": string;
  "bot.addrId": string;
  "other.addrId": string;
  "chat.id": string;
  "thread.parentTs": number;
  "item.id": string;
  "suffix": string;
};

const STABLE_IDS = {
  "alice.addrId": "00000000-0000-4000-8000-00000000a11c",
  "owner.addrId": "00000000-0000-4000-8000-00000000079e",
  "bot.addrId": "00000000-0000-4000-8000-0000000000b0",
  "other.addrId": "00000000-0000-4000-8000-00000000071e",
} as const;

// Microsecond timestamp safely below 2^53.
const FIXED_THREAD_PARENT_TS = 1700000000000001;

function buildPlaceholders(fixtureName: string): Placeholders {
  return {
    ...STABLE_IDS,
    "chat.id": `chat-${fixtureName}`,
    "thread.parentTs": FIXED_THREAD_PARENT_TS,
    "item.id": `item-${fixtureName}`,
    "suffix": "x",
  };
}

// Walk a JSON-shaped value and replace whole-string `<token>` literals plus
// inline `<token>` substrings. Unknown tokens are left untouched (matchers
// stay as-is for the assertion side to interpret).
function resolveTokens(value: unknown, ph: Placeholders): unknown {
  if (typeof value === "string") {
    return value.replace(/<([a-zA-Z][a-zA-Z0-9._:-]*)>/g, (match, token) => {
      if (token in ph) {
        const v = (ph as Record<string, unknown>)[token];
        return typeof v === "number" ? String(v) : String(v);
      }
      return match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTokens(v, ph));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTokens(v, ph);
    }
    return out;
  }
  return value;
}

// Same as `resolveTokens` but applied with type-preserving semantics for
// numeric placeholders: a whole-string `<thread.parentTs>` becomes a number,
// not a string. Used when constructing the webhook event so the
// `threadTimestamp` field arrives as a number.
function resolveValue(value: unknown, ph: Placeholders): unknown {
  if (typeof value === "string") {
    const m = /^<([a-zA-Z][a-zA-Z0-9._:-]*)>$/.exec(value);
    if (m && m[1] in ph) {
      return (ph as Record<string, unknown>)[m[1]];
    }
    return resolveTokens(value, ph);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, ph));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, ph);
    }
    return out;
  }
  return value;
}

// Concretize matcher placeholders inside the WEBHOOK BODY: when a fixture
// declares `text: "<assertText:contains:foo>"`, the synthesized inbound text
// must contain "foo" — we substitute `"foo " + suffix`.
function concretizeWebhookText(
  bodyValue: unknown,
  ph: Placeholders,
): unknown {
  if (typeof bodyValue === "string") {
    if (bodyValue === "<assertText:nonEmpty>") return `marker-${ph.suffix}`;
    const contains = /^<assertText:contains:(.+)>$/.exec(bodyValue);
    if (contains) return `${contains[1]} marker-${ph.suffix}`;
    if (bodyValue === "<assertItems:nonEmpty>") {
      // Replaced separately for items array; leave a sentinel here.
      return bodyValue;
    }
    return resolveTokens(bodyValue, ph);
  }
  return resolveValue(bodyValue, ph);
}

// --- Fixture loader ------------------------------------------------------

function loadFixtures(): Fixture[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = pathResolve(here, "..", "testdata", "openclaw-fixtures");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((f) => JSON.parse(readFileSync(pathResolve(dir, f), "utf8")) as Fixture);
}

// --- Per-fixture construction -------------------------------------------

function buildWebhookEvent(fixture: Fixture, ph: Placeholders): RoamWebhookEvent {
  const raw = (fixture.webhook.body ?? {}) as Record<string, unknown>;
  const resolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "timestamp" && v === "<gen.now>") {
      // Microsecond precision per APIMessageWebhookV1.
      resolved[k] = Date.now() * 1000;
      continue;
    }
    if (k === "items" && v === "<assertItems:nonEmpty>") {
      resolved[k] = [
        {
          id: ph["item.id"],
          type: "image",
          mime: "image/png",
          url: "https://test.invalid/img.png",
        },
      ];
      continue;
    }
    if (k === "text") {
      // `webhook.body.text` is the assertion the WONDER side runs against the
      // captured webhook (typically `<assertText:contains:…>`). It does NOT
      // describe what Roam actually puts in the text — Roam delivers what the
      // sender typed verbatim, including any `<@bot>` mention tag. Synthesize
      // the text from `setup.trigger.text` so the plugin's mention detector
      // sees the real shape; the resulting string also satisfies the
      // contains-matcher by construction.
      const triggerText = fixture.setup.trigger.text;
      resolved[k] = `${resolveTokens(triggerText, ph)} marker-${ph.suffix}`;
      continue;
    }
    resolved[k] = resolveValue(v, ph);
  }
  return resolved as unknown as RoamWebhookEvent;
}

function buildInbound(fixture: Fixture, ph: Placeholders): RoamInboundMessage {
  // 06_bot_self_message_echo has `webhook.expectMissing: true` — no body —
  // but the plugin's defense-in-depth check (sender == bot) should still
  // drop. Synthesize a minimal inbound where senderId == bot.addrId.
  if (fixture.webhook.expectMissing) {
    return {
      messageId: "self-echo-msg",
      chatId: ph["chat.id"],
      senderId: ph["bot.addrId"],
      senderName: "",
      text: "bot-initiated note",
      timestamp: Date.now(),
      chatType: "direct",
    };
  }
  return webhookEventToInbound(buildWebhookEvent(fixture, ph));
}

function buildAccount(fixture: Fixture, ph: Placeholders): ResolvedRoamAccount {
  const groups: Record<string, { requireMention?: boolean }> = {};
  switch (fixture.name) {
    case "group_mention_top_level":
    case "group_mention_threaded":
    case "media_attachment":
    case "group_no_mention":
      groups[ph["chat.id"]] = { requireMention: true };
      break;
    case "group_not_allowlisted":
      // Allowlist a different chat so the inbound chat.id is NOT matched.
      groups["chat-some-other-allowlisted-chat"] = {};
      break;
    default:
      break;
  }
  return {
    accountId: "default",
    enabled: true,
    apiKey: "test-api-key",
    apiKeySource: "config",
    config: {
      dmPolicy: "open",
      historyLimit: 20,
      streaming: { mode: "off" },
      groups: Object.keys(groups).length > 0 ? groups : undefined,
    },
  };
}

function buildConfig(fixture: Fixture, ph: Placeholders): CoreConfig {
  // Mirror buildAccount so the few helpers that read from `cfg.channels.roam`
  // see the same shape. The contract test doesn't exercise multi-account
  // resolution.
  return {
    channels: {
      roam: buildAccount(fixture, ph).config,
    },
  } as CoreConfig;
}

// --- HTTP capture --------------------------------------------------------

function installCapturingFetch(): void {
  mockFetchWithSsrFGuard.mockImplementation(async (params: { url: string; init?: RequestInit }) => {
    const url = new URL(params.url);
    const method = (params.init?.method ?? "GET").toUpperCase();
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    let body: Record<string, unknown> | undefined;
    if (typeof params.init?.body === "string") {
      try {
        body = JSON.parse(params.init.body) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }
    captured.push({ method, urlPath: url.pathname, query, body });

    // Canned response per endpoint.
    let response: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
    if (url.pathname.endsWith("/chat.post")) {
      response = {
        ok: true,
        status: 200,
        json: async () => ({ chat: body?.chatId ?? "", timestamp: Date.now() * 1000 }),
        text: async () => "",
      };
    } else if (url.pathname.endsWith("/chat.history")) {
      response = {
        ok: true,
        status: 200,
        json: async () => ({ messages: [] }),
        text: async () => "",
      };
    } else {
      response = {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      };
    }
    return { response, finalUrl: params.url, release: vi.fn() };
  });
}

// --- Expected-calls assertion -------------------------------------------

function matchesValue(expected: unknown, actual: unknown, ph: Placeholders): boolean {
  // Matcher placeholders are interpreted here.
  if (typeof expected === "string") {
    if (expected === "<assertText:nonEmpty>") {
      return typeof actual === "string" && actual.length > 0;
    }
    const contains = /^<assertText:contains:(.+)>$/.exec(expected);
    if (contains) {
      return typeof actual === "string" && actual.includes(contains[1]);
    }
    if (expected === "<assertItems:nonEmpty>") {
      return Array.isArray(actual) && actual.length > 0;
    }
    const m = /^<([a-zA-Z][a-zA-Z0-9._:-]*)>$/.exec(expected);
    if (m && m[1] in ph) {
      const v = (ph as Record<string, unknown>)[m[1]];
      // Allow string/number cross-coercion for numeric placeholders inside
      // query strings (which are always strings on the wire).
      if (typeof v === "number" && typeof actual === "string") {
        return String(v) === actual;
      }
      return v === actual;
    }
    return resolveTokens(expected, ph) === actual;
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    for (const [k, ev] of Object.entries(expected as Record<string, unknown>)) {
      if (!matchesValue(ev, (actual as Record<string, unknown>)[k], ph)) {
        return false;
      }
    }
    return true;
  }
  return expected === actual;
}

function assertExpectedCallsMatch(
  captured: CapturedCall[],
  expected: FixtureExpectedCall[],
  ph: Placeholders,
): void {
  // Empty contract: no calls allowed.
  if (expected.length === 0) {
    expect(captured, `expected zero API calls, got ${captured.length}`).toEqual([]);
    return;
  }

  let cursor = 0;
  for (const exp of expected) {
    const expPath = resolveTokens(exp.path, ph) as string;
    // Find next captured call with matching method+path starting at cursor.
    let foundIdx = -1;
    for (let i = cursor; i < captured.length; i++) {
      if (captured[i].method === exp.method && captured[i].urlPath === expPath) {
        foundIdx = i;
        break;
      }
    }
    if (foundIdx === -1) {
      const tail = captured.slice(cursor).map((c) => `${c.method} ${c.urlPath}`);
      throw new Error(
        `expected ${exp.method} ${expPath} (${exp.name ?? ""}) but did not find it past cursor=${cursor}. Remaining captured: [${tail.join(", ")}]`,
      );
    }
    const actual = captured[foundIdx];

    if (exp.body) {
      for (const [k, ev] of Object.entries(exp.body)) {
        const av = actual.body?.[k];
        if (!matchesValue(ev, av, ph)) {
          throw new Error(
            `${exp.method} ${expPath} body.${k}: expected ${JSON.stringify(ev)}, got ${JSON.stringify(av)}`,
          );
        }
      }
    }
    if (exp.query) {
      for (const [k, ev] of Object.entries(exp.query)) {
        const av = actual.query[k];
        if (!matchesValue(ev, av, ph)) {
          throw new Error(
            `${exp.method} ${expPath} query.${k}: expected ${JSON.stringify(ev)}, got ${JSON.stringify(av)}`,
          );
        }
      }
    }

    cursor = foundIdx + 1;
  }

  // No trailing extra calls past the last matched one.
  if (cursor < captured.length) {
    const extra = captured.slice(cursor).map((c) => `${c.method} ${c.urlPath}`);
    throw new Error(`unexpected extra API calls after the expected list: [${extra.join(", ")}]`);
  }
}

// --- Run the fixtures ----------------------------------------------------

const fixtures = loadFixtures();

describe.each(fixtures)("openclaw contract: $name", (fixture: Fixture) => {
  beforeEach(() => {
    captured.length = 0;
    mockFetchWithSsrFGuard.mockReset();
    installCapturingFetch();
    mockDispatchInboundReplyWithBase.mockReset();
    mockDispatchInboundReplyWithBase.mockImplementation(
      async (params: { deliver: (payload: { text?: string }) => Promise<void> }) => {
        await params.deliver({ text: `openclaw reply ${fixture.name}` });
      },
    );
    mockFetchRemoteMedia.mockReset();
    mockFetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
    });
    mockSaveMediaBuffer.mockReset();
    mockSaveMediaBuffer.mockResolvedValue({ path: "/tmp/test-img.png" });
  });

  it("emits exactly the expected API calls", async () => {
    const ph = buildPlaceholders(fixture.name);
    const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await handleRoamInbound({
      message: buildInbound(fixture, ph),
      account: buildAccount(fixture, ph),
      config: buildConfig(fixture, ph),
      runtime,
      botId: ph["bot.addrId"],
    });
    assertExpectedCallsMatch(captured, fixture.expectedApiCalls, ph);
  });
});
