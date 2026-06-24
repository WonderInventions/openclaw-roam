import pkg from "../package.json" with { type: "json" };

// Plugin version, read straight from package.json so a release only bumps it in
// one place.
export const PLUGIN_VERSION: string = pkg.version;

/**
 * Identifies this client to the Roam appserver by source and version, e.g.
 * `openclaw-roam/0.4.1`. The server parses the leading `name/version` token
 * for logging and Datadog attribution. Requests from older builds (which sent
 * no product User-Agent) arrive as the generic `node` default and are
 * unattributable — i.e. OpenClaw on a version older than this one.
 */
export const ROAM_USER_AGENT = `openclaw-roam/${PLUGIN_VERSION}`;

/**
 * The Roam API version this plugin is built and tested against. Sent as the
 * `Roam-Version` header on every request (and as `version` on webhook.subscribe)
 * so the request/webhook contract is pinned to this plugin release rather than
 * to whenever the API key happened to be created. Bump this deliberately — in
 * lockstep with the parsing code — when adopting newer API shapes.
 */
export const ROAM_API_VERSION = "2026-06-01";
