import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { ROAM_API_VERSION, ROAM_USER_AGENT } from "./version.js";

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
        "Roam-Version": ROAM_API_VERSION,
        ...(args.init?.headers as Record<string, string> | undefined),
      },
    },
  });
}

/** v1 machine-readable auth failure codes (body `{"ok":false,"error":"<code>"}`). */
export const ROAM_ERROR_TOKEN_REVOKED = "token_revoked";
export const ROAM_ERROR_INVALID_TOKEN = "invalid_token";

/**
 * Parse a Roam API error response body. On v1 the body is
 * `{"ok":false,"error":"<code>"}` (code lives in `error`). Older/legacy
 * shapes may put the code in a separate `code` field and a human sentence
 * in `error` — accept both so we stay resilient across versions.
 */
export function parseRoamApiErrorBody(body: string): {
  code?: string;
  message?: string;
} {
  const trimmed = body?.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const errorField = typeof parsed.error === "string" ? parsed.error : undefined;
    const codeField = typeof parsed.code === "string" ? parsed.code : undefined;
    // Prefer explicit `code` when present (v0 dual form). Otherwise treat
    // snake_case `error` values as the machine-readable code (v1 form).
    if (codeField) {
      return { code: codeField, message: errorField };
    }
    if (errorField && /^[a-z][a-z0-9_]*$/.test(errorField)) {
      return { code: errorField };
    }
    if (errorField) {
      return { message: errorField };
    }
    return {};
  } catch {
    return {};
  }
}

/** True when the error code means the token must be discarded (no retry). */
export function isPermanentRoamAuthErrorCode(code: string | undefined): boolean {
  return code === ROAM_ERROR_TOKEN_REVOKED || code === ROAM_ERROR_INVALID_TOKEN;
}

/**
 * Structured Roam API failure. Callers use `code` / `isPermanentAuthFailure`
 * to avoid infinite-retrying revoked or invalid tokens.
 */
export class RoamApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: string;

  constructor(params: {
    status: number;
    code?: string;
    body: string;
    message: string;
  }) {
    super(params.message);
    this.name = "RoamApiError";
    this.status = params.status;
    this.code = params.code;
    this.body = params.body;
  }

  /** Token is permanently unusable — do not retry with the same key. */
  get isPermanentAuthFailure(): boolean {
    return isPermanentRoamAuthErrorCode(this.code);
  }
}

/**
 * Build a `RoamApiError` from an HTTP status + response body text. Maps
 * known v1 codes to clear operator-facing messages; falls back to a
 * status-based message when the body is empty or unrecognized.
 */
export function roamApiErrorFromResponse(params: {
  status: number;
  body: string;
  /** Short verb phrase, e.g. "send", "update", "token.info". */
  action?: string;
}): RoamApiError {
  const { status, body } = params;
  const action = params.action ?? "request";
  const { code, message: bodyMessage } = parseRoamApiErrorBody(body);

  let message: string;
  if (code === ROAM_ERROR_TOKEN_REVOKED) {
    message =
      "Roam: API token revoked (owner archived/deleted or client revoked) — discard this key and create a new one";
  } else if (code === ROAM_ERROR_INVALID_TOKEN) {
    message =
      "Roam: invalid API token — check channels.roam.apiKey / ROAM_API_KEY and create a new key if needed";
  } else if (status === 401) {
    message = bodyMessage
      ? `Roam: authentication failed - ${bodyMessage}`
      : "Roam: authentication failed - check API key";
  } else if (status === 403) {
    message = bodyMessage
      ? `Roam: forbidden - ${bodyMessage}`
      : "Roam: forbidden - bot may not have access to this chat";
  } else if (status === 404) {
    message = bodyMessage
      ? `Roam: not found - ${bodyMessage}`
      : `Roam ${action} failed (404)`;
  } else if (status === 413) {
    message =
      action === "send" || action === "update"
        ? "Roam: message too large (8000 byte limit for blocks)"
        : `Roam ${action} failed (413): payload too large`;
  } else if (status === 400) {
    message = bodyMessage || body
      ? `Roam: bad request - ${bodyMessage || body}`
      : "Roam: bad request - invalid request";
  } else if (code) {
    message = `Roam ${action} failed (${status} ${code})`;
  } else if (body) {
    message = `Roam ${action} failed (${status}): ${body.slice(0, 200)}`;
  } else {
    message = `Roam ${action} failed (${status})`;
  }

  return new RoamApiError({ status, code, body, message });
}
