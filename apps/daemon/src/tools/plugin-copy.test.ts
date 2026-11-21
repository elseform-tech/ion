import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyWithoutHooks } from "./plugin-copy.js";

// Automated review, 2026-11-21: front matter read line by line could be fooled (an indented first line, an escaped
// key like "hoo\x6bs", a linked .md outside the plugin, a file deeper than the scan). ion parses front matter as YAML,
// drops any top-level key that is hooks once unescaped, and walks the plugin itself: a link must stay inside it, and
// anything deeper than the walk is left out.
describe("ion's copy of a plugin", () => {
  const put = (p: string, t: string) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, t);
  };
  function plugin() {
    const home = mkdtempSync(join(tmpdir(), "ion-pcopy-"));
    const root = join(home, "kit");
    put(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit", hooks: "./h.json" }));
    return { home, root };
  }

  it("drops hooks however the front matter writes them, and leaves out what it can't parse", async () => {
    const { home, root } = plugin();
    put(join(root, "skills", "ind", "SKILL.md"), "---\n  name: ind\n  hooks: {}\n---\nI.");
    put(join(root, "skills", "esc", "SKILL.md"), '---\nname: esc\n"hoo\\x6bs": []\n---\nE.');
    put(join(root, "skills", "case", "SKILL.md"), "---\nname: case\nHOOKS: []\n---\nC.");
    put(join(root, "skills", "bad", "SKILL.md"), "---\nname: [unclosed\n---\nB.");
    put(join(root, "skills", "dup", "SKILL.md"), "---\nname: a\nname: b\n---\nD.");
    put(join(root, "skills", "ok", "SKILL.md"), "---\nname: ok\n---\nOK.");
    const lines: string[] = [];
    const to = join(home, "copy");
    await copyWithoutHooks(root, to, "kit", lines);
    const read = (p: string) => readFileSync(join(to, "skills", p, "SKILL.md"), "utf8");
    for (const s of ["ind", "esc", "case"]) {
      expect(read(s)).not.toMatch(/hoo/i);
      expect(read(s)).toContain(`name: ${s}`);
    }
    expect(read("ok")).toBe("---\nname: ok\n---\nOK.");
    for (const s of ["bad", "dup"]) expect(existsSync(join(to, "skills", s, "SKILL.md"))).toBe(false);
    expect(lines.sort()).toEqual([
      "kit: skills/bad/SKILL.md left out (its front matter can't be read)",
      "kit: skills/dup/SKILL.md left out (its front matter can't be read)",
    ]);
    expect(JSON.parse(readFileSync(join(to, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({
      name: "kit",
    });
  });

  it("a link must stay inside the plugin, and markdown deeper than the walk is left out", async () => {
    const { home, root } = plugin();
    put(join(home, "outside.md"), "---\nhooks: {}\n---\nOut.");
    mkdirSync(join(root, "skills", "far"), { recursive: true });
    symlinkSync(join(home, "outside.md"), join(root, "skills", "far", "SKILL.md"));
    put(join(root, "shared", "near.md"), "---\nname: near\nhooks: {}\n---\nNear.");
    mkdirSync(join(root, "skills", "near"), { recursive: true });
    symlinkSync(join(root, "shared", "near.md"), join(root, "skills", "near", "SKILL.md"));
    mkdirSync(join(home, "elsewhere", "x"), { recursive: true });
    put(join(home, "elsewhere", "x", "SKILL.md"), "---\nhooks: {}\n---\nX.");
    symlinkSync(join(home, "elsewhere"), join(root, "agents"));
    put(join(root, "skills", "a", "b", "c", "d", "e", "f", "SKILL.md"), "---\nhooks: {}\n---\nDeep.");
    const lines: string[] = [];
    const to = join(home, "copy");
    await copyWithoutHooks(root, to, "kit", lines);
    expect(existsSync(join(to, "skills", "far", "SKILL.md"))).toBe(false);
    expect(readFileSync(join(to, "skills", "near", "SKILL.md"), "utf8")).not.toMatch(/hooks/);
    expect(existsSync(join(to, "agents"))).toBe(false);
    expect(existsSync(join(to, "skills", "a", "b", "c", "d", "e", "f", "SKILL.md"))).toBe(false);
    expect(lines).toContain("kit: skills/far/SKILL.md left out (it links outside the plugin)");
    expect(lines).toContain("kit: agents left out (it links outside the plugin)");
    expect(lines).toContain("kit: skills/a/b/c/d left out (too deep)");
  });
});
