import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRoamAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("resolveRoamAccount — apiKey env-var precedence", () => {
  let originalDefault: string | undefined;
  let originalOrg: string | undefined;

  beforeEach(() => {
    originalDefault = process.env.ROAM_API_KEY;
    originalOrg = process.env.ROAM_API_KEY_ORG;
    delete process.env.ROAM_API_KEY;
    delete process.env.ROAM_API_KEY_ORG;
  });

  afterEach(() => {
    if (originalDefault === undefined) delete process.env.ROAM_API_KEY;
    else process.env.ROAM_API_KEY = originalDefault;
    if (originalOrg === undefined) delete process.env.ROAM_API_KEY_ORG;
    else process.env.ROAM_API_KEY_ORG = originalOrg;
  });

  const cfg: CoreConfig = {
    channels: {
      roam: {
        accounts: {
          default: { apiKey: "config-default-key" },
          org: { apiKey: "config-org-key" },
        },
      },
    },
  };

  it("ROAM_API_KEY_<ACCOUNT> takes precedence over config for that account", () => {
    process.env.ROAM_API_KEY_ORG = "env-org-key";
    const account = resolveRoamAccount({ cfg, accountId: "org" });
    expect(account.apiKey).toBe("env-org-key");
    expect(account.apiKeySource).toBe("env");
  });

  it("ROAM_API_KEY_<ACCOUNT> does not affect a different account", () => {
    process.env.ROAM_API_KEY_ORG = "env-org-key";
    const def = resolveRoamAccount({ cfg, accountId: "default" });
    expect(def.apiKey).toBe("config-default-key");
    expect(def.apiKeySource).toBe("config");
  });

  it("ROAM_API_KEY (bare) only applies to the default account", () => {
    process.env.ROAM_API_KEY = "env-default-key";
    const def = resolveRoamAccount({ cfg, accountId: "default" });
    expect(def.apiKey).toBe("env-default-key");
    expect(def.apiKeySource).toBe("env");

    const org = resolveRoamAccount({ cfg, accountId: "org" });
    expect(org.apiKey).toBe("config-org-key");
    expect(org.apiKeySource).toBe("config");
  });

  it("per-account env beats bare env when both are set for default", () => {
    process.env.ROAM_API_KEY = "env-default-bare";
    // ROAM_API_KEY_DEFAULT shouldn't be common but should win if set.
    process.env.ROAM_API_KEY_DEFAULT = "env-default-specific";
    try {
      const account = resolveRoamAccount({ cfg, accountId: "default" });
      expect(account.apiKey).toBe("env-default-specific");
    } finally {
      delete process.env.ROAM_API_KEY_DEFAULT;
    }
  });

  it("falls back to config when no env vars are set", () => {
    const account = resolveRoamAccount({ cfg, accountId: "org" });
    expect(account.apiKey).toBe("config-org-key");
    expect(account.apiKeySource).toBe("config");
  });

  it("account ids with hyphens map to underscored env names", () => {
    process.env["ROAM_API_KEY_ORG_BOT"] = "env-org-bot-key";
    try {
      const cfgHyphen: CoreConfig = {
        channels: {
          roam: { accounts: { "org-bot": { apiKey: "config-fallback" } } },
        },
      };
      const account = resolveRoamAccount({ cfg: cfgHyphen, accountId: "org-bot" });
      expect(account.apiKey).toBe("env-org-bot-key");
      expect(account.apiKeySource).toBe("env");
    } finally {
      delete process.env["ROAM_API_KEY_ORG_BOT"];
    }
  });
});
