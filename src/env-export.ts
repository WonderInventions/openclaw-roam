import { DEFAULT_ACCOUNT_ID } from "../runtime-api.js";
import { resolveRoamApiKeyFromConfig } from "./accounts.js";
import type { CoreConfig } from "./types.js";

const ROAM_API_KEY_ENV = "ROAM_API_KEY";

/**
 * Inject ROAM_API_KEY into process.env from the default account's configured
 * apiKey (apiKeyFile or inline). Subprocesses inherit process.env, so any
 * skills/exec/MCP-bridged commands started after this point can call the Roam
 * API without re-plumbing the secret.
 *
 * Precedence: a config-defined key wins over any pre-existing env value, so
 * channels.roam.apiKey is the single source of truth. Non-default accounts are
 * skipped because ROAM_API_KEY is a single shared name.
 *
 * Returns a restore function; callers should invoke it on shutdown to put the
 * environment back to whatever the process started with.
 */
export function exportRoamApiKeyToEnv(params: {
  cfg: CoreConfig;
  accountId: string;
  log?: { info?: (message: string) => void };
}): () => void {
  if (params.accountId !== DEFAULT_ACCOUNT_ID) {
    return () => {};
  }

  const resolved = resolveRoamApiKeyFromConfig(params.cfg, { accountId: params.accountId });
  if (resolved.source === "none") {
    return () => {};
  }

  const previous = process.env[ROAM_API_KEY_ENV];
  if (previous === resolved.apiKey) {
    return () => {};
  }

  process.env[ROAM_API_KEY_ENV] = resolved.apiKey;
  params.log?.info?.(`[${params.accountId}] exported ${ROAM_API_KEY_ENV} from ${resolved.source}`);

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (process.env[ROAM_API_KEY_ENV] !== resolved.apiKey) {
      return;
    }
    if (previous === undefined) {
      delete process.env[ROAM_API_KEY_ENV];
    } else {
      process.env[ROAM_API_KEY_ENV] = previous;
    }
  };
}
