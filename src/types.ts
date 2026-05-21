import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  SecretInput,
} from "../runtime-api.js";

export type { DmPolicy, GroupPolicy };

type RoamStreamingChunkConfig = {
  minChars?: number;
  maxChars?: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
};

type RoamStreamingConfig = {
  mode?: "off" | "partial";
  chunkMode?: "length" | "newline";
  nativeTransport?: boolean;
  preview?: { chunk?: RoamStreamingChunkConfig };
  block?: {
    enabled?: boolean;
    coalesce?: BlockStreamingCoalesceConfig;
  };
};

/** Per-group configuration (keyed by Roam group UUID). */
export type RoamGroupConfig = {
  requireMention?: boolean;
  /** Optional tool policy overrides for this group. */
  tools?: { allow?: string[]; deny?: string[] };
  /** If specified, only load these skills for this group. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this group. */
  enabled?: boolean;
  /** Optional allowlist for group senders (Roam user UUIDs). */
  allowFrom?: string[];
  /** Optional system prompt snippet for this group. */
  systemPrompt?: string;
  /**
   * When true, replies to a top-level message in this group start a new Roam
   * thread under that message (outbound `threadTimestamp` = inbound `timestamp`).
   * Inbound messages already in a thread continue to reply within that thread
   * regardless of this setting. Default: false (reply at top level).
   */
  replyInThread?: boolean;
};

export type RoamAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Roam account. Default: true. */
  enabled?: boolean;
  /** Roam API key (Bearer token). Created in Roam Administration > Developer. */
  apiKey?: SecretInput;
  /** Path to file containing API key (for secret managers). */
  apiKeyFile?: string;
  /** Direct message policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist of Roam user UUIDs allowed to DM the bot. */
  allowFrom?: string[];
  /** Optional allowlist for Roam group senders (user UUIDs). */
  groupAllowFrom?: string[];
  /** Group message policy (default: allowlist). */
  groupPolicy?: GroupPolicy;
  /** Per-group configuration (key is Roam group UUID). */
  groups?: Record<string, RoamGroupConfig>;
  /** Webhook endpoint path on the gateway server. Default: "/roam-webhook". */
  webhookPath?: string;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user UUID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 8000. */
  textChunkLimit?: number;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Override API base URL (e.g. "https://api.roam.dev" for dev). Default: "https://api.ro.am". */
  apiBaseUrl?: string;
  /** Full webhook callback URL for auto-subscription (e.g. "https://example.com/roam-webhook"). */
  webhookUrl?: string;
  /** Standard-webhooks signing secret for verifying inbound webhook payloads. From Roam admin. */
  webhookSecret?: string;
  /** Streaming + chunking settings. Prefer this nested shape over legacy flat keys. */
  streaming?: RoamStreamingConfig;
};

export type RoamConfig = {
  /** Optional per-account Roam configuration (multi-account). */
  accounts?: Record<string, RoamAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & RoamAccountConfig;

export type CoreConfig = {
  channels?: {
    roam?: RoamConfig;
  };
  [key: string]: unknown;
};

/** Bot persona identity returned by /v1/token.info. */
export type RoamBotIdentity = {
  /** Bot's chat address UUID (used as sender ID on outbound messages). */
  id: string;
  /** Bot display name (from the token's name field). */
  name: string;
  /** Bot avatar URL (optional, from the token's image). */
  imageUrl?: string;
};

// --- Roam API types ---

/**
 * Roam webhook event payload (chat.message event type).
 * All IDs are bare UUIDs.
 */
export type RoamWebhookEvent = {
  /** Always "message" for chat.message events. */
  type: string;
  /** Content type (e.g. "text"). */
  contentType?: string;
  /** Sender user UUID. */
  userId: string;
  /** Chat UUID. */
  chatId: string;
  /** Message text content. */
  text: string;
  /** Microsecond-precision timestamp. */
  timestamp: number;
  /** Thread timestamp for threaded replies. */
  threadTimestamp?: number;
  /** Reply timestamp (if replying to a specific message). */
  replyTimestamp?: number;
  /** Attached items (images, files). Each has at least id, type, url. */
  items?: RoamWebhookItem[];
  /** Message ID. */
  messageId?: string;
  /** Chat type: "dm" for direct messages, "channel" for group/channel messages. */
  chatType: "dm" | "channel" | "group";
};

/** An item attached to a Roam webhook event (image, file, etc.). */
export type RoamWebhookItem = {
  id: string;
  type: string;
  mime?: string;
  name?: string;
  url?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  size?: number;
};

/** Parsed incoming message context. */
export type RoamInboundMessage = {
  messageId: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  /**
   * Microseconds since epoch — the raw webhook value, preserved without rounding.
   *
   * This is the **identifier** Roam uses to index messages, and the only timestamp
   * field carried on the inbound message. Treat it as immutable.
   *
   * Consumers that need a `Date.now()`-style millisecond value (agent ctxPayload
   * `Timestamp`, host status sinks, activity records) convert at the boundary
   * with `Math.floor(message.timestampMicros / 1000)`. Doing the conversion at
   * the call site keeps the unit explicit and prevents the previous bug where
   * an ms value was multiplied back to µs, losing precision and producing a
   * thread-parent timestamp Roam did not recognize.
   */
  timestampMicros: number;
  chatType: "direct" | "group";
  /** Microsecond-precision parent-message timestamp when the inbound is in a Roam thread. */
  threadTimestamp?: number;
  /** URLs of attached media (images, files). */
  mediaUrls?: string[];
  /** MIME types corresponding to mediaUrls. */
  mediaTypes?: string[];
};

/** Result from sending a message to Roam. */
export type RoamSendResult = {
  chatId: string;
  timestamp?: number;
};

/** Options for sending a message. */
export type RoamSendOptions = {
  apiKey?: string;
  accountId?: string;
  /** Microsecond timestamp of the parent message when posting into an existing Roam thread. */
  threadTimestamp?: number;
  cfg?: CoreConfig;
};
