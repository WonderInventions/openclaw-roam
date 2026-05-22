import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportRoamApiKeyToEnv } from "./env-export.js";
import type { CoreConfig } from "./types.js";

const { mockResolveRoamApiKeyFromConfig } = vi.hoisted(() => ({
  mockResolveRoamApiKeyFromConfig: vi.fn(),
}));

vi.mock("./accounts.js", () => ({
  resolveRoamApiKeyFromConfig: mockResolveRoamApiKeyFromConfig,
}));

vi.mock("../runtime-api.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
}));

describe("exportRoamApiKeyToEnv", () => {
  const cfg = {} as CoreConfig;
  let originalEnv: string | undefined;
  const stragglers = [
    "ROAM_API_KEY_DEFAULT",
    "ROAM_API_KEY_ALICE",
    "ROAM_API_KEY_ORG_BOT",
  ] as const;

  beforeEach(() => {
    originalEnv = process.env.ROAM_API_KEY;
    delete process.env.ROAM_API_KEY;
    for (const name of stragglers) delete process.env[name];
    mockResolveRoamApiKeyFromConfig.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ROAM_API_KEY;
    } else {
      process.env.ROAM_API_KEY = originalEnv;
    }
    for (const name of stragglers) delete process.env[name];
  });

  it("injects config-resolved key when env is unset", () => {
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "from-config", source: "config" });

    const restore = exportRoamApiKeyToEnv({ cfg, accountId: "default" });

    expect(process.env.ROAM_API_KEY).toBe("from-config");

    restore();
    expect(process.env.ROAM_API_KEY).toBeUndefined();
  });

  it("overrides a pre-existing env value with the config-resolved key", () => {
    process.env.ROAM_API_KEY = "from-env";
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "from-config", source: "config" });

    const restore = exportRoamApiKeyToEnv({ cfg, accountId: "default" });

    expect(process.env.ROAM_API_KEY).toBe("from-config");

    restore();
    expect(process.env.ROAM_API_KEY).toBe("from-env");
  });

  it("does nothing when config has no api key", () => {
    process.env.ROAM_API_KEY = "from-env";
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "", source: "none" });

    const restore = exportRoamApiKeyToEnv({ cfg, accountId: "default" });

    expect(process.env.ROAM_API_KEY).toBe("from-env");

    restore();
    expect(process.env.ROAM_API_KEY).toBe("from-env");
  });

  it("exports a per-account env var without touching the bare ROAM_API_KEY for non-default accounts", () => {
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "alice-key", source: "config" });

    const restore = exportRoamApiKeyToEnv({ cfg, accountId: "alice" });

    // Per-account variable IS set so subprocesses bound to `alice` can find it.
    expect(process.env.ROAM_API_KEY_ALICE).toBe("alice-key");
    // The shared name stays untouched so it doesn't override the default
    // account's token (or whatever the operator already had set there).
    expect(process.env.ROAM_API_KEY).toBeUndefined();

    restore();
    expect(process.env.ROAM_API_KEY_ALICE).toBeUndefined();
  });

  it("maps account ids with hyphens to underscored env names", () => {
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "k", source: "config" });
    const restore = exportRoamApiKeyToEnv({ cfg, accountId: "org-bot" });
    expect(process.env.ROAM_API_KEY_ORG_BOT).toBe("k");
    restore();
    expect(process.env.ROAM_API_KEY_ORG_BOT).toBeUndefined();
  });

  it("writes both bare and per-account env for the default account", () => {
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "default-key", source: "config" });
    const restore = exportRoamApiKeyToEnv({ cfg, accountId: "default" });
    expect(process.env.ROAM_API_KEY).toBe("default-key");
    expect(process.env.ROAM_API_KEY_DEFAULT).toBe("default-key");
    restore();
  });

  it("is a no-op when env already matches the resolved key", () => {
    process.env.ROAM_API_KEY = "same-key";
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "same-key", source: "config" });

    const restore = exportRoamApiKeyToEnv({ cfg, accountId: "default" });

    expect(process.env.ROAM_API_KEY).toBe("same-key");

    restore();
    expect(process.env.ROAM_API_KEY).toBe("same-key");
  });

  it("leaves the env alone on restore if something else overwrote our injected value", () => {
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "from-config", source: "config" });

    const restore = exportRoamApiKeyToEnv({ cfg, accountId: "default" });
    process.env.ROAM_API_KEY = "third-party";

    restore();
    expect(process.env.ROAM_API_KEY).toBe("third-party");
  });

  it("logs the export source when injecting", () => {
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "k", source: "secretFile" });
    const info = vi.fn();

    exportRoamApiKeyToEnv({ cfg, accountId: "default", log: { info } });

    expect(info).toHaveBeenCalledWith("[default] exported ROAM_API_KEY from secretFile");
  });

  it("restore is idempotent", () => {
    mockResolveRoamApiKeyFromConfig.mockReturnValue({ apiKey: "from-config", source: "config" });

    const restore = exportRoamApiKeyToEnv({ cfg, accountId: "default" });
    restore();
    process.env.ROAM_API_KEY = "later-set";
    restore();
    expect(process.env.ROAM_API_KEY).toBe("later-set");
  });
});
