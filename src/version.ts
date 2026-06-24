// Plugin version and the User-Agent advertised on every outbound Roam API
// request. Kept in sync with package.json by version.test.ts — bump both
// together when releasing.
export const PLUGIN_VERSION = "0.4.1";

/**
 * Identifies this client to the Roam appserver by source and version, e.g.
 * `openclaw-roam/0.4.1`. The server parses the leading `name/version` token
 * for logging and Datadog attribution. Requests from older builds (which sent
 * no product User-Agent) arrive as the generic `node` default and are
 * unattributable — i.e. OpenClaw on a version older than this one.
 */
export const ROAM_USER_AGENT = `openclaw-roam/${PLUGIN_VERSION}`;
