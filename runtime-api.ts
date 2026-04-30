// Local barrel of plugin-sdk symbols this plugin consumes.
//
// Only re-exports from public, non-channel-bundled `openclaw/plugin-sdk/*`
// subpaths plus a small set of helpers inlined under `./src/_local-shim.ts`
// because they are not (yet) exposed by the public SDK. See README.md for
// the audit and follow-up issues.

// --- Types from public SDK -------------------------------------------------
export type { OpenClawConfig, ChannelPlugin, AllowlistMatch, PluginRuntime } from "openclaw/plugin-sdk/core";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
export type { SecretInput } from "openclaw/plugin-sdk/secret-input";
export type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";

// --- Values from public SDK ------------------------------------------------
export {
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  resolveWebhookPath,
  withResolvedWebhookRequestPipeline,
} from "openclaw/plugin-sdk/webhook-ingress";

export {
  buildBaseChannelStatusSummary,
  buildRuntimeAccountStatusSnapshot,
} from "openclaw/plugin-sdk/status-helpers";

export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";

export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";

export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";

export {
  deliverFormattedTextWithAttachments,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";

export { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";

export { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
export { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";

export { readStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-policy";

export {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingNativeTransport,
} from "openclaw/plugin-sdk/channel-streaming";

export {
  ToolPolicySchema,
  ReplyRuntimeConfigSchemaShape,
} from "openclaw/plugin-sdk/agent-config-primitives";

export { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
export { resolveAccountWithDefaultFallback } from "openclaw/plugin-sdk/account-core";
export { evaluateMatchedGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";

export { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-plugin-common";

// --- Locally inlined helpers (see src/_local-shim.ts) ----------------------
export {
  // schemas
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  requireOpenAllowFrom,
  // channel-config helpers
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
  // mention gating
  resolveMentionGatingWithBypass,
  // dm group access
  resolveDmGroupAccessWithCommandGate,
  // config helpers
  clearAccountEntryFields,
} from "./src/_local-shim.js";

export type {
  ChannelGroupContext,
  GroupToolPolicyConfig,
  BlockStreamingCoalesceConfig,
  DmConfig,
} from "./src/_local-shim.js";
