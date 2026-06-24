import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { ROAM_USER_AGENT } from "./version.js";

type GuardedFetchArgs = Parameters<typeof fetchWithSsrFGuard>[0];

/**
 * Single chokepoint for outbound Roam API requests. Wraps the SDK's
 * `fetchWithSsrFGuard` to stamp `User-Agent: openclaw-roam/<version>` on every
 * call, so the appserver can attribute traffic to this plugin and its version
 * in logs and Datadog. Caller-supplied headers win on collision (none set a
 * User-Agent today). Use this for Roam API calls only — third-party fetches
 * (e.g. media downloads) should not advertise our identity.
 */
export function fetchRoamApi(
  args: GuardedFetchArgs,
): ReturnType<typeof fetchWithSsrFGuard> {
  return fetchWithSsrFGuard({
    ...args,
    init: {
      ...args.init,
      headers: {
        "User-Agent": ROAM_USER_AGENT,
        ...(args.init?.headers as Record<string, string> | undefined),
      },
    },
  });
}
