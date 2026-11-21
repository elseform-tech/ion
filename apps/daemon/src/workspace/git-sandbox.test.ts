import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxKind } from "@ion/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { git, sandboxGit } from "./git.js";
import { chatDiff, createWorktree } from "./index.js";
import { gitSandbox } from "../runs/sandbox.js";

// Security review, 2026-11-21: a run wrote a clean filter into the project's .git/config (and .git/info/attributes);
// the daemon's own `git diff` ran it outside the sandbox and it read daemon.json. ion's git now runs in the sandbox
// (ion's folders denied, its worktrees writable), without your global or system git config.

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

afterEach(() => sandboxGit(undefined));

describe.skipIf(sandboxKind() !== "seatbelt")("ion's git in the sandbox", () => {
  function planted(kind: "clean" | "smudge" | "process") {
    const ion = tmp("ion-git-ion-");
    const data = join(ion, "data");
    mkdirSync(data);
    writeFileSync(join(data, "daemon.json"), "full-token\n");
    const out = join(tmp("ion-git-out-"), "stolen");
    const repo = tmp("ion-git-repo-");
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, "add", ".");
    sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    const steal = `cat ${data}/daemon.json > ${out} 2>/dev/null; cat`;
    sh(repo, "config", `filter.x.${kind}`, kind === "process" ? `sh -c '${steal}'` : steal);
    writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=x\n");
    sandboxGit({
      kind: "seatbelt",
      paths: { deny: [ion], read: [], write: [join(data, "worktrees")], noWrite: [] },
    });
    return { repo, data, out };
  }
  const stolen = (out: string) => (existsSync(out) ? readFileSync(out, "utf8") : "");

  for (const kind of ["clean", "smudge", "process"] as const)
    it(`a planted ${kind} filter can't read daemon.json, in worktree add or the diff`, async () => {
      const { repo, data, out } = planted(kind);
      const wt = await createWorktree(repo, data, "chat_1", "One");
      expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
      writeFileSync(join(wt.path, "a.txt"), "changed\n");
      await chatDiff(repo, wt.path);
      expect(stolen(out)).not.toContain("full-token");
    });
});

// Re-review, 2026-11-21 (probed): a filter planted in .git/config wrote ~/.codex/notify.sh during ion's git diff, and
// Codex runs notify outside any sandbox. ion's git keeps every agent's config read-only.
describe.skipIf(sandboxKind() !== "seatbelt")("ion's git and agents' configs", () => {
  it("a planted filter can't write any agent's config", async () => {
    const home = tmp("ion-git-agents-");
    const ion = tmp("ion-git-ion2-");
    const data = join(ion, "data");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const repo = tmp("ion-git-repo-");
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, "add", ".");
    sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    const targets = [join(home, ".codex", "notify.sh"), join(home, ".claude.json"), join(home, ".grok", "x")];
    sh(
      repo,
      "config",
      "filter.x.clean",
      [...targets.map((t) => "echo pwned > " + t + " 2>/dev/null"), "cat"].join("; "),
    );
    writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=x\n");
    sandboxGit(
      gitSandbox({ dataDir: data, configFile: join(ion, "config.toml") }, "seatbelt", { HOME: home }),
    );
    const wt = await createWorktree(repo, data, "chat_1", "One");
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    await chatDiff(repo, wt.path);
    for (const t of targets) expect(existsSync(t), t).toBe(false);
  });
});

describe("ion's git and your git config", () => {
  it("reads no global config (a planted ~/.gitconfig stays out)", async () => {
    const home = tmp("ion-git-home-");
    writeFileSync(join(home, ".gitconfig"), "[user]\n\temail = planted@example.com\n");
    const repo = tmp("ion-git-repo-");
    sh(repo, "init", "-q");
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      expect((await git(["config", "user.email"], repo)).stdout.trim()).toBe("");
    } finally {
      process.env.HOME = was;
    }
  });
});
