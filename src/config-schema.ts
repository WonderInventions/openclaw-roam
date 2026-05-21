import { z } from "zod";
import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ToolPolicySchema,
} from "../runtime-api.js";
import { buildSecretInputSchema } from "./secret-input.js";

const RoamStreamingSchema = z
  .object({
    mode: z.enum(["off", "partial"]).optional(),
    nativeTransport: z.boolean().optional(),
  })
  .passthrough()
  .optional();

export const RoamGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    replyInThread: z.boolean().optional(),
  })
  .strict();

export const RoamAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    apiKey: buildSecretInputSchema().optional(),
    apiKeyFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("open"),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("open"),
    groups: z.record(z.string(), RoamGroupSchema.optional()).optional(),
    webhookPath: z.string().optional(),
    apiBaseUrl: z.string().optional(),
    webhookUrl: z.string().optional(),
    webhookSecret: z.string().optional(),
    streaming: RoamStreamingSchema,
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict();

// Note: the SDK's `requireChannelOpenAllowFrom` guard (which forces
// `allowFrom: ["*"]` when `dmPolicy: "open"`) is intentionally NOT applied to
// the Roam channel. Open is now the default surface model — personal bots are
// owner-locked at the inbound layer (see `handleRoamInbound`), and org bots
// are deliberately workspace-open with `allowFrom` available as opt-in.
export const RoamAccountSchema = RoamAccountSchemaBase;

export const RoamConfigSchema = RoamAccountSchemaBase.extend({
  accounts: z.record(z.string(), RoamAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
});
