import { describe, expect, it, vi } from "vitest";
import {
  fetchRoamApi,
  isPermanentRoamAuthErrorCode,
  parseRoamApiErrorBody,
  roamApiErrorFromResponse,
  ROAM_ERROR_INVALID_TOKEN,
  ROAM_ERROR_TOKEN_REVOKED,
} from "./http.js";
import { ROAM_API_VERSION, ROAM_USER_AGENT } from "./version.js";

const mockFetchWithSsrFGuard = vi.fn(async (_args: unknown) => ({
  response: {},
  finalUrl: "",
  release: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) =>
    mockFetchWithSsrFGuard(args[0] as never),
}));

type CapturedArgs = { url: string; init?: RequestInit; auditContext?: string };

function lastCall(): CapturedArgs {
  return mockFetchWithSsrFGuard.mock.calls.at(-1)![0] as unknown as CapturedArgs;
}

describe("fetchRoamApi", () => {
  it("stamps the User-Agent while preserving caller headers and params", async () => {
    await fetchRoamApi({
      url: "https://api.ro.am/v1/chat.post",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer test-api-key",
          "Content-Type": "application/json",
        },
      },
      auditContext: "roam-chat-post",
    });

    const opts = lastCall();
    const headers = opts.init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(ROAM_USER_AGENT);
    expect(headers["Roam-Version"]).toBe(ROAM_API_VERSION);
    expect(headers.Authorization).toBe("Bearer test-api-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(opts.init?.method).toBe("POST");
    expect(opts.url).toBe("https://api.ro.am/v1/chat.post");
    expect(opts.auditContext).toBe("roam-chat-post");
  });

  it("stamps the User-Agent when the caller sets no headers", async () => {
    await fetchRoamApi({
      url: "https://api.ro.am/v1/token.info",
      init: { method: "GET" },
    });

    const headers = lastCall().init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(ROAM_USER_AGENT);
  });

  it("lets an explicit caller User-Agent win", async () => {
    await fetchRoamApi({
      url: "https://api.ro.am/v1/chat.post",
      init: { headers: { "User-Agent": "custom/9.9.9" } },
    });

    const headers = lastCall().init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("custom/9.9.9");
  });
});

describe("parseRoamApiErrorBody", () => {
  it("reads v1 machine-readable codes from {ok:false,error:<code>}", () => {
    expect(parseRoamApiErrorBody('{"ok":false,"error":"token_revoked"}')).toEqual({
      code: ROAM_ERROR_TOKEN_REVOKED,
    });
    expect(parseRoamApiErrorBody('{"ok":false,"error":"invalid_token"}')).toEqual({
      code: ROAM_ERROR_INVALID_TOKEN,
    });
  });

  it("reads legacy dual-form {error:sentence,code:<code>}", () => {
    expect(
      parseRoamApiErrorBody('{"error":"Token revoked","code":"token_revoked"}'),
    ).toEqual({
      code: ROAM_ERROR_TOKEN_REVOKED,
      message: "Token revoked",
    });
  });

  it("returns empty for non-JSON or empty bodies", () => {
    expect(parseRoamApiErrorBody("")).toEqual({});
    expect(parseRoamApiErrorBody("not json")).toEqual({});
  });
});

describe("roamApiErrorFromResponse", () => {
  it("marks token_revoked and invalid_token as permanent auth failures", () => {
    const revoked = roamApiErrorFromResponse({
      status: 401,
      body: '{"ok":false,"error":"token_revoked"}',
    });
    expect(revoked.code).toBe(ROAM_ERROR_TOKEN_REVOKED);
    expect(revoked.isPermanentAuthFailure).toBe(true);
    expect(revoked.message).toMatch(/token revoked/i);

    const invalid = roamApiErrorFromResponse({
      status: 401,
      body: '{"ok":false,"error":"invalid_token"}',
    });
    expect(invalid.code).toBe(ROAM_ERROR_INVALID_TOKEN);
    expect(invalid.isPermanentAuthFailure).toBe(true);
    expect(invalid.message).toMatch(/invalid API token/i);
  });

  it("does not treat generic 401 as permanent auth failure", () => {
    const err = roamApiErrorFromResponse({ status: 401, body: "" });
    expect(err.isPermanentAuthFailure).toBe(false);
    expect(err.message).toMatch(/authentication failed/i);
  });

  it("isPermanentRoamAuthErrorCode only matches known permanent codes", () => {
    expect(isPermanentRoamAuthErrorCode(ROAM_ERROR_TOKEN_REVOKED)).toBe(true);
    expect(isPermanentRoamAuthErrorCode(ROAM_ERROR_INVALID_TOKEN)).toBe(true);
    expect(isPermanentRoamAuthErrorCode("not_authed")).toBe(false);
    expect(isPermanentRoamAuthErrorCode(undefined)).toBe(false);
  });
});
