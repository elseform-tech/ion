import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyWithoutHooks } from "./plugin-copy.js";

// Automated review, 2026-11-21: front matter read line by line could be fooled (an indented first line, an escaped
// key like "hoo\x6bs", a linked .md outside the plugin, a file deeper than the scan). ion parses front matter as YAML,
// drops any top-level key that is hooks once unescaped, and walks the plugin itself: a link must stay inside it, and
// anything deeper than the walk is left out.
const put = (p: string, t: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, t);
};
function plugin(manifest: Record<string, unknown> = { name: "kit", hooks: "./h.json" }) {
  const home = mkdtempSync(join(tmpdir(), "ion-pcopy-"));
  const root = join(home, "kit");
  put(join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
  return { home, root };
}

describe("ion's copy of a plugin", () => {
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
    for (const s of ["ind", "case"]) {
      expect(read(s)).not.toMatch(/hoo/i);
      expect(read(s)).toContain(`name: ${s}`);
    }
    expect(read("ok")).toBe("---\nname: ok\n---\nOK.");
    // A quoted key isn't a plain one (automated review, 2026-11-21): left out, as is anything unparseable.
    for (const s of ["bad", "dup", "esc"]) expect(existsSync(join(to, "skills", s, "SKILL.md"))).toBe(false);
    expect(lines.sort()).toEqual([
      "kit: skills/bad/SKILL.md left out (its front matter can't be read)",
      "kit: skills/dup/SKILL.md left out (its front matter can't be read)",
      "kit: skills/esc/SKILL.md left out (its front matter can't be read)",
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

// Automated review, 2026-11-21 (again): hooks still came through a folder named "Skills/" or a file "X.MD" on a disk
// that ignores case, a folder the manifest names for a component, and front matter with a BOM, trailing spaces or CRs,
// or "..." to end it. ion's copy is now built from a whitelist: each component's folders (the manifest's and the
// default), every markdown file written anew, other files copied from inside the plugin, nothing else carried.
describe("ion's copy of a plugin, from a whitelist", () => {
  it("walks folders and markdown whatever their case, and the folders the manifest names", async () => {
    const { home, root } = plugin({
      name: "kit",
      version: "2",
      description: "d",
      skills: "./extra",
      hooks: {},
    });
    put(join(root, "Skills", "s", "SKILL.md"), "---\nname: s\nhooks: {}\n---\nS.");
    put(join(root, "agents", "A.MD"), "---\nname: a\nhooks: {}\n---\nA.");
    put(join(root, "commands", "go.markdown"), "---\nhooks: {}\ndescription: go\n---\nGo.");
    put(join(root, "extra", "x", "SKILL.md"), "---\nname: x\nhooks: {}\n---\nX.");
    put(join(root, "extra", "x", "run.sh"), "echo hi");
    put(join(root, "scripts", "evil.sh"), "echo evil");
    put(join(root, "hooks", "hooks.json"), "{}");
    const to = join(home, "copy");
    await copyWithoutHooks(root, to, "kit", []);
    const all = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? all(join(d, e.name)).map((f) => `${e.name}/${f}`) : [e.name],
      );
    expect(all(to).sort()).toEqual([
      ".claude-plugin/plugin.json",
      "agents/A.MD",
      "commands/go.markdown",
      "skills/s/SKILL.md",
      "skills/x/SKILL.md",
      "skills/x/run.sh",
    ]);
    for (const f of ["agents/A.MD", "commands/go.markdown", "skills/s/SKILL.md", "skills/x/SKILL.md"])
      expect(readFileSync(join(to, f), "utf8")).not.toMatch(/hooks/);
    expect(lstatSync(join(to, "skills", "x", "run.sh")).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(to, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({
      name: "kit",
      version: "2",
      description: "d",
    });
  });

  it("reads front matter with a BOM, trailing spaces or CRs, or a ... end; one it can't delimit is left out", async () => {
    const { home, root } = plugin();
    put(join(root, "skills", "bom", "SKILL.md"), "﻿---\nname: bom\nhooks: {}\n---\nB.");
    put(join(root, "skills", "crlf", "SKILL.md"), "---  \r\nname: crlf\r\nhooks: {}\r\n---  \r\nC.");
    put(join(root, "skills", "dots", "SKILL.md"), "---\nname: dots\nhooks: {}\n...\nD.");
    put(join(root, "skills", "open", "SKILL.md"), "---\nname: open\nhooks: {}\nNo end.");
    const lines: string[] = [];
    const to = join(home, "copy");
    await copyWithoutHooks(root, to, "kit", lines);
    for (const s of ["bom", "crlf", "dots"]) {
      const t = readFileSync(join(to, "skills", s, "SKILL.md"), "utf8");
      expect(t).not.toMatch(/hooks/);
      expect(t).toContain(`name: ${s}`);
    }
    expect(existsSync(join(to, "skills", "open", "SKILL.md"))).toBe(false);
    expect(lines).toEqual(["kit: skills/open/SKILL.md left out (its front matter can't be read)"]);
  });
});

// Automated review, 2026-11-21: a merge key or an alias could bring hooks back after they're dropped, and a first line
// like "--- x" could be front matter to Claude Code but not to ion. Both are left out; kept front matter is always
// written again from what was parsed.
describe("front matter ion won't guess at", () => {
  it("leaves out `<<: *h` carrying hooks, any anchor or alias, and a `--- x` first line", async () => {
    const { home, root } = plugin();
    put(join(root, "skills", "merge", "SKILL.md"), "---\nbase: &h\n  hooks: {}\n<<: *h\nname: m\n---\nM.");
    put(join(root, "skills", "alias", "SKILL.md"), "---\nname: &n a\nalso: *n\n---\nA.");
    put(join(root, "skills", "dash", "SKILL.md"), "--- x\nhooks: {}\n---\nX.");
    put(join(root, "skills", "plain", "SKILL.md"), "---\nname:   plain   # a comment\n---\nP.");
    const lines: string[] = [];
    const to = join(home, "copy");
    await copyWithoutHooks(root, to, "kit", lines);
    for (const s of ["merge", "alias", "dash"])
      expect(existsSync(join(to, "skills", s, "SKILL.md"))).toBe(false);
    expect(readFileSync(join(to, "skills", "plain", "SKILL.md"), "utf8")).toBe("---\nname: plain\n---\nP.");
    expect(lines).toHaveLength(3);
  });
});

// Task review, 2026-11-21: a manifest naming a component file ("agents": ["./agents/a.md"]) was copied onto
// `<copy>/agents` itself, clashing with the agents/ folder. A file goes to `<copy>/<kind>/<its name>`.
describe("a manifest that names a component file", () => {
  it("writes the file inside the kind's folder, next to an existing agents/ folder", async () => {
    const { home, root } = plugin({ name: "kit", agents: ["./extra/a.md"] });
    put(join(root, "agents", "b.md"), "---\nname: b\n---\nB.");
    put(join(root, "extra", "a.md"), "---\nname: a\n---\nA.");
    const to = join(home, "copy");
    await copyWithoutHooks(root, to, "kit", []);
    expect(readdirSync(join(to, "agents")).sort()).toEqual(["a.md", "b.md"]);
    expect(readFileSync(join(to, "agents", "a.md"), "utf8")).toContain("A.");
  });
});

// Automated review of 9777e0b, 2026-11-22: a FIFO planted in a plugin blocked the daemon's read, and a file of any size
// was read whole. Only regular files and folders are opened for reading (never blocking on a pipe), and a file over
// 5 MB (or a plugin over 50 MB) is left out with one line.
describe.skipIf(process.platform === "win32")("ion's copy of a plugin, odd files", () => {
  it("leaves out a FIFO without blocking, and a file over the size cap", async () => {
    const { home, root } = plugin({ name: "kit" });
    put(join(root, "skills", "ok", "SKILL.md"), "---\nname: ok\n---\nOK.");
    execFileSync("mkfifo", [join(root, "skills", "ok", "pipe.sh")]);
    put(join(root, "skills", "ok", "big.bin"), "");
    writeFileSync(join(root, "skills", "ok", "big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
    const lines: string[] = [];
    const to = join(home, "copy");
    await copyWithoutHooks(root, to, "kit", lines);
    expect(existsSync(join(to, "skills", "ok", "SKILL.md"))).toBe(true);
    expect(existsSync(join(to, "skills", "ok", "pipe.sh"))).toBe(false);
    expect(existsSync(join(to, "skills", "ok", "big.bin"))).toBe(false);
    expect(lines.some((l) => l.includes("big.bin") && /too big/.test(l))).toBe(true);
  }, 10_000);
});
