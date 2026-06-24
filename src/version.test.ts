import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION, ROAM_USER_AGENT } from "./version.js";

describe("plugin version", () => {
  it("stays in sync with package.json (bump both together)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });

  it("advertises source and version in the User-Agent", () => {
    expect(ROAM_USER_AGENT).toBe(`openclaw-roam/${PLUGIN_VERSION}`);
  });
});
