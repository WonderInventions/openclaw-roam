import { DEFAULT_ACCOUNT_ID } from "../runtime-api.js";
import { resolveRoamApiKeyFromConfig } from "./accounts.js";
import type { CoreConfig } from "./types.js";

const ROAM_API_KEY_ENV = "ROAM_API_KEY";

/**
 * Convert an account id to its env-var suffix. Mirrors the resolver in
 * accounts.ts so `org-bot` → `ROAM_API_KEY_ORG_BOT`.
 */
function accountEnvSuffix(accountId: string): string {
  return accountId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Inject the account's API key into process.env. The default account writes
 * to `ROAM_API_KEY` (which the Roam skill and most subprocesses read); every
 * account additionally writes `ROAM_API_KEY_<ACCOUNT_ID>` so multi-account
 * setups can scope a subprocess to a specific bot (set the matching env when
 * spawning it). Subprocesses inherit process.env, so anything launched after
 * this point sees the secret without it being re-plumbed.
 *
 * Precedence: a config-defined key wins over any pre-existing env value, so
 * channels.roam.accounts.<id>.apiKey is the single source of truth.
 *
 * Returns a restore function; callers should invoke it on shutdown to put the
 * environment back to whatever the process started with.
 */
export function exportRoamApiKeyToEnv(params: {
  cfg: CoreConfig;
  accountId: string;
  log?: { info?: (message: string) => void };
}): () => void {
  const resolved = resolveRoamApiKeyFromConfig(params.cfg, { accountId: params.accountId });
  if (resolved.source === "none") {
    return () => {};
  }

  // Write the per-account env var for every account; additionally write the
  // bare ROAM_API_KEY for the default account so existing single-bot setups
  // (and skills that only know the bare name) keep working.
  const targets: string[] = [`ROAM_API_KEY_${accountEnvSuffix(params.accountId)}`];
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    targets.push(ROAM_API_KEY_ENV);
  }

  const previous = new Map<string, string | undefined>();
  for (const envName of targets) {
    previous.set(envName, process.env[envName]);
    if (process.env[envName] !== resolved.apiKey) {
      process.env[envName] = resolved.apiKey;
      params.log?.info?.(`[${params.accountId}] exported ${envName} from ${resolved.source}`);
    }
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [envName, before] of previous) {
      if (process.env[envName] !== resolved.apiKey) continue;
      if (before === undefined) delete process.env[envName];
      else process.env[envName] = before;
    }
  };
}
