# OpenClaw webhook contract fixtures (vendored)

These JSON files are vendored from the wonder repo, where the contract is
authored:

    wonder/openclaw-e2e-contract-tests/go/apps/cmd/appserver/testdata/openclaw-fixtures/

Each fixture defines a webhook payload Roam emits plus the API calls a plugin
should make in response. The wonder side runs the contract end-to-end against
a live Roam appserver
(`e2e_openclaw_webhook_contract_test.go::TestE2E_OpenclawWebhookContract`); the
openclaw-roam side runs it as an in-process plugin test
(`src/contract.test.ts`). Same JSON, opposite directions.

**Do not edit locally.** Changes belong in the wonder repo so both sides stay
in sync. When the contract shifts, re-vendor by copying the wonder directory
over the top of this one.

Snapshot taken from wonder SHA `d1df824d103b115d047c6afcc75c8acc13031959`.

See the wonder copy of this README for the schema, placeholder vocabulary, and
how to add a scenario.
