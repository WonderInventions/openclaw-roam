import { z } from "zod";
import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ToolPolicySchema,
} from "../runtime-api.js";
import { buildSecretInputSchema } from "./secret-input.js";

/**
 * URL schema that accepts HTTPS unconditionally and HTTP only for loopback
 * (localhost / 127.0.0.1). Used for both `apiBaseUrl` (we → Roam, Bearer
 * token in cleartext if http) and `webhookUrl` (Roam → us, signing header in
 * cleartext if http).
 */
function httpsUrlOrLocalhost(fieldName: string) {
  return z
    .string()
    .url()
    .refine(
      (v) => {
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
        message: `${fieldName} must be https:// (http:// is only allowed for localhost / 127.0.0.1)`,
      },
    );
}

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
    apiBaseUrl: httpsUrlOrLocalhost("apiBaseUrl").optional(),
    webhookUrl: httpsUrlOrLocalhost("webhookUrl").optional(),
    webhookSecret: z
      .string()
      .refine((v) => v.startsWith("whsec_"), {
        // Roam's signing secrets are `whsec_<base64>`. A non-prefixed value is
        // almost always a paste error (e.g. an API key in the wrong field) and
        // would silently fail every signature check at runtime.
        message: 'webhookSecret must start with "whsec_" (the value Roam admin shows on token create)',
      })
      .optional(),
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
