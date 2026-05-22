import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedRoamAccount } from "./accounts.js";
import { __resetNotAllowlistedNoticeForTests, handleRoamInbound } from "./inbound.js";
import type { CoreConfig, RoamInboundMessage } from "./types.js";

// --- Hoisted mocks ---

const {
  mockSendMessageRoam,
  mockSendTypingRoam,
  mockFetchRemoteMedia,
  mockSaveMediaBuffer,
  mockCreateRoamAnswerStreamTrack,
  mockCreateRoamLiveMessageTrack,
  mockLiveMessageTrack,
  mockDispatchInboundReplyWithBase,
  mockCreateChannelPairingController,
  mockDeliverFormattedTextWithAttachments,
  mockReadStoreAllowFrom,
  mockLogInboundDrop,
  mockLogTypingFailure,
  mockResolveDmGroupAccessWithCommandGate,
  mockResolveAllowlistProviderRuntimeGroupPolicy,
  mockWarnMissingProviderGroupPolicyFallbackOnce,
  mockResolveRoamGroupSystemPrompt,
  mockFetchRoamChatHistory,
  mockResolveRoamGroupMatch,
} = vi.hoisted(() => ({
  mockSendMessageRoam: vi.fn().mockResolvedValue({ chatId: "chat-1", timestamp: 1000 }),
  mockSendTypingRoam: vi.fn().mockResolvedValue(undefined),
  mockFetchRemoteMedia: vi.fn(),
  mockSaveMediaBuffer: vi.fn(),
  mockCreateRoamAnswerStreamTrack: vi.fn(),
  mockLiveMessageTrack: {
    pushAccumulated: vi.fn().mockResolvedValue(undefined),
    rotate: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
    isFailed: vi.fn(() => false),
    getCommittedLength: vi.fn(() => 0),
  },
  mockCreateRoamLiveMessageTrack: vi.fn(),
  mockDispatchInboundReplyWithBase: vi.fn().mockResolvedValue(undefined),
  mockCreateChannelPairingController: vi.fn(),
  mockDeliverFormattedTextWithAttachments: vi.fn().mockResolvedValue(undefined),
  mockReadStoreAllowFrom: vi.fn().mockResolvedValue([]),
  mockLogInboundDrop: vi.fn(),
  mockLogTypingFailure: vi.fn(),
  mockResolveDmGroupAccessWithCommandGate: vi.fn(() => ({
    decision: "allow",
    reason: "open",
    commandAuthorized: true,
    shouldBlockControlCommand: false,
    effectiveGroupAllowFrom: undefined,
  })),
  mockResolveAllowlistProviderRuntimeGroupPolicy: vi.fn(() => ({
    groupPolicy: "open",
    providerMissingFallbackApplied: false,
  })),
  mockWarnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
  mockResolveRoamGroupSystemPrompt: vi.fn<() => string | undefined>(() => undefined),
  mockFetchRoamChatHistory: vi.fn().mockResolvedValue([]),
  mockResolveRoamGroupMatch: vi.fn(() => ({
    groupConfig: undefined,
    wildcardConfig: undefined,
    groupKey: undefined,
    matchSource: undefined,
    allowed: true,
    allowlistConfigured: false,
  })),
}));

mockCreateRoamLiveMessageTrack.mockImplementation(() => mockLiveMessageTrack);
mockCreateRoamAnswerStreamTrack.mockImplementation(() => mockLiveMessageTrack);

vi.mock("./send.js", () => ({
  sendMessageRoam: mockSendMessageRoam,
  sendTypingRoam: mockSendTypingRoam,
}));

// Stub chat.history so DM/thread history fetches don't reach the network.
// Per-test bodies override as needed via mockFetchRoamChatHistory.
vi.mock("./history.js", () => ({
  fetchRoamChatHistory: mockFetchRoamChatHistory,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 20 * 1024 * 1024,
  fetchRemoteMedia: mockFetchRemoteMedia,
  saveMediaBuffer: mockSaveMediaBuffer,
}));

vi.mock("./streaming.js", async () => {
  const actual = await vi.importActual("./streaming.js");
  return {
    ...(actual as object),
    createRoamLiveMessageTrack: mockCreateRoamLiveMessageTrack,
  };
});

vi.mock("./chat-stream.js", async () => {
  const actual = await vi.importActual("./chat-stream.js");
  return {
    ...(actual as object),
    createRoamAnswerStreamTrack: mockCreateRoamAnswerStreamTrack,
    createRoamThinkingStreamTrack: vi.fn(),
  };
});

// --- Runtime mock ---

const mockActivityRecord = vi.fn();
const mockResolveAgentRoute = vi.fn(() => ({
  agentId: "default",
  sessionKey: "roam:test:session",
  accountId: "default",
}));

const mockShouldHandleTextCommands = vi.fn(() => true);
const mockHasControlCommand = vi.fn(() => false);
const mockBuildMentionRegexes = vi.fn(() => []);
const mockMatchesMentionPatterns = vi.fn(() => false);
const mockResolveStorePath = vi.fn(() => "/tmp/store");
const mockReadSessionUpdatedAt = vi.fn(() => undefined);
const mockFormatAgentEnvelope = vi.fn((p: { body: string }) => p.body);
const mockFinalizeInboundContext = vi.fn((p: Record<string, unknown>) => p);
const mockResolveEnvelopeFormatOptions = vi.fn(() => ({}));
const mockRecordInboundSession = vi.fn().mockResolvedValue(undefined);
const mockDispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue(undefined);

const runtimeCore = {
  channel: {
    activity: { record: mockActivityRecord },
    session: {
      recordInboundSession: mockRecordInboundSession,
      resolveStorePath: mockResolveStorePath,
      readSessionUpdatedAt: mockReadSessionUpdatedAt,
    },
    routing: { resolveAgentRoute: mockResolveAgentRoute },
    reply: {
      resolveEnvelopeFormatOptions: mockResolveEnvelopeFormatOptions,
      formatAgentEnvelope: mockFormatAgentEnvelope,
      finalizeInboundContext: mockFinalizeInboundContext,
      dispatchReplyWithBufferedBlockDispatcher: mockDispatchReplyWithBufferedBlockDispatcher,
    },
    commands: { shouldHandleTextCommands: mockShouldHandleTextCommands },
    text: { hasControlCommand: mockHasControlCommand },
    mentions: {
      buildMentionRegexes: mockBuildMentionRegexes,
      matchesMentionPatterns: mockMatchesMentionPatterns,
    },
  },
};

vi.mock("./runtime.js", () => ({
  getRoamRuntime: () => runtimeCore,
}));

// Mock the pairing controller
const mockIssuePairingChallenge = vi.fn().mockResolvedValue(undefined);
const mockReadStoreForDmPolicy = vi.fn().mockResolvedValue([]);

mockCreateChannelPairingController.mockReturnValue({
  issueChallenge: mockIssuePairingChallenge,
  readStoreForDmPolicy: mockReadStoreForDmPolicy,
});

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual("../runtime-api.js");
  return {
    ...(actual as object),
    dispatchInboundReplyWithBase: mockDispatchInboundReplyWithBase,
    deliverFormattedTextWithAttachments: mockDeliverFormattedTextWithAttachments,
    createChannelPairingController: mockCreateChannelPairingController,
    readStoreAllowFromForDmPolicy: mockReadStoreAllowFrom,
    logInboundDrop: mockLogInboundDrop,
    logTypingFailure: mockLogTypingFailure,
    resolveDmGroupAccessWithCommandGate: mockResolveDmGroupAccessWithCommandGate,
    resolveAllowlistProviderRuntimeGroupPolicy: mockResolveAllowlistProviderRuntimeGroupPolicy,
    resolveDefaultGroupPolicy: vi.fn(() => "open"),
    warnMissingProviderGroupPolicyFallbackOnce: mockWarnMissingProviderGroupPolicyFallbackOnce,
    GROUP_POLICY_BLOCKED_LABEL: { room: "room" },
  };
});

vi.mock("./policy.js", () => ({
  normalizeRoamAllowlist: vi.fn((v: unknown) => v ?? []),
  resolveRoamAllowlistMatch: vi.fn(() => ({ allowed: true })),
  resolveRoamGroupMatch: mockResolveRoamGroupMatch,
  resolveRoamGroupAllow: vi.fn(() => ({ allowed: true })),
  resolveRoamGroupSystemPrompt: mockResolveRoamGroupSystemPrompt,
  resolveRoamRequireMention: vi.fn(() => false),
  resolveRoamReplyInThread: vi.fn(() => false),
  resolveRoamMentionGate: vi.fn(() => ({ shouldSkip: false, shouldBypassMention: false })),
}));

// --- Helpers ---

function makeMessage(overrides?: Partial<RoamInboundMessage>): RoamInboundMessage {
  return {
    messageId: "msg-1",
    chatId: "chat-1",
    senderId: "user-1",
    senderName: "Alice",
    text: "hello bot",
    timestampMicros: Date.now() * 1000,
    chatType: "direct",
    ...overrides,
  };
}

function makeAccount(overrides?: Partial<ResolvedRoamAccount>): ResolvedRoamAccount {
  return {
    accountId: "default",
    enabled: true,
    apiKey: "test-api-key",
    apiKeySource: "config" as const,
    config: {
      dmPolicy: "open",
    },
    ...overrides,
  };
}

const defaultConfig: CoreConfig = {};
const defaultRuntime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

// --- Tests ---

describe("handleRoamInbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRoamAnswerStreamTrack.mockImplementation(() => mockLiveMessageTrack);
    mockCreateRoamLiveMessageTrack.mockImplementation(() => mockLiveMessageTrack);
    mockLiveMessageTrack.pushAccumulated.mockResolvedValue(undefined);
    mockLiveMessageTrack.rotate.mockResolvedValue(undefined);
    mockLiveMessageTrack.finalize.mockResolvedValue(undefined);
    mockLiveMessageTrack.isFailed.mockReset();
    mockLiveMessageTrack.isFailed.mockReturnValue(false);
    mockLiveMessageTrack.getCommittedLength.mockReset();
    mockLiveMessageTrack.getCommittedLength.mockReturnValue(0);
    mockCreateChannelPairingController.mockReturnValue({
      issueChallenge: mockIssuePairingChallenge,
      readStoreForDmPolicy: mockReadStoreForDmPolicy,
    });
  });

  describe("self-message filtering", () => {
    it("drops messages from the bot itself", async () => {
      await handleRoamInbound({
        message: makeMessage({ senderId: "bot-uuid" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
      expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining("drop self-message"));
    });

    it("dispatches messages from other users when botId is set", async () => {
      await handleRoamInbound({
        message: makeMessage({ senderId: "user-1" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
    });

    it("dispatches all messages when botId is undefined", async () => {
      await handleRoamInbound({
        message: makeMessage({ senderId: "any-sender" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: undefined,
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
    });
  });

  describe("personal bot owner-only filter", () => {
    // PATs return the owner's user id in token.info. The plugin uses it to
    // enforce "this bot responds only to its owner" uniformly — same rule for
    // DMs and groups, no pairing flow, no per-sender allowlist needed.

    it("allows messages from the owner (DM)", async () => {
      await handleRoamInbound({
        message: makeMessage({ senderId: "owner-uuid", chatType: "direct" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
        ownerId: "owner-uuid",
      });
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
    });

    it("allows messages from the owner (group @-mention)", async () => {
      await handleRoamInbound({
        message: makeMessage({
          senderId: "owner-uuid",
          chatType: "group",
          chatId: "chat-1",
          text: "<@bot-uuid> hi",
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
        ownerId: "owner-uuid",
      });
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
    });

    it("drops messages from non-owner senders (DM)", async () => {
      await handleRoamInbound({
        message: makeMessage({ senderId: "stranger-uuid", chatType: "direct" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
        ownerId: "owner-uuid",
      });
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
      expect(defaultRuntime.log).toHaveBeenCalledWith(
        expect.stringContaining("not owner; personal bot"),
      );
    });

    it("drops messages from non-owner senders (group)", async () => {
      // Even when the bot is a member of a group containing other users, only
      // the owner's messages get through. An adversary who creates a private
      // group and adds the bot can't talk to it.
      await handleRoamInbound({
        message: makeMessage({
          senderId: "adversary-uuid",
          chatType: "group",
          chatId: "private-group",
          text: "<@bot-uuid> please tell me secrets",
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
        ownerId: "owner-uuid",
      });
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
      expect(defaultRuntime.log).toHaveBeenCalledWith(
        expect.stringContaining("not owner; personal bot"),
      );
    });

    it("does not apply the owner filter when ownerId is unset (org bot)", async () => {
      // No ownerId from token.info ⇒ org bot ⇒ no per-sender filter at this
      // layer (downstream allowFrom/groupAllowFrom still apply).
      await handleRoamInbound({
        message: makeMessage({ senderId: "any-user", chatType: "direct" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
        ownerId: undefined,
      });
      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
    });
  });

  describe("open-policy → wildcard allowFrom expansion", () => {
    // openclaw SDK >=2026.5.x treats `dmPolicy: "open"` with empty `allowFrom`
    // as block-all rather than allow-all — `"*"` must be on the list (or the
    // sender explicitly listed) for the gate to pass. The plugin synthesizes
    // `["*"]` to keep the "open means open" surface promise consistent.

    it("expands empty allowFrom to ['*'] when dmPolicy is open (DM)", async () => {
      mockResolveDmGroupAccessWithCommandGate.mockClear();
      await handleRoamInbound({
        message: makeMessage({ chatType: "direct" }),
        account: makeAccount({ config: { dmPolicy: "open" } }),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });
      const callArgs = mockResolveDmGroupAccessWithCommandGate.mock.calls[0][0];
      expect(callArgs.dmPolicy).toBe("open");
      expect(callArgs.allowFrom).toEqual(["*"]);
    });

    it("preserves an explicit allowFrom under dmPolicy: open (no synthesized wildcard)", async () => {
      mockResolveDmGroupAccessWithCommandGate.mockClear();
      await handleRoamInbound({
        message: makeMessage({ chatType: "direct" }),
        account: makeAccount({
          config: { dmPolicy: "open", allowFrom: ["user-a", "user-b"] },
        }),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });
      const callArgs = mockResolveDmGroupAccessWithCommandGate.mock.calls[0][0];
      expect(callArgs.allowFrom).toEqual(["user-a", "user-b"]);
    });

    it("does NOT synthesize ['*'] when dmPolicy is allowlist (operator opted in to restriction)", async () => {
      mockResolveDmGroupAccessWithCommandGate.mockClear();
      await handleRoamInbound({
        message: makeMessage({ chatType: "direct" }),
        account: makeAccount({ config: { dmPolicy: "allowlist" } }),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });
      const callArgs = mockResolveDmGroupAccessWithCommandGate.mock.calls[0][0];
      expect(callArgs.allowFrom).toEqual([]);
    });

    it("also expands empty groupAllowFrom to ['*'] when groupPolicy is open", async () => {
      // Same reasoning for the group path — `groupPolicy: open` with empty
      // `groupAllowFrom` should mean "anyone in the group" per our surface,
      // but the SDK now treats it strictly.
      mockResolveAllowlistProviderRuntimeGroupPolicy.mockReturnValueOnce({
        groupPolicy: "open",
        providerMissingFallbackApplied: false,
      });
      mockResolveDmGroupAccessWithCommandGate.mockClear();
      await handleRoamInbound({
        message: makeMessage({ chatType: "group", chatId: "chat-1" }),
        account: makeAccount({ config: { groupPolicy: "open" } }),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });
      const callArgs = mockResolveDmGroupAccessWithCommandGate.mock.calls[0][0];
      expect(callArgs.groupAllowFrom).toEqual(["*"]);
    });
  });

  describe("group allowlist gate honors groupPolicy", () => {
    // The per-group `groups` map's allowed=false only gates traffic in
    // `allowlist` mode. Under `open`, listed entries are overrides — they
    // must not lock out the bot from groups it hasn't been configured for.
    it("dispatches a non-matching group under groupPolicy=open", async () => {
      mockResolveAllowlistProviderRuntimeGroupPolicy.mockReturnValueOnce({
        groupPolicy: "open",
        providerMissingFallbackApplied: false,
      });
      mockResolveRoamGroupMatch.mockReturnValueOnce({
        groupConfig: undefined,
        wildcardConfig: undefined,
        groupKey: undefined,
        matchSource: undefined,
        allowed: false,
        allowlistConfigured: true,
      });

      await handleRoamInbound({
        message: makeMessage({ chatType: "group", chatId: "fresh-group" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
      expect(defaultRuntime.log).not.toHaveBeenCalledWith(
        expect.stringContaining("not allowlisted"),
      );
    });

    it("drops a non-matching group under groupPolicy=allowlist", async () => {
      mockResolveAllowlistProviderRuntimeGroupPolicy.mockReturnValueOnce({
        groupPolicy: "allowlist",
        providerMissingFallbackApplied: false,
      });
      mockResolveRoamGroupMatch.mockReturnValueOnce({
        groupConfig: undefined,
        wildcardConfig: undefined,
        groupKey: undefined,
        matchSource: undefined,
        allowed: false,
        allowlistConfigured: true,
      });

      await handleRoamInbound({
        message: makeMessage({ chatType: "group", chatId: "fresh-group" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
      expect(defaultRuntime.log).toHaveBeenCalledWith(
        expect.stringContaining("not allowlisted"),
      );
    });
  });

  describe("not-allowlisted courtesy notice", () => {
    beforeEach(() => {
      __resetNotAllowlistedNoticeForTests();
      mockSendMessageRoam.mockClear();
    });

    function mockAllowlistDrop(times: number): void {
      // mockReturnValueOnce so the override doesn't leak to other tests.
      // Call `times` records so a single test can fire handleRoamInbound
      // multiple times under the same policy.
      for (let i = 0; i < times; i++) {
        mockResolveAllowlistProviderRuntimeGroupPolicy.mockReturnValueOnce({
          groupPolicy: "allowlist",
          providerMissingFallbackApplied: false,
        });
        mockResolveRoamGroupMatch.mockReturnValueOnce({
          groupConfig: undefined,
          wildcardConfig: undefined,
          groupKey: undefined,
          matchSource: undefined,
          allowed: false,
          allowlistConfigured: true,
        });
      }
    }

    it("posts a one-time notice when the bot is @-mentioned in an unlisted group", async () => {
      mockAllowlistDrop(1);

      await handleRoamInbound({
        message: makeMessage({
          chatType: "group",
          chatId: "fresh-group",
          text: "<@bot-uuid> ping",
        }),
        account: makeAccount({ accountId: "org" }),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockSendMessageRoam).toHaveBeenCalledTimes(1);
      const [target, text, opts] = mockSendMessageRoam.mock.calls[0];
      expect(target).toBe("fresh-group");
      expect(text).toContain("isn't on my allowlist");
      expect(text).toContain("`org`");
      expect(text).toContain("`fresh-group`");
      expect(opts).toMatchObject({ accountId: "org" });
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
    });

    it("does not re-post on subsequent mentions in the same chat", async () => {
      mockAllowlistDrop(2);

      const args = {
        account: makeAccount({ accountId: "org" }),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      } as const;

      await handleRoamInbound({
        ...args,
        message: makeMessage({
          chatType: "group",
          chatId: "fresh-group",
          text: "<@bot-uuid> ping",
        }),
      });
      await handleRoamInbound({
        ...args,
        message: makeMessage({
          chatType: "group",
          chatId: "fresh-group",
          text: "<@bot-uuid> still here?",
        }),
      });

      expect(mockSendMessageRoam).toHaveBeenCalledTimes(1);
    });

    it("stays silent for non-mention chatter in an unlisted group", async () => {
      mockAllowlistDrop(1);

      await handleRoamInbound({
        message: makeMessage({
          chatType: "group",
          chatId: "fresh-group",
          text: "hello team, no bot here",
        }),
        account: makeAccount({ accountId: "org" }),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockSendMessageRoam).not.toHaveBeenCalled();
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
    });

    it("replies in-thread when the mention came in a thread", async () => {
      mockAllowlistDrop(1);

      await handleRoamInbound({
        message: makeMessage({
          chatType: "group",
          chatId: "fresh-group",
          text: "<@bot-uuid> ping",
          threadTimestamp: 1700000000000001,
        }),
        account: makeAccount({ accountId: "org" }),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockSendMessageRoam).toHaveBeenCalledTimes(1);
      const opts = mockSendMessageRoam.mock.calls[0][2];
      expect(opts).toMatchObject({ threadTimestamp: 1700000000000001 });
    });

    it("posts a one-time notice when a non-allowlisted sender DMs the bot", async () => {
      // dmPolicy: "allowlist" + sender not in allowFrom → access.decision is
      // something other than "allow" / "pairing". Mirror the group case: post
      // a courtesy notice telling the sender how to get added.
      mockResolveDmGroupAccessWithCommandGate.mockReturnValueOnce({
        decision: "deny",
        reason: "allowlist",
        commandAuthorized: false,
        shouldBlockControlCommand: false,
        effectiveGroupAllowFrom: undefined,
      });

      await handleRoamInbound({
        message: makeMessage({
          chatType: "direct",
          chatId: "dm-chat",
          senderId: "stranger-uuid",
          text: "hello",
        }),
        account: makeAccount({ accountId: "org" }),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockSendMessageRoam).toHaveBeenCalledTimes(1);
      const [target, text, opts] = mockSendMessageRoam.mock.calls[0];
      expect(target).toBe("dm-chat");
      expect(text).toContain("you're not on my allowlist");
      expect(text).toContain("`org`");
      expect(text).toContain("`stranger-uuid`");
      expect(opts).toMatchObject({ accountId: "org" });
      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
    });

    it("does not post a DM notice when the decision is 'pairing'", async () => {
      // Pairing decisions issue their own challenge — don't double up.
      mockResolveDmGroupAccessWithCommandGate.mockReturnValueOnce({
        decision: "pairing",
        reason: "needs-pairing",
        commandAuthorized: false,
        shouldBlockControlCommand: false,
        effectiveGroupAllowFrom: undefined,
      });

      await handleRoamInbound({
        message: makeMessage({
          chatType: "direct",
          chatId: "dm-chat",
          senderId: "new-user",
          text: "hi",
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      // sendMessageRoam may be called by the pairing flow, but NOT with our
      // not-allowlisted notice text. Easiest check: no call contains
      // "not on my allowlist".
      const notices = mockSendMessageRoam.mock.calls.filter((c) =>
        typeof c[1] === "string" ? c[1].includes("not on my allowlist") : false,
      );
      expect(notices).toHaveLength(0);
    });
  });

  describe("empty text handling", () => {
    it("drops messages with empty text", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
    });

    it("drops messages with whitespace-only text", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "   " }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
    });

    it("processes media-only messages with no text", async () => {
      mockFetchRemoteMedia.mockResolvedValue({
        buffer: Buffer.from("image-data"),
        contentType: "image/png",
      });
      mockSaveMediaBuffer.mockResolvedValue({ path: "/tmp/media/img.png" });

      await handleRoamInbound({
        message: makeMessage({
          text: "",
          mediaUrls: ["https://example.com/photo.png"],
          mediaTypes: ["image/png"],
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
    });
  });

  describe("bot mention stripping", () => {
    it("strips bot mention from message body when botId is known", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<@bot-uuid> hello world" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.BodyForAgent).toBe("hello world");
    });

    it("preserves other user mentions when botId is known", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<@other-user> hello" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.BodyForAgent).toBe("<@other-user> hello");
    });

    it("strips all mentions when botId is unknown", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<@01234567-abcd-4000-8000-000000000000> hello world" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: undefined,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.BodyForAgent).toBe("hello world");
    });

    it("does not treat arbitrary user mentions as bot mention when botId is unknown", async () => {
      await handleRoamInbound({
        message: makeMessage({
          text: "<@01234567-abcd-4000-8000-000000000000> hello",
          chatType: "group",
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: undefined,
      });

      // wasBotMentioned should return false when botId is unknown,
      // preventing the bot from waking on arbitrary user mentions in groups.
      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.WasMentioned).toBe(false);
    });

    it("drops mention-only message with no remaining content", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<@bot-uuid>" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      expect(mockDispatchInboundReplyWithBase).not.toHaveBeenCalled();
    });

    it("strips <!@botId> exclamation-mark mention format", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<!@bot-uuid> hello there" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.BodyForAgent).toBe("hello there");
    });
  });

  describe("media download", () => {
    it("downloads media URLs to local files", async () => {
      mockFetchRemoteMedia.mockResolvedValue({
        buffer: Buffer.from("image-data"),
        contentType: "image/png",
      });
      mockSaveMediaBuffer.mockResolvedValue({ path: "/tmp/media/img.png" });

      await handleRoamInbound({
        message: makeMessage({
          mediaUrls: ["https://example.com/photo.png"],
          mediaTypes: ["image/png"],
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockFetchRemoteMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com/photo.png",
          maxBytes: expect.any(Number),
        }),
      );
      expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
        Buffer.from("image-data"),
        "image/png",
        "inbound",
      );

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.MediaPaths).toEqual(["/tmp/media/img.png"]);
      expect(ctxArg.MediaUrls).toEqual(["https://example.com/photo.png"]);
      expect(ctxArg.MediaTypes).toEqual(["image/png"]);
    });

    it("continues without media when download fails", async () => {
      mockFetchRemoteMedia.mockRejectedValue(new Error("download failed"));

      await handleRoamInbound({
        message: makeMessage({
          mediaUrls: ["https://example.com/photo.png"],
          mediaTypes: ["image/png"],
        }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalled();
      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.MediaPaths).toBeUndefined();
    });

    it("skips media download when no mediaUrls", async () => {
      await handleRoamInbound({
        message: makeMessage(),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockFetchRemoteMedia).not.toHaveBeenCalled();
      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.MediaPaths).toBeUndefined();
    });
  });

  describe("typing indicator", () => {
    it("fires an initial chat.typing pulse before dispatch", async () => {
      vi.useFakeTimers();
      try {
        const promise = handleRoamInbound({
          message: makeMessage({ chatId: "chat-42" }),
          account: makeAccount(),
          config: defaultConfig,
          runtime: defaultRuntime,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(mockSendTypingRoam).toHaveBeenCalledWith("chat-42", { accountId: "default" });
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-pulses chat.typing every 2s while dispatch is pending", async () => {
      vi.useFakeTimers();
      // Block the dispatch until we explicitly resolve, simulating a slow agent run.
      let resolveDispatch: () => void = () => {};
      mockDispatchInboundReplyWithBase.mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveDispatch = resolve; }),
      );
      try {
        const promise = handleRoamInbound({
          message: makeMessage({ chatId: "chat-42" }),
          account: makeAccount(),
          config: defaultConfig,
          runtime: defaultRuntime,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(mockSendTypingRoam).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(mockSendTypingRoam).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2000);
        expect(mockSendTypingRoam).toHaveBeenCalledTimes(3);
        resolveDispatch();
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the typing interval after dispatch returns", async () => {
      vi.useFakeTimers();
      try {
        await handleRoamInbound({
          message: makeMessage({ chatId: "chat-42" }),
          account: makeAccount(),
          config: defaultConfig,
          runtime: defaultRuntime,
        });
        await vi.advanceTimersByTimeAsync(0);
        const beforeWait = mockSendTypingRoam.mock.calls.length;
        // Dispatch already resolved; advancing time must NOT trigger more pulses.
        await vi.advanceTimersByTimeAsync(20000);
        expect(mockSendTypingRoam).toHaveBeenCalledTimes(beforeWait);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not fire chat.typing when a self-message is dropped", async () => {
      await handleRoamInbound({
        message: makeMessage({ senderId: "bot-uuid" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });
      expect(mockSendTypingRoam).not.toHaveBeenCalled();
    });

    it("does not fire chat.typing when an empty-body message is dropped", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "   " }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });
      expect(mockSendTypingRoam).not.toHaveBeenCalled();
    });

    it("does not fire chat.typing when a mention-only message is dropped", async () => {
      await handleRoamInbound({
        message: makeMessage({ text: "<@bot-uuid>" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        botId: "bot-uuid",
      });
      expect(mockSendTypingRoam).not.toHaveBeenCalled();
    });
  });

  describe("context payload", () => {
    it("sets Provider and Surface to roam", async () => {
      await handleRoamInbound({
        message: makeMessage(),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.Provider).toBe("roam");
      expect(ctxArg.Surface).toBe("roam");
    });

    it("sets ChatType to direct for DMs", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatType: "direct" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.ChatType).toBe("direct");
    });

    it("sets ChatType to group for group messages", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatType: "group" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.ChatType).toBe("group");
    });

    it("sets From with roam:group: prefix for groups", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatType: "group", chatId: "group-42" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.From).toBe("roam:group:group-42");
    });

    it("sets From with roam: prefix for DMs", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatType: "direct", senderId: "user-1" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.From).toBe("roam:user-1");
    });

    it("sets GroupSystemPrompt for group messages", async () => {
      mockResolveRoamGroupSystemPrompt.mockReturnValueOnce("Use group-specific instructions.");

      await handleRoamInbound({
        message: makeMessage({ chatType: "group", chatId: "group-42" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.GroupSystemPrompt).toBe("Use group-specific instructions.");
    });

    it("does not set GroupSystemPrompt for DMs", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatType: "direct", senderId: "user-1" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      const ctxArg = mockFinalizeInboundContext.mock.calls[0][0];
      expect(ctxArg.GroupSystemPrompt).toBeUndefined();
      expect(mockResolveRoamGroupSystemPrompt).not.toHaveBeenCalled();
    });
  });

  describe("dispatch", () => {
    it("calls dispatchInboundReplyWithBase for allowed messages", async () => {
      await handleRoamInbound({
        message: makeMessage(),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockDispatchInboundReplyWithBase).toHaveBeenCalledOnce();
      const args = mockDispatchInboundReplyWithBase.mock.calls[0][0];
      expect(args.channel).toBe("roam");
      expect(args.accountId).toBe("default");
    });

    it("calls statusSink on inbound", async () => {
      const statusSink = vi.fn();
      const tsMs = Date.now();

      await handleRoamInbound({
        message: makeMessage({ timestampMicros: tsMs * 1000 }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
        statusSink,
      });

      expect(statusSink).toHaveBeenCalledWith({ lastInboundAt: tsMs });
    });

    it("uses the live-message draft track for answer streaming", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatId: "chat-42" }),
        account: makeAccount(),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockCreateRoamLiveMessageTrack).toHaveBeenCalledWith({
        chatId: "chat-42",
        threadKey: undefined,
        accountId: "default",
        apiKey: "test-api-key",
        onError: expect.any(Function),
        onActivity: expect.any(Function),
      });

      const dispatchCall = mockDispatchInboundReplyWithBase.mock.calls[0][0];
      expect(dispatchCall.replyOptions.onPartialReply).toBeInstanceOf(Function);

      await dispatchCall.replyOptions.onPartialReply?.({ text: "partial text" });
      expect(mockLiveMessageTrack.pushAccumulated).toHaveBeenCalledWith("partial text");
    });

    it("uses the native answer stream track for localhost when nativeTransport is enabled", async () => {
      await handleRoamInbound({
        message: makeMessage({ chatId: "chat-42" }),
        account: makeAccount({
          config: {
            dmPolicy: "open",
            apiBaseUrl: "http://127.0.0.1:18789",
            streaming: { nativeTransport: true },
          },
        }),
        config: defaultConfig,
        runtime: defaultRuntime,
      });

      expect(mockCreateRoamAnswerStreamTrack).toHaveBeenCalledWith({
        chatId: "chat-42",
        accountId: "default",
        apiKey: "test-api-key",
        onError: expect.any(Function),
        onActivity: expect.any(Function),
      });
      expect(mockCreateRoamLiveMessageTrack).not.toHaveBeenCalled();
    });
  });
});
