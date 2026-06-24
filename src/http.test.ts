import { describe, expect, it, vi } from "vitest";
import { fetchRoamApi } from "./http.js";
import { ROAM_USER_AGENT } from "./version.js";

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
