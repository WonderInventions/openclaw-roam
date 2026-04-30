// Helpers and types not (yet) exposed by the public openclaw plugin SDK.
//
// Each block below mirrors the implementation in the source repo at the path
// noted in the comment. Promote any of these to the public SDK and re-import
// from there to drop the local copy.

import { z } from "zod";
import {
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "openclaw/plugin-sdk/channel-policy";

// =============================================================================
// src/config/zod-schema.core.ts — DM/group/markdown schemas + open-allowFrom
// guard. Promote to e.g. `openclaw/plugin-sdk/channel-config-schema`.
// =============================================================================

export const DmPolicySchema = z.enum(["pairing", "allowlist", "open", "disabled"]);
export const GroupPolicySchema = z.enum(["open", "disabled", "allowlist"]);

const MarkdownTableModeSchema = z.enum(["off", "ascii", "unicode"]);
export const MarkdownConfigSchema = z
  .object({
    tables: MarkdownTableModeSchema.optional(),
  })
  .strict()
  .optional();

export const requireOpenAllowFrom = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}): void => {
  if (params.policy !== "open") {
    return;
  }
  const entries = (params.allowFrom ?? []).map((entry) => String(entry).trim());
  if (entries.includes("*")) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
};

// =============================================================================
// src/channels/channel-config.ts — channel-key candidate / nested allowlist
// helpers. Promote to e.g. `openclaw/plugin-sdk/channel-routing`.
// =============================================================================

export type ChannelMatchSource = "direct" | "parent" | "wildcard";

export type ChannelEntryMatch<T> = {
  entry?: T;
  key?: string;
  wildcardEntry?: T;
  wildcardKey?: string;
  parentEntry?: T;
  parentKey?: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};

export function normalizeChannelSlug(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildChannelKeyCandidates(
  ...keys: Array<string | undefined | null>
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      continue;
    }
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    candidates.push(trimmed);
  }
  return candidates;
}

function resolveChannelEntryMatch<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  wildcardKey?: string;
}): ChannelEntryMatch<T> {
  const entries = params.entries ?? {};
  const match: ChannelEntryMatch<T> = {};
  for (const key of params.keys) {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) {
      continue;
    }
    match.entry = entries[key];
    match.key = key;
    break;
  }
  if (params.wildcardKey && Object.prototype.hasOwnProperty.call(entries, params.wildcardKey)) {
    match.wildcardEntry = entries[params.wildcardKey];
    match.wildcardKey = params.wildcardKey;
  }
  return match;
}

export function resolveChannelEntryMatchWithFallback<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  parentKeys?: string[];
  wildcardKey?: string;
  normalizeKey?: (value: string) => string;
}): ChannelEntryMatch<T> {
  const direct = resolveChannelEntryMatch({
    entries: params.entries,
    keys: params.keys,
    wildcardKey: params.wildcardKey,
  });

  if (direct.entry && direct.key) {
    return { ...direct, matchKey: direct.key, matchSource: "direct" };
  }

  const normalizeKey = params.normalizeKey;
  if (normalizeKey) {
    const normalizedKeys = params.keys.map((key) => normalizeKey(key)).filter(Boolean);
    if (normalizedKeys.length > 0) {
      for (const [entryKey, entry] of Object.entries(params.entries ?? {})) {
        const normalizedEntry = normalizeKey(entryKey);
        if (normalizedEntry && normalizedKeys.includes(normalizedEntry)) {
          return {
            ...direct,
            entry,
            key: entryKey,
            matchKey: entryKey,
            matchSource: "direct",
          };
        }
      }
    }
  }

  const parentKeys = params.parentKeys ?? [];
  if (parentKeys.length > 0) {
    const parent = resolveChannelEntryMatch({ entries: params.entries, keys: parentKeys });
    if (parent.entry && parent.key) {
      return {
        ...direct,
        entry: parent.entry,
        key: parent.key,
        parentEntry: parent.entry,
        parentKey: parent.key,
        matchKey: parent.key,
        matchSource: "parent",
      };
    }
  }

  if (direct.wildcardEntry && direct.wildcardKey) {
    return {
      ...direct,
      entry: direct.wildcardEntry,
      key: direct.wildcardKey,
      matchKey: direct.wildcardKey,
      matchSource: "wildcard",
    };
  }

  return direct;
}

export function resolveNestedAllowlistDecision(params: {
  outerConfigured: boolean;
  outerMatched: boolean;
  innerConfigured: boolean;
  innerMatched: boolean;
}): boolean {
  if (!params.outerConfigured) {
    return true;
  }
  if (!params.outerMatched) {
    return false;
  }
  if (!params.innerConfigured) {
    return true;
  }
  return params.innerMatched;
}

// =============================================================================
// src/channels/mention-gating.ts — `resolveMentionGatingWithBypass`. The
// public mention-gating module is not yet exposed as a plugin-sdk subpath.
// =============================================================================

type MentionGateWithBypassParams = {
  isGroup: boolean;
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  hasAnyMention?: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
};

type MentionGateWithBypassResult = {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;
  shouldBypassMention: boolean;
};

export function resolveMentionGatingWithBypass(
  params: MentionGateWithBypassParams,
): MentionGateWithBypassResult {
  const shouldBypassMention =
    params.isGroup &&
    params.requireMention &&
    !params.wasMentioned &&
    !(params.hasAnyMention ?? false) &&
    params.allowTextCommands &&
    params.commandAuthorized &&
    params.hasControlCommand;
  const implicitMention = params.implicitMention === true;
  const effectiveWasMentioned =
    params.wasMentioned || implicitMention || shouldBypassMention;
  const shouldSkip =
    params.requireMention && params.canDetectMention && !effectiveWasMentioned;
  return { effectiveWasMentioned, shouldSkip, shouldBypassMention };
}

// =============================================================================
// `resolveDmGroupAccessWithCommandGate` — wraps the public
// `resolveDmGroupAccessWithLists` from `openclaw/plugin-sdk/channel-policy`
// with a small command-gate. The wrapper exists because the SDK does not yet
// expose a command-gated variant; promote this entire block into core under
// `openclaw/plugin-sdk/channel-policy` to drop the local copy.
// =============================================================================

type DmGroupAccessInputParams = Parameters<typeof resolveDmGroupAccessWithLists>[0];

function resolveControlCommandGate(params: {
  useAccessGroups: boolean;
  authorizers: Array<{ configured: boolean; allowed: boolean }>;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
}): { commandAuthorized: boolean; shouldBlock: boolean } {
  const commandAuthorized = !params.useAccessGroups
    ? true
    : params.authorizers.some((entry) => entry.configured && entry.allowed);
  const shouldBlock =
    params.allowTextCommands && params.hasControlCommand && !commandAuthorized;
  return { commandAuthorized, shouldBlock };
}

export function resolveDmGroupAccessWithCommandGate(
  params: DmGroupAccessInputParams & {
    command?: {
      useAccessGroups: boolean;
      allowTextCommands: boolean;
      hasControlCommand: boolean;
    };
  },
): ReturnType<typeof resolveDmGroupAccessWithLists> & {
  commandAuthorized: boolean;
  shouldBlockControlCommand: boolean;
} {
  const access = resolveDmGroupAccessWithLists(params);

  // Group command authorization must not inherit DM pairing-store approvals,
  // so we re-derive the *configured* (storeless) allowlists for the gate.
  const configured = resolveEffectiveAllowFromLists({
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    storeAllowFrom: undefined,
    dmPolicy: params.dmPolicy,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
  });
  const commandDmAllowFrom = params.isGroup
    ? configured.effectiveAllowFrom
    : access.effectiveAllowFrom;
  const commandGroupAllowFrom = params.isGroup
    ? configured.effectiveGroupAllowFrom
    : access.effectiveGroupAllowFrom;
  const commandGate = params.command
    ? resolveControlCommandGate({
        useAccessGroups: params.command.useAccessGroups,
        authorizers: [
          {
            configured: commandDmAllowFrom.length > 0,
            allowed: params.isSenderAllowed(commandDmAllowFrom),
          },
          {
            configured: commandGroupAllowFrom.length > 0,
            allowed: params.isSenderAllowed(commandGroupAllowFrom),
          },
        ],
        allowTextCommands: params.command.allowTextCommands,
        hasControlCommand: params.command.hasControlCommand,
      })
    : { commandAuthorized: false, shouldBlock: false };

  return {
    ...access,
    commandAuthorized: commandGate.commandAuthorized,
    shouldBlockControlCommand: params.isGroup && commandGate.shouldBlock,
  };
}

// =============================================================================
// src/channels/plugins/config-helpers.ts — `clearAccountEntryFields`. The
// public SDK only re-exports this from `openclaw/plugin-sdk/line` today.
// =============================================================================

function isConfiguredSecretValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return Boolean(value);
}

export function clearAccountEntryFields<TAccountEntry extends object>(params: {
  accounts?: Record<string, TAccountEntry>;
  accountId: string;
  fields: string[];
  isValueSet?: (value: unknown) => boolean;
  markClearedOnFieldPresence?: boolean;
}): {
  nextAccounts?: Record<string, TAccountEntry>;
  changed: boolean;
  cleared: boolean;
} {
  const accountKey = params.accountId || "default";
  const baseAccounts =
    params.accounts && typeof params.accounts === "object" ? { ...params.accounts } : undefined;
  if (!baseAccounts || !(accountKey in baseAccounts)) {
    return { nextAccounts: baseAccounts, changed: false, cleared: false };
  }

  const entry = baseAccounts[accountKey];
  if (!entry || typeof entry !== "object") {
    return { nextAccounts: baseAccounts, changed: false, cleared: false };
  }

  const nextEntry = { ...(entry as Record<string, unknown>) };
  const hasAnyField = params.fields.some((field) => field in nextEntry);
  if (!hasAnyField) {
    return { nextAccounts: baseAccounts, changed: false, cleared: false };
  }

  const isValueSet = params.isValueSet ?? isConfiguredSecretValue;
  let cleared = Boolean(params.markClearedOnFieldPresence);
  for (const field of params.fields) {
    if (!(field in nextEntry)) {
      continue;
    }
    if (isValueSet(nextEntry[field])) {
      cleared = true;
    }
    delete nextEntry[field];
  }

  if (Object.keys(nextEntry).length === 0) {
    delete baseAccounts[accountKey];
  } else {
    baseAccounts[accountKey] = nextEntry as TAccountEntry;
  }

  const nextAccounts = Object.keys(baseAccounts).length > 0 ? baseAccounts : undefined;
  return { nextAccounts, changed: true, cleared };
}

// =============================================================================
// src/channels/plugins/types.public.ts / types.js — minimal shapes for types
// that core only re-exports through channel-bundled SDK paths today.
// =============================================================================

export type ChannelGroupContext = {
  cfg: unknown;
  accountId?: string | null;
  groupId?: string | null;
};

export type GroupToolPolicyConfig = {
  allow?: string[];
  deny?: string[];
};

export type BlockStreamingCoalesceConfig = {
  enabled?: boolean;
  intervalMs?: number;
  windowMs?: number;
  maxBlocks?: number;
};

export type DmConfig = {
  policy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  systemPrompt?: string;
  enabled?: boolean;
  tools?: GroupToolPolicyConfig;
  skills?: string[];
};
