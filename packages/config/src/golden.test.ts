import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, saveUserConfig } from "./index.js";

// Golden: what a new user's config.toml looks like. A diff here changes everyone's defaults.
describe("config golden", () => {
  it("default config file", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "ion-golden-")), "config.toml");
    saveUserConfig(f, DEFAULT_CONFIG);
    await expect(readFileSync(f, "utf8")).toMatchFileSnapshot("../golden/default-config.toml");
  });
});
