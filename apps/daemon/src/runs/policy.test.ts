import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { describe, expect, it } from "vitest";
import { decideByPolicy } from "./policy.js";

const project = realpathSync(mkdtempSync(join(tmpdir(), "ion-policy-")));
mkdirSync(join(project, "src"));
// Outside the project and every temp folder (writes to temp folders are allowed): under the package's node_modules.
const cache = fileURLToPath(new URL("../../node_modules/.cache", import.meta.url));
mkdirSync(cache, { recursive: true });
const outside = realpathSync(mkdtempSync(join(cache, "ion-outside-")));
symlinkSync(outside, join(project, "escape"));
const roots = [project];

const req = (kind: string, input: Record<string, unknown>): ApprovalRequest => ({
  requestId: "q",
  toolId: "t",
  toolName: "x",
  kind,
  summary: "s",
  input,
});
const decide = (kind: string, input: Record<string, unknown>) => decideByPolicy(req(kind, input), { roots });

describe("decideByPolicy", () => {
  it("allows reads and searches inside the project, asks about them outside", () => {
    expect(decide("read", { file_path: join(project, "src/a.ts") })).toBe("allow");
    expect(decide("search", { pattern: "foo", path: project })).toBe("allow");
    expect(decide("read", { file_path: "/etc/passwd" })).toBe("ask");
  });

  it("allows edits inside the project and asks about the rest", () => {
    expect(decide("edit", { file_path: join(project, "new.ts") })).toBe("allow");
    expect(decide("edit", { file_path: join(outside, "x.ts") })).toBe("ask");
  });

  // The user, 2026-11-21: agents get the freedom they already have: writes in the project and the system temp folders
  // (Codex's workspace-write, Claude Code's sandbox defaults).
  it("a write to /tmp is allowed", () => {
    const tmp = join("/", "tmp");
    for (const p of [join(tmp, "ion-x.txt"), join("/private", tmp, "ion-x.txt"), join(tmpdir(), "ion-x.txt")])
      expect(decide("edit", { file_path: p }), p).toBe("allow");
    expect(decide("edit", { file_path: "/var/folders/ab/cd1234/T/ion-x.txt" })).toBe("allow");
    expect(decide("edit", { file_path: "/private/var/folders/ab/cd1234/T/x/y.txt" })).toBe("allow");
    // Not the folders around them.
    expect(decide("edit", { file_path: "/var/folders/ab/cd1234/C/x" })).toBe("ask");
    expect(decide("edit", { file_path: "/private/var/db/x" })).toBe("ask");
    expect(decide("edit", { file_path: join("/private", `${tmp}x`, "y") })).toBe("ask");
  });

  it("a write to ~/Documents goes to the judge", () => {
    expect(decide("edit", { file_path: join(homedir(), "Documents/notes.md") })).toBe("ask");
    expect(decide("edit", { file_path: "~/Documents/notes.md" })).toBe("ask");
  });

  it("a link in a temp folder that points elsewhere isn't a temp write", () => {
    const link = join(tmpdir(), `ion-policy-link-${process.pid}`);
    symlinkSync(outside, link);
    expect(decide("edit", { file_path: join(link, "x.ts") })).toBe("ask");
  });

  it("asks about an edit that names no path (fail closed)", () => {
    expect(decide("edit", {})).toBe("ask");
  });

  it("checks every path, including ACP locations", () => {
    expect(decide("edit", { locations: [join(project, "a.ts"), "/etc/hosts"] })).toBe("ask");
    expect(decide("edit", { locations: [join(project, "a.ts")] })).toBe("allow");
  });

  it("resolves symlinks before deciding", () => {
    expect(decide("edit", { file_path: join(project, "escape/x.ts") })).toBe("ask");
    expect(decide("read", { file_path: join(project, "escape/secret") })).toBe("ask");
  });

  it("asks about commands, web and everything else", () => {
    for (const kind of ["command", "web", "mcp", "other"])
      expect(decide(kind, { file_path: join(project, "a") })).toBe("ask");
  });

  it("fails closed for reads that name no path, and finds paths in any *path field", () => {
    expect(decide("read", {})).toBe("ask");
    expect(decide("edit", { filePath: "/etc/hosts" })).toBe("ask");
    expect(decide("edit", { target_path: join(project, "a.ts") })).toBe("allow");
  });

  it("fails closed for searches without a path, and checks ~ paths", () => {
    expect(decide("search", { pattern: "foo" })).toBe("ask");
    expect(decide("read", { file_path: "~/.ssh/id_rsa" })).toBe("ask");
    // (The project is in a temp folder, where writes are free: the climb is shown from a folder that isn't.)
    expect(decide("edit", { file_path: `${outside}/a/../../x.ts` })).toBe("ask");
  });

  // Regression (final review I1): file content and patterns aren't paths.
  it("allows ordinary edits and searches whose content looks like a path", () => {
    expect(decide("edit", { file_path: join(project, "a.ts"), content: "// header\nexport {};" })).toBe(
      "allow",
    );
    expect(
      decide("edit", { file_path: join(project, "a.ts"), old_string: "// TODO", new_string: "// done" }),
    ).toBe("allow");
    expect(decide("search", { pattern: "/api/users", path: project })).toBe("allow");
  });

  // Regression (security review): git internals and agent/tool config can run code; always ask.
  it("asks about edits to git internals and agent config, even inside the worktree", () => {
    for (const f of [
      ".git",
      ".git/config",
      ".gitmodules",
      ".claude/settings.json",
      ".mcp.json",
      ".envrc",
      ".opencode/x.ts",
      "sub/.git/hooks/pre-commit",
    ])
      expect(decide("edit", { file_path: join(project, f) })).toBe("ask");
    expect(decide("read", { file_path: join(project, ".git/config") })).toBe("allow");
    expect(decide("edit", { file_path: join(project, "src/github.ts") })).toBe("allow");
  });

  // Regression (security review): case-insensitive file systems, and every dot-folder or tool config.
  it("asks about such edits whatever their case, in any dot-folder, and for tool config files", () => {
    for (const f of [
      ".GIT/config",
      ".Claude/settings.json",
      ".github/workflows/ci.yml",
      ".devcontainer/x.json",
      ".npmrc",
      ".yarnrc.yml",
      ".pre-commit-config.yaml",
    ])
      expect(decide("edit", { file_path: join(project, f) })).toBe("ask");
    expect(decide("edit", { file_path: join(project, ".gitignore") })).toBe("allow");
  });

  it("judges dot-folders relative to the worktree, not the folders above it", () => {
    const hidden = realpathSync(mkdtempSync(join(tmpdir(), "ion-dot-")));
    mkdirSync(join(hidden, ".ion", "wt"), { recursive: true });
    const wt = join(hidden, ".ion", "wt");
    expect(decideByPolicy(req("edit", { file_path: join(wt, "a.ts") }), { roots: [wt] })).toBe("allow");
  });

  // Final review I4: other path-carrying keys, and a Glob pattern that is itself a path.
  it("checks move destinations and absolute Glob patterns too", () => {
    expect(decide("edit", { locations: [join(project, "a.ts")], destination: "/etc/a.ts" })).toBe("ask");
    expect(
      decideByPolicy(
        { ...req("search", { path: project, pattern: "/Users/x/.ssh/*" }), toolName: "Glob" },
        { roots },
      ),
    ).toBe("ask");
    expect(
      decideByPolicy(
        { ...req("search", { path: project, pattern: "**/*.ts" }), toolName: "Glob" },
        { roots },
      ),
    ).toBe("allow");
    expect(
      decideByPolicy(
        { ...req("search", { path: project, pattern: "/api/users" }), toolName: "Grep" },
        { roots },
      ),
    ).toBe("allow");
  });

  // Security review: a URL isn't a path inside the worktree; braces can hide an absolute Glob path.
  it("asks when a path field holds a URL, or a Glob hides an absolute path in braces", () => {
    expect(decide("read", { source: "https://example.com/x" })).toBe("ask");
    expect(decide("read", { file_path: join(project, "a.ts"), src: "file:///etc/passwd" })).toBe("ask");
    const glob = (pattern: string) =>
      decideByPolicy({ ...req("search", { path: project, pattern }), toolName: "Glob" }, { roots });
    expect(glob("{**/*.ts,/etc/*}")).toBe("ask");
    expect(glob("src/{a,~/x}/*")).toBe("ask");
    expect(glob("@(src|/etc)/*")).toBe("ask");
    expect(glob("+(x|~/y)")).toBe("ask");
    expect(glob("{a,\\/etc/*}")).toBe("ask");
    expect(glob("src/{a,b}/*.ts")).toBe("allow");
    expect(glob("src/@(a|b)/*.ts")).toBe("allow");
  });

  // Security review: only ion's five tools, by exact name, and only when this run was given ion's server.
  it("allows ion's own MCP tools by exact name when the run has ion's server, and asks about anything else", () => {
    const mcp = (toolName: string, mcpServer: string | null, ionMcp = true) =>
      decideByPolicy({ ...req("mcp", {}), toolName, mcpServer }, { roots, ionMcp });
    expect(mcp("mcp__ion__chat_history", "ion")).toBe("allow");
    expect(mcp("ion__search_chats", "ion")).toBe("allow");
    expect(mcp("mcp__ion__chat_history", "ion", false)).toBe("ask");
    expect(mcp("mcp__ion__delete_everything", "ion")).toBe("ask");
    expect(mcp("mcp__github__create_issue", "github")).toBe("ask");
    expect(mcp("Bash", "ion")).toBe("ask");
  });

  it("checks declared path fields however deeply nested", () => {
    expect(decide("edit", { file_path: join(project, "a.ts"), edits: [{ file_path: "/etc/hosts" }] })).toBe(
      "ask",
    );
    expect(decide("edit", { locations: [join(project, "a.ts"), "/etc/hosts"] })).toBe("ask");
  });
});
