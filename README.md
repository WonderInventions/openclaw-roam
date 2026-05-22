# @roamhq/openclaw-roam

Official [Roam HQ](https://ro.am) channel plugin for
[OpenClaw](https://github.com/openclaw/openclaw).

Extracted from the in-tree `extensions/roam` plugin per the recommendation in
OpenClaw PR #64066: commercial messaging-service integrations like Roam belong
as standalone plugins on npm rather than in core.

| Plugin id                | npm package              | Channel id |
| ------------------------ | ------------------------ | ---------- |
| `@roamhq/openclaw-roam`  | `@roamhq/openclaw-roam`  | `roam`     |

The **channel id stays `roam`** so existing user configs (`channels.roam.*`)
keep working.

## Install

```bash
openclaw plugin install @roamhq/openclaw-roam
```

## Configure

Create a bot token in **Roam Administration → Developer**, then set it in your
OpenClaw config:

```json5
{
  channels: {
    roam: {
      apiKey: "your-roam-bot-token",
      webhookUrl: "https://your-gateway.example.com/roam-webhook",
      webhookSecret: "whsec_your-signing-key-from-roam-admin",
    },
  },
}
```

For shared-host deployments, point at a file on disk instead of pasting the
secret inline. The file should be mode `0600` and owned by the gateway user;
the plugin reads it at startup and treats it identically to `apiKey`:

```json5
{
  channels: {
    roam: {
      apiKeyFile: "/etc/openclaw/secrets/roam-default.token",
      // ...
    },
  },
}
```

You can also pass the token via the `ROAM_API_KEY` env var (or per-account
`ROAM_API_KEY_<ACCOUNT_ID>`), e.g. when injecting a secret at process-spawn
from a vault.

Start the gateway:

```bash
openclaw gateway run
```

### Group system prompts

Roam groups can add a group-specific system prompt snippet, matching the
Discord channel behavior. The prompt is appended to the agent's normal system
prompt for inbound group turns only.

```yaml
channels:
  roam:
    groupPolicy: allowlist
    groups:
      "*":
        systemPrompt: "Default instructions for Roam group chats."
      "01234567-abcd-4000-8000-000000000000":
        requireMention: false
        systemPrompt: "Use the engineering triage persona in this group."
```

Specific group prompts override the wildcard default. Blank prompts are treated
as unset. `requireMention` is also supported per group and defaults to `true`
when unset.

## Webhooks

Roam delivers inbound messages via webhooks to a local HTTP route (default path:
`/roam-webhook`). Set `webhookUrl` to your gateway's public URL and OpenClaw
auto-subscribes via `webhook.subscribe` on startup.

### Signing

`webhookSecret` is **required**. Roam uses the
[Standard Webhooks](https://www.standardwebhooks.com) scheme; OpenClaw verifies
the `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers on every
request and rejects invalid or stale signatures. Startup fails fast if
`webhookSecret` is unset.

## Streaming

The default delivers replies via `chat.post` + `chat.update` (a "draft" path):
the reply opens with one `chat.post`, then edits in place via repeated
`chat.update` calls (Telegram-style edit-in-place), throttled to ~1 update/sec.
Splits across multiple Roam messages when content crosses the 8 KB byte cap.
This is the recommended path for most operators.

### Native streaming (beta opt-in)

Set `streaming.nativeTransport: true` to switch to Roam's `chat.startStream` /
`chat.appendStream` / `chat.stopStream` lifecycle:

```json5
{
  channels: {
    roam: {
      streaming: { nativeTransport: true },
    },
  },
}
```

What you get:

- **Lower latency to first byte** on the answer, since the server tracks the
  stream rather than each update being a separate request/response.
- **Reasoning rendered as a collapsed "thinking" bubble** (`kind: "thinking"`),
  visually separated from the answer. With native streaming off, reasoning
  content is dropped — `chat.post` has no thought-bubble equivalent.

What stays the same:

- Both lanes (answer + thinking) accept `threadTimestamp`, so threaded
  replies remain threaded under either path.
- If a native send fails mid-stream the plugin falls back to `chat.post` for
  the residual answer; thinking content is dropped.

Disable streaming entirely (no native, no draft edits — single `chat.post`
per reply):

```json5
{ channels: { roam: { streaming: { mode: "off" } } } }
```

## Typing indicator

Pulses `chat.typing` immediately on inbound webhook arrival (before
agent setup), then re-pulses every 2s while the agent runs. Stops on the
first successful send (whether `chat.post` or `chat.startStream`) so the
indicator clears the moment the message appears, not before.

## Access control, multi-account, full reference

See the upstream channel docs for the full configuration reference, multi-
account setup, group policy, and access-control patterns:
<https://github.com/openclaw/openclaw/blob/main/docs/channels/roam.md>

## Compatibility

- Requires `openclaw >= 2026.4.0`.
- Node 20+.
- The plugin targets the public `openclaw/plugin-sdk/*` surface only. See
  [SDK audit](#sdk-audit) below for the small set of helpers that are inlined
  locally because they are not yet on a public SDK subpath.

## Development

```bash
npm install
npm test           # 130 vitest tests, all mocked
npm run typecheck  # tsc --noEmit
```

The test suite is unit tests with `vi.mock` on the SDK barrel and on
`fetchWithSsrFGuard` — no Roam network calls. See
[Testing live against Roam](#testing-live-against-roam-production-apiroam)
for the manual end-to-end checklist before publishing.

## Testing live against Roam (production `api.ro.am`)

Run this checklist against a real Roam workspace before tagging a release.

### Pre-flight

You'll need:

- A Roam workspace where you can create a bot.
- A **bot API key** — Roam Administration → Developer → create key.
- A **webhook signing secret** — same admin panel; required at startup.
- A **public HTTPS URL** that forwards to your gateway (`ngrok http 8080`,
  Cloudflare Tunnel, etc.). The tunnel URL is what you put in `webhookUrl`.
- An OpenClaw checkout/install you can run locally.

### Install the plugin from this checkout

`npm pack` the local tree and install the tarball into your OpenClaw config:

```bash
npm pack
openclaw plugin install ./roamhq-openclaw-roam-0.1.0.tgz
```

For iterative dev, you can also point at the absolute path of this repo
directly (the `index.ts` source loads via OpenClaw's jiti runtime):

```bash
openclaw plugin install /absolute/path/to/openclaw-roam
```

### Minimum working config

```yaml
channels:
  roam:
    apiKey: rk_...                                  # bot API key from Roam admin
    webhookUrl: https://<your-tunnel>/roam-webhook  # public URL → local gateway
    webhookSecret: whsec_...                        # from Roam admin (required)
    dmPolicy: pairing                               # default; safe for testing
```

Add `streaming: { nativeTransport: true }` to test the three-call native
lifecycle (`chat.startStream`/`chat.appendStream`/`chat.stopStream`) instead
of the draft `chat.post`/`chat.update` path.

### Run

```bash
openclaw gateway run
```

On startup, look for these log lines:

- `[default] Roam bot persona: <name> (<id>)` — `token.info` returned the bot
  identity. Without this, self-message filtering is disabled.
- `[default] Roam webhooks subscribed at https://...` — auto-subscription
  succeeded.

If `webhookSecret` is missing you get a fast-fail with
`Roam webhook mode requires a non-empty signing secret.`

### Smoke checklist

1. **DM the bot.** First message produces a pairing challenge (default
   `dmPolicy: pairing`). The challenge message contains the exact
   `openclaw pairing approve roam <code>` command.
2. **Approve the pairing**, then DM again. The reply streams live — you'll
   see one Roam message appear and grow in place as `chat.update` rewrites
   it (~1 update/sec).
3. **Group test.** Add the bot to a group. Default per-group `requireMention:
   true` means a bare message stays silent; mentioning the bot triggers a
   reply. If `groupPolicy` isn't set explicitly, it defaults to `allowlist`
   — add the group to `groups: { "*": {} }` to allow all groups.
4. **Long reply.** Trigger a response longer than 8KB (e.g. ask for a long
   summary). The reply should split into multiple consecutive Roam messages
   at UTF-8-safe boundaries — one open message via `chat.update`, then the
   next opens via `chat.post`.
5. **Self-loop guard.** Confirm the bot does *not* reply to its own
   messages. (Verified by `botIdentity.id` matching the inbound `userId`
   filter.)
6. **Restart.** `Ctrl-C` the gateway. Logs should show
   `webhook.unsubscribe` then re-subscribe on the next `gateway run`.
7. **Uninstall.** `openclaw plugin uninstall @roamhq/openclaw-roam` — runs
   the `logoutAccount` path that clears `apiKey`/`apiKeyFile` from config.

### Multi-account smoke (optional)

Configure two accounts under `channels.roam.accounts:`, each with a distinct
`webhookUrl` (the path differs by account id — `/roam-webhook` for default,
`/roam-webhook-<accountId>` otherwise). Verify both subscribe at startup and
inbound messages route to the right account by `webhookPath`.

### Common gotchas

- **Stale webhook subscription.** If you swap the tunnel URL between runs,
  Roam still has the previous subscription. Shutdown calls
  `webhook.unsubscribe` best-effort, but if the process crashed the old URL
  is orphaned — re-register manually in Roam admin, or just keep the same
  tunnel hostname between runs.
- **Webhook signature 401s.** Verify `webhookSecret` matches what Roam admin
  shows. The `whsec_` prefix is optional (the verifier accepts both forms).
- **Duplicate inbound messages.** The local Roam appserver double-delivers
  webhooks ~50ms apart with distinct `webhook-id`s but identical
  `messageId`. The plugin dedups in-memory for 60s — visible as
  `drop duplicate messageId=...` log lines. Public edge typically does not
  double-deliver.
- **`dmPolicy: open` requires `allowFrom: ["*"]`.** The Zod schema
  `superRefine` rejects `dmPolicy: "open"` without `*` in `allowFrom`.

## SDK audit

This plugin imports only from the **public, non-channel-bundled** subpaths of
the `openclaw` package. The mapping for every symbol the implementation uses is
in [`runtime-api.ts`](./runtime-api.ts):

| Symbol(s)                                                                                                                               | Public subpath                              |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `OpenClawConfig`, `ChannelPlugin`, `AllowlistMatch`, `PluginRuntime`                                                                    | `openclaw/plugin-sdk/core`                  |
| `RuntimeEnv`                                                                                                                            | `openclaw/plugin-sdk/runtime`               |
| `OutboundReplyPayload`, `deliverFormattedTextWithAttachments`, `resolveSendableOutboundReplyParts`                                      | `openclaw/plugin-sdk/reply-payload`         |
| `SecretInput`, `buildSecretInputSchema`, `hasConfiguredSecretInput`, `normalizeResolvedSecretInputString`, `normalizeSecretInputString` | `openclaw/plugin-sdk/secret-input`          |
| `DmPolicy`, `GroupPolicy`, `formatDocsLink`, `WizardPrompter`, `setSetupChannelEnabled`, `applyAccountNameToChannelSection`, ...         | `openclaw/plugin-sdk/setup`                 |
| `createWebhookInFlightLimiter`, `readWebhookBodyOrReject`, `registerWebhookTargetWithPluginRoute`, `resolveWebhookPath`, `withResolvedWebhookRequestPipeline` | `openclaw/plugin-sdk/webhook-ingress` |
| `buildBaseChannelStatusSummary`, `buildRuntimeAccountStatusSnapshot`                                                                    | `openclaw/plugin-sdk/status-helpers`        |
| `DEFAULT_ACCOUNT_ID`, `normalizeAccountId`                                                                                              | `openclaw/plugin-sdk/routing`               |
| `GROUP_POLICY_BLOCKED_LABEL`, `resolveAllowlistProviderRuntimeGroupPolicy`, `resolveDefaultGroupPolicy`, `warnMissingProviderGroupPolicyFallbackOnce` | `openclaw/plugin-sdk/runtime-group-policy` |
| `createChannelPairingController`, `createLoggedPairingApprovalNotifier`, `createPairingPrefixStripper`                                  | `openclaw/plugin-sdk/channel-pairing`       |
| `dispatchInboundReplyWithBase`                                                                                                          | `openclaw/plugin-sdk/inbound-reply-dispatch`|
| `logInboundDrop`                                                                                                                        | `openclaw/plugin-sdk/channel-inbound`       |
| `logTypingFailure`                                                                                                                      | `openclaw/plugin-sdk/channel-feedback`      |
| `readStoreAllowFromForDmPolicy`, `createAllowlistProviderRouteAllowlistWarningCollector`                                                | `openclaw/plugin-sdk/channel-policy`        |
| `resolveChannelPreviewStreamMode`, `resolveChannelStreamingBlockEnabled`, `resolveChannelStreamingNativeTransport`                      | `openclaw/plugin-sdk/channel-streaming`     |
| `ToolPolicySchema`, `ReplyRuntimeConfigSchemaShape`                                                                                     | `openclaw/plugin-sdk/agent-config-primitives` |
| `createAccountListHelpers`                                                                                                              | `openclaw/plugin-sdk/account-helpers`       |
| `resolveAccountWithDefaultFallback`                                                                                                     | `openclaw/plugin-sdk/account-core`          |
| `evaluateMatchedGroupAccessForPolicy`                                                                                                   | `openclaw/plugin-sdk/group-access`          |
| `buildChannelConfigSchema`                                                                                                              | `openclaw/plugin-sdk/channel-plugin-common` |
| `defineChannelPluginEntry`, `defineSetupPluginEntry`, `buildChannelOutboundSessionRoute`                                                | `openclaw/plugin-sdk/core`                  |
| `formatAllowFromLowercase`                                                                                                              | `openclaw/plugin-sdk/allow-from`            |
| `createScopedChannelConfigAdapter`, `createScopedDmSecurityResolver`                                                                    | `openclaw/plugin-sdk/channel-config-helpers`|
| `createAccountStatusSink`                                                                                                               | `openclaw/plugin-sdk/channel-lifecycle`     |
| `createAttachedChannelResultAdapter`                                                                                                    | `openclaw/plugin-sdk/channel-send-result`   |
| `runStoppablePassiveMonitor`, `requireChannelOpenAllowFrom`, `resolveLoggerBackedRuntime`                                               | `openclaw/plugin-sdk/extension-shared`      |
| `MAX_IMAGE_BYTES`, `fetchRemoteMedia`, `saveMediaBuffer`                                                                                | `openclaw/plugin-sdk/media-runtime`         |
| `fetchWithSsrFGuard`                                                                                                                    | `openclaw/plugin-sdk/ssrf-runtime`          |
| `tryReadSecretFileSync`                                                                                                                 | `openclaw/plugin-sdk/infra-runtime`         |
| `createPluginRuntimeStore`                                                                                                              | `openclaw/plugin-sdk/runtime-store`         |

### Inlined locally (`src/_local-shim.ts`)

These symbols are imported by the original in-tree extension via the
bundled-only `openclaw/plugin-sdk/roam` facade and have no public subpath as
of `openclaw@2026.4.24`. They are inlined verbatim from core; if/when the SDK
exposes them, drop the local copy and re-import.

| Symbol                                                                         | Source in core (`openclaw/openclaw`)             | Suggested public subpath                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------- |
| `DmPolicySchema`, `GroupPolicySchema`, `MarkdownConfigSchema`, `requireOpenAllowFrom` | `src/config/zod-schema.core.ts`              | `openclaw/plugin-sdk/channel-config-schema`     |
| `buildChannelKeyCandidates`, `normalizeChannelSlug`, `resolveChannelEntryMatchWithFallback`, `resolveNestedAllowlistDecision` | `src/channels/channel-config.ts` | `openclaw/plugin-sdk/channel-routing` (new) |
| `resolveMentionGatingWithBypass`                                               | `src/channels/mention-gating.ts`                 | `openclaw/plugin-sdk/mention-gating` (new)      |
| `resolveDmGroupAccessWithCommandGate` (thin wrapper around public `resolveDmGroupAccessWithLists`) | `src/security/dm-policy-shared.ts`        | `openclaw/plugin-sdk/channel-policy` (extend)   |
| `clearAccountEntryFields`                                                      | `src/channels/plugins/config-helpers.ts`         | `openclaw/plugin-sdk/channel-config-helpers` (extend) |
| `ChannelGroupContext`, `GroupToolPolicyConfig`, `BlockStreamingCoalesceConfig`, `DmConfig` (types) | `src/channels/plugins/types.public.ts`, `src/config/types.js` | `openclaw/plugin-sdk/setup` or new `types-public` |

### Typing indicator

The plugin drives `chat.typing` directly from `handleRoamInbound`
(see `src/inbound.ts`) rather than through the SDK's `TypingController` —
the published `dispatchInboundReplyWithBase` does not forward the typing
wiring on `replyOptions` to the buffered-block dispatcher in 2026.4.27.
Pulses fire immediately on inbound, every 2s while the agent runs, and
cancel on the first partial reply token.

## Follow-ups to file at `openclaw/openclaw`

Promote the helpers in `src/_local-shim.ts` to public SDK subpaths so
third-party plugins do not have to inline them. Concrete proposal table
above.

## Releasing

Releases are published from CI via GitHub Actions using npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) with
[provenance](https://docs.npmjs.com/generating-provenance-statements) — no
npm tokens are stored anywhere. The workflow runs on the `release: published`
event, gated by the `npm-publish` GitHub Environment, which restricts
publishing to the `master` branch and `v*` tags.

### Cutting a release

1. Ensure `master` is green and your checkout is up to date.
2. Bump the version and tag locally:
   ```bash
   npm version <patch|minor|major>
   git push origin master --follow-tags
   ```
3. On GitHub: **Releases → Draft a new release**, choose the tag you just
   pushed, write release notes, and click **Publish release**.
4. Watch the `release` workflow in **Actions**. It re-runs typecheck and
   tests, verifies that the git tag matches `package.json` version, builds
   the package, and publishes with `npm publish --provenance --access public`.
5. After the run succeeds, verify on
   [npmjs.com/package/@roamhq/openclaw-roam](https://www.npmjs.com/package/@roamhq/openclaw-roam)
   that the new version shows the green provenance badge linking back to
   this repo, the `release.yml` workflow, and the build commit SHA.

### What CI does and does not do

CI publishes. CI does **not** bump versions, generate changelogs, or push
tags — those are local maintainer steps. The `release` workflow publishes
exactly what's in the tagged commit on `master`.

### Rolling back

npm publishes are immutable. Use `npm deprecate` to discourage installs of
a bad version:

```bash
npm deprecate '@roamhq/openclaw-roam@<version>' "<reason>"
```

`npm unpublish` is blocked 72 hours after publish, so deprecate-and-release
is the normal recovery path.

### Troubleshooting

- **Tag/version mismatch.** The verify step fails the run before publish if
  the git tag (e.g. `v0.2.0`) doesn't match the `version` in `package.json`.
  Fix the mismatch, delete the tag, retag, and re-publish the GitHub Release.
- **`ENEEDAUTH` or auth-shaped error during publish.** The npm trusted
  publisher entry is missing or doesn't match the workflow filename /
  environment name. Re-check the package's Trusted Publishers settings.
- **npm CLI too old.** The workflow installs `npm@11` to satisfy the
  `>= 11.5.1` requirement for trusted publishing. If a runner image change
  ever breaks this, pin to a known-good `npm@11`.

## License

MIT. See [LICENSE](./LICENSE).
