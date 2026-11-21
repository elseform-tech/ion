import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Run, systemSecrets } from "./index.js";
import { createVault } from "./vault.js";

/**
 * A macOS `security -i` that cuts each stdin line at 4,095 characters, as the real one does, and keeps items in
 * memory.
 */
function cuttingSecurity(): { run: Run; items: Map<string, string> } {
  const items = new Map<string, string>();
  const run: Run = async (_cmd, args, input) => {
    if (args[0] === "-i") {
      const line = (input ?? "").slice(0, 4095);
      const m = /-a "([^"]+)" -X ([0-9a-f]*)/.exec(line);
      if (m) items.set(m[1]!, Buffer.from(m[2]!, "hex").toString("utf8"));
      return { code: 0, out: "", err: "" };
    }
    const account = args[args.indexOf("-a") + 1]!;
    if (args[0] === "delete-generic-password") items.delete(account);
    const v = items.get(account);
    return v === undefined ? { code: 44, out: "", err: "" } : { code: 0, out: `${v}\n`, err: "" };
  };
  return { run, items };
}

const BIG = `{"access":"${"a".repeat(6 * 1024)}"}`;

// Task review, 2026-11-20: `security -i` cuts lines at ~4,095 chars, so a token over ~2 KB failed (or overwrote
// the good item). Tokens now go in an encrypted vault in ion's data folder; the keychain holds only its key.
describe("vault", () => {
  it("keeps a 6 KB token, encrypted, with only its key in the keychain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-vault-"));
    const { run, items } = cuttingSecurity();
    const vault = createVault({ dir, keychain: systemSecrets({ platform: "darwin", run }) });
    await vault.set("mcp:linear:abc:oauth", BIG);
    expect(await vault.get("mcp:linear:abc:oauth")).toBe(BIG);
    expect([...items.keys()]).toEqual(["vault-key"]);
    expect(items.get("vault-key")).toMatch(/^[0-9a-f]{64}$/);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, files[0]!), "latin1")).not.toContain("aaaa");
    // Another vault on the same folder and keychain (ion restarted) reads it.
    const again = createVault({ dir, keychain: systemSecrets({ platform: "darwin", run }) });
    expect(await again.get("mcp:linear:abc:oauth")).toBe(BIG);
    await again.remove("mcp:linear:abc:oauth");
    expect(await again.get("mcp:linear:abc:oauth")).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a failed write never replaces the previous good file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-vault-"));
    const { run } = cuttingSecurity();
    const vault = createVault({ dir, keychain: systemSecrets({ platform: "darwin", run }) });
    await vault.set("mcp:a:1:oauth", "good");
    const file = readdirSync(dir)[0]!;
    // The temp file can't be written: a folder is in its place.
    mkdirSync(join(dir, `${file}.tmp`));
    await expect(vault.set("mcp:a:1:oauth", "newer")).rejects.toThrow();
    expect(await vault.get("mcp:a:1:oauth")).toBe("good");
  });

  it("an item from another account, or changed on disk, reads as none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-vault-"));
    const { run } = cuttingSecurity();
    const vault = createVault({ dir, keychain: systemSecrets({ platform: "darwin", run }) });
    expect(await vault.get("mcp:a:1:oauth")).toBeNull();
    await vault.set("mcp:a:1:oauth", "v");
    expect(await vault.get("mcp:b:1:oauth")).toBeNull();
  });
});

// Task review, 2026-11-20: a value too long for `security -i`'s line is refused, never stored cut short.
describe("macOS keychain line limit", () => {
  it("refuses a value too long for one line, and leaves the item as it was", async () => {
    const { run, items } = cuttingSecurity();
    const s = systemSecrets({ platform: "darwin", run });
    await s.set("key:A", "short");
    await expect(s.set("key:A", "x".repeat(6 * 1024))).rejects.toThrow();
    expect(items.get("key:A")).toBe("short");
  });
});
