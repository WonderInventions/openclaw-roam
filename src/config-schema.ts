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
    apiBaseUrl: z
      .string()
      .url()
      .refine(
        (v) => {
          // Allow only HTTPS in prod. Plaintext HTTP is fine for loopback dev
          // (localhost / 127.0.0.1) — the API key never leaves the host. Any
          // other http:// would send the Bearer token in cleartext.
          try {
            const u = new URL(v);
            if (u.protocol === "https:") return true;
            if (u.protocol !== "http:") return false;
            return u.hostname === "localhost" || u.hostname === "127.0.0.1";
          } catch {
            return false;
          }
        },
        {
          message:
            "apiBaseUrl must be https:// (http:// is only allowed for localhost / 127.0.0.1)",
        },
      )
      .optional(),
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
