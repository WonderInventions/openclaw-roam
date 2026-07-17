import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION, ROAM_API_VERSION, ROAM_USER_AGENT } from "./version.js";

describe("plugin version", () => {
  it("is read from package.json at runtime", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });

  it("advertises source and version in the User-Agent", () => {
    expect(ROAM_USER_AGENT).toBe(`openclaw-roam/${PLUGIN_VERSION}`);
  });

  // Pin on the envelope revision; parser still accepts bare baseline bodies.
  it("pins Roam-Version to the webhook envelope contract", () => {
    expect(ROAM_API_VERSION).toBe("2026-07-07");
  });
});
