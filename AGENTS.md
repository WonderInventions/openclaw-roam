# AGENTS.md — `@roamhq/openclaw-roam`

Developer notes for working on this plugin. The README is for operators
configuring the bot; this file is for anyone (human or coding agent) editing
the source.

## What this is

A channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) that
bridges Roam HQ (https://ro.am) chat to an OpenClaw agent. Inbound webhook
events from Roam fan out to the host's agent runtime; outbound replies go back
via the Roam v1 HTTP API.

```
Roam webhook ─► setup-surface ─► monitor ─► handleRoamInbound (src/inbound.ts)
                                                 │
                                                 ├─ access/policy gates
                                                 ├─ chat.history (group context)
                                                 ├─ dispatch to agent runtime
                                                 └─ deliver → sendMessageRoam → POST chat.post
```

## Layout

| Path                           | Concern                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `src/inbound.ts`               | Dispatch entry point. Drop checks, access gates, history fetch, deliver. |
| `src/monitor.ts`               | Webhook → `RoamInboundMessage` normalization; bot identity fetch.        |
| `src/send.ts`                  | Outbound: `chat.post` / `chat.update` / `chat.typing` / `item.upload`.   |
| `src/history.ts`               | `GET /v1/chat.history`.                                                  |
| `src/streaming.ts`             | Legacy "live message" via `chat.post` + `chat.update` edit loop.         |
| `src/chat-stream.ts`           | Native streaming via `chat.startStream` / `appendStream` / `stopStream`. |
| `src/accounts.ts`              | Multi-account resolution (`channels.roam.accounts.<id>`).                |
| `src/policy.ts`                | Per-group `requireMention`, `replyInThread`, allowlist resolution.       |
| `src/channel.ts`               | Host-facing channel adapter (`sendText`, `sendMedia`).                   |
| `src/config-schema.ts`         | Zod schema; mirror any field added in `openclaw.plugin.json`.            |
| `src/env-export.ts`            | Surfaces `ROAM_API_KEY` to the agent's env for MCP/tool use.             |
| `testdata/openclaw-fixtures/`  | Contract fixtures, shared with wonder's appserver e2e suite.             |

## Commands

```bash
npm test           # vitest run (includes contract tests)
npm run typecheck  # tsc --noEmit
npm run build      # tsc --project tsconfig.build.json → dist/
```

## Multi-account model

Configs may carry one or many accounts:

```jsonc
channels: {
  roam: {
    accounts: {
      default: { apiKey: "rmp-…", … },     // PAT bot
      org:     { apiKey: "rmk-…", … },     // org-token bot
    },
  },
},
bindings: [
  { channel: "roam", account: "org", agent: "sre-agent" },
],
```

- `accounts.<id>` keys flow through to every outbound call via `accountId`.
- `bindings[]` routes a given account to a specific agent. Without a binding,
  routing falls back to the default agent.
- The legacy flat form (`channels.roam.apiKey` at top level) still works;
  `accounts.ts` flattens both into `ResolvedRoamAccount`.

## PAT vs Org tokens

| Token prefix | `token.info` returns                       | Can be a group member?         | Webhook coverage in groups       |
| ------------ | ------------------------------------------ | ------------------------------ | -------------------------------- |
| `rmp-` (PAT) | `user` (owner) **+** `bot` (PAT identity)  | No — represents a human user.  | Only events that @-mention.      |
| `rmk-` (Org) | `user` only (which IS the bot identity)    | Yes — added like any member.   | Every event in member groups.    |

`fetchRoamBotIdentity` (in `monitor.ts`) uses the presence of `data.bot.id`
to disambiguate: if present → PAT, persona = `data.bot`, owner = `data.user.id`;
absent → Org, persona = `data.user`, no owner.

**Owner-only filter for PATs.** When `ownerId` is set on the identity (= PAT),
`handleRoamInbound` drops every inbound where `senderId !== ownerId`, uniformly
across DM and group. Personal bots respond only to their owner; an adversary
creating a private group and adding the bot can't talk to it. Org bots have
no `ownerId` and skip the filter (downstream `allowFrom`/`groupAllowFrom`
still apply as opt-in allowlists).

**Implication for `requireMention`:**
- Org bots in a group can default to `requireMention: false` (proactive); they
  see every message and can decide whether to chime in.
- PAT bots should keep `requireMention: true` (default); they only get the
  webhook on mention anyway, and the owner-only filter already gates them.

## Threading

Roam expresses threads via **microsecond UNIX timestamps**, not opaque IDs.

- The webhook delivers `threadTimestamp` (µs) for replies — this is the parent
  message's timestamp, identifying the thread.
- Outbound calls (`chat.post`, `chat.update`, `chat.typing`) accept
  `threadTimestamp` in the JSON body to place a reply in a thread.
- `message.timestamp` from `webhookEventToInbound` is **milliseconds** (we
  normalize at the boundary). When we use the inbound's own timestamp as the
  thread parent for a new thread, we multiply by 1000 (see `inbound.ts`
  `replyInThread` branch).

**Where the reply lands** (logic in `inbound.ts` ~L373):
1. Inbound was already in a thread → reply in the same thread.
2. Top-level inbound + group has `replyInThread: true` → start a new thread
   under the inbound message.
3. Otherwise → reply at top level.

**`chat.history` quirks:**
- Query param is `chatId` (the deployed v1 API does *not* accept `chat` as the
  OpenAPI draft says).
- With `threadTimestamp=X`, the response is the **replies of X**, NOT X itself.
  If you want the full thread including the root, fetch top-level too and
  merge (currently we only fetch the thread-scoped slice; revisit if context
  feels thin).
- Server cap is 200; default in this plugin is 20. `historyLimit: 0` disables.

**Streaming + threading:** The native stream lifecycle (`chat.startStream`)
does not currently support `threadTimestamp`. Thinking content always posts at
top level. Answer content falls back to `chat.post` (which does support
threading) when `streaming.nativeTransport` is unset.

## Access gating layers (in order)

`inbound.ts` runs these before dispatching:

1. **Self-message drop** — `botId === senderId` → drop, log only.
2. **Owner-only filter** (PATs only) — `ownerId` set + `senderId !== ownerId`
   → drop. Personal bots respond only to their owner; uniform across DM and
   group. Skipped entirely for org tokens (no `ownerId`).
3. **Empty body + no media** → drop silently.
4. **Group allowlist match** — `groups: { "<chatId>": {…} }` (and `"*"`
   wildcard). Out-of-list groups dropped.
5. **`enabled: false`** on the matched group → drop.
6. **DM/group access decision** — `resolveDmGroupAccessWithCommandGate` from
   the host runtime. `dmPolicy` defaults to `"open"` — pairing remains opt-in
   via explicit `dmPolicy: "pairing"`.
7. **`groupPolicy` + per-group allowlist** — `open` / `allowlist` / `disabled`.
8. **Mention gate** — `requireMention: true` + no mention detected → drop.
   Control commands bypass via `commandAuthorized`.

Typing pulse starts **after** all drop checks pass. The shared contract
fixtures assert zero API calls on drop paths — don't move the
`fireTypingPulse()` call earlier.

## Streaming

**Default path: chat.post + chat.update.** Out of the box the answer streams
into a single Roam message via `chat.post` (placeholder) → `chat.update`
(grow). Reasoning content is dropped — `chat.post` has no thought-bubble
equivalent.

**Beta opt-in: native streaming.** Set `channels.roam.streaming.nativeTransport: true`
to switch to `chat.startStream` → `appendStream` → `stopStream` for *both*
tracks:

- **Answer** (`kind: "text"`) streams into a single message, same visual
  outcome as the default but with lower latency to first byte.
- **Thinking** (`kind: "thinking"`) renders as a collapsed thought-bubble
  separate from the answer.

Both kinds accept `threadTimestamp` (server-side: see wonder
`chat.stream.go:74`), so threaded replies remain threaded under either path.
If a native send fails mid-stream the plugin falls back to `chat.post` for
the residual answer content; thinking content is simply lost.

`useNativeStreaming` in `inbound.ts` is the single gate. Don't conditionally
enable one lane and not the other — the beta is "all or nothing."

## Outbound media (item.upload)

When the host runtime calls `sendMedia` with a `mediaUrl`, the plugin:

1. Fetches the bytes via the SSRF-guarded `fetchRemoteMedia` (same path
   inbound media downloads use). Bounded by `MAX_IMAGE_BYTES` (~10 MB).
2. POSTs to `/v1/item.upload` with `Content-Type: <mime>` and
   `Content-Disposition: attachment; filename=...` headers. Filename is
   derived from the URL path or synthesized from the content-type.
3. POSTs to `/v1/chat.post` with `items: [itemId]` so the upload renders as
   a real attachment in the message (image preview / downloadable file)
   rather than a pasted URL.

`chat.startStream` does NOT accept `items` — media payloads always take the
chat.post path. `deliverRoamReply` already routes media via chat.post; the
streaming track is bypassed for media-bearing payloads (see
`resolveSendableOutboundReplyParts.hasMedia`).

## Contract fixtures

`testdata/openclaw-fixtures/*.json` is the **canonical contract** between this
plugin and Roam's appserver. The same files are consumed by
`wonder/e2e_openclaw_webhook_contract_test.go` (live HTTP) and by
`src/contract.test.ts` (in-process, with `fetchWithSsrFGuard` mocked).

When changing inbound → outbound behavior:
1. Update the fixture (both directions read it).
2. `npm test` here.
3. Run the wonder e2e (or open a PR there) to keep both halves aligned.

Don't add Roam-internal-only behaviors to fixtures — those belong in
`inbound.test.ts` / `send.test.ts`.

## Common gotchas

- **Group replies silently dropped.** If the agent produces text but nothing
  arrives in Roam, check the host's `messages.groupChat.visibleReplies` — when
  set to `message_tool`, deliver is never called for groups. Set
  `sourceReplyDeliveryMode: "automatic"` on `replyOptions` to opt back in.
- **`chat.history` returning count=0** despite messages existing in the chat:
  most likely the response field shape drifted. Current production returns
  `userId`, but the OpenAPI draft says `sender`. `history.ts` reads `sender` —
  if the API changes, expect a silent empty-array regression.
- **Typing indicator outlives the message.** Roam holds typing ~3s after the
  last pulse; the deliver path stops the pulse before `chat.post` for that
  reason. If you add a new delivery branch, call `stopTypingPulse()` first.
- **`threadKey` is dead.** Earlier code used a string `threadKey`; the deployed
  API uses microsecond `threadTimestamp` and the two are mutually exclusive.
  Don't reintroduce `threadKey`.
- **`dmPolicy: "open"` requires `["*"]` in `allowFrom` to actually pass the
  SDK gate** (openclaw >=2026.5.x). The SDK's runtime DM gate treats open with
  an empty allowFrom as block-all, not allow-all. The plugin auto-expands
  empty `allowFrom`/`groupAllowFrom` to `["*"]` at the call site of
  `resolveDmGroupAccessWithCommandGate` when the corresponding policy is
  `"open"` — keep that synthesis around. Personal bots are owner-locked at
  an earlier gate, so this only affects org bots, but the "open means open"
  surface promise depends on it.
- **Microseconds vs milliseconds.** Timestamps are identifiers and we treat
  them as immutable. `RoamInboundMessage` carries only `timestampMicros` (µs,
  the raw webhook value) and `threadTimestamp` (also µs). Both are passed
  through to Roam API calls unchanged — Roam indexes messages by exact µs and
  will 400 with "threadTimestamp X is not an existing message" if a value is
  rounded or reconstructed (e.g. `Math.floor(µs / 1000) * 1000`).

  Consumers that genuinely need a `Date.now()`-style ms value (agent
  ctxPayload `Timestamp`, host status sinks, activity records) convert
  explicitly at the call site: `Math.floor(message.timestampMicros / 1000)`.
  Keep the conversion inline — a helper would hide the unit boundary, and the
  whole reason this section exists is that the boundary used to be implicit
  and bugs flowed across it.

## Releasing

- Bump `version` in `package.json`.
- Open a PR (never push to `master` directly).
- After merge, the release workflow publishes to npm via OIDC trusted
  publishing — requires Node 24 in CI (ships with npm ≥ 11.5.1).

## Related

- Operator/user docs: `developer-ro-am` repo, `docs/integrations/openclaw.md`.
- Roam API reference: https://api.ro.am/docs.
- OpenClaw plugin SDK: `openclaw/plugin-sdk/*`.
