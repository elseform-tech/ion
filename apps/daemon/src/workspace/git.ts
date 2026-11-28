import { execFile } from "node:child_process";
import { type RunSandbox, sandboxed, whichOnPath } from "@ion/adapter-kit";

export type GitResult = { code: number; stdout: string; stderr: string };

let gitPath: string | null = null;
const resolveGit = (): string => {
  gitPath ??= whichOnPath("git");
  if (!gitPath) throw new Error("git isn't installed");
  return gitPath;
};

let box: RunSandbox | undefined;

/**
 * The sandbox ion's own git runs in (security review, 2026-11-21: a filter a run planted in the project's
 * .git/config ran in the daemon's `git diff`, outside the sandbox, and read daemon.json): ion's folders denied, its
 * worktrees writable. Set once at the daemon's start; none where the computer has no sandbox.
 */
export function sandboxGit(sb: RunSandbox | undefined): void {
  box = sb;
}

/**
 * Only what git needs; nothing like GIT_DIR, GIT_SSH_COMMAND or tokens leaks in from the daemon. No global or system
 * config either (a run can write ~/.gitconfig), except for a repo ion has just made for you (`yours`: its identity).
 */
function gitEnv(yours = false): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    ...(yours ? {} : { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
  };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/** The empty tree, in each of git's object formats (SHA-1, SHA-256). */
const EMPTY_TREES = [
  "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
];

/**
 * A worktree's git folder ion checked (its own, for that worktree) and the worktree: what a read runs on. `quiet`:
 * every filter the repo's config names, turned off (`-c filter.<name>.clean=` and the rest).
 */
export type ReadAt = { gitDir: string; commonDir: string; workTree: string; quiet: string[] };

let version: Promise<boolean> | null = null;

/**
 * Whether this git keeps a worktree's attributes out of ion's reads (GIT_ATTR_SOURCE, git 2.40 and later); an older
 * one would read them without a word (automated scan, 2026-11-28). Asked once.
 */
export function readsSafely(): Promise<boolean> {
  version ??= gitOnce(["--version"], process.cwd(), {}).then((r) => {
    const m = /^git version (\d{1,4})\.(\d{1,4})/.exec(r.stdout);
    return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 40));
  });
  return version;
}

/**
 * Runs git without a shell, without prompting, with a minimal environment and with the repo's hooks turned off:
 * a cloned repo's hooks must never run code when ion makes or removes a worktree. `read`: a read of a chat's
 * worktree, through the git folder ion checked, with no attributes from the worktree or any attributes file (security
 * review and automated scan, 2026-11-28: a chat's `.gitattributes` named a filter its planted git config ran in
 * ion's diff); refused on a git that can't keep them out.
 */
export async function git(
  args: string[],
  cwd: string,
  o: {
    yours?: boolean;
    input?: string;
    read?: ReadAt;
    plumbing?: boolean;
    /** The one worktree a call that writes may write in ion's folders (none: nothing there). */
    writes?: string;
    /**
     * A folder of ion's it may read (ion's worktrees folder, for `worktree prune`: one it can't see is forgotten;
     * full check, 2026-11-28).
     */
    sees?: string;
    env?: Record<string, string>;
  } = {},
): Promise<GitResult> {
  const read = o.read;
  if (!read) return gitOnce(args, cwd, o);
  // `plumbing`: a read that reads no attributes (rev-parse, config), fine on any git.
  if (!o.plumbing && !(await readsSafely()))
    return { code: -1, stdout: "", stderr: "git 2.40 or later is needed" };
  // No attributes from the system's file nor the project's info/attributes either, and no filter they could name
  // (security re-review, 2026-11-28, N3); no external diff or pager; no lock or index refresh; in a sandbox where
  // nothing can be written.
  const at = [
    ...["-c", "core.attributesFile=/dev/null", "-c", "diff.external=", "-c", "core.pager=cat"],
    ...read.quiet,
    ...args,
  ];
  let r: GitResult = { code: -1, stdout: "", stderr: "" };
  for (const tree of EMPTY_TREES) {
    const env = {
      ...{ GIT_DIR: read.gitDir, GIT_COMMON_DIR: read.commonDir, GIT_WORK_TREE: read.workTree },
      GIT_ATTR_SOURCE: tree,
      ...{ GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
    };
    r = await gitOnce(at, cwd, { ...o, env, readOnly: read.workTree });
    // The other object format's empty tree: a SHA-256 repo has no SHA-1 one.
    if (!(r.code === 128 && r.stderr.includes("attr-source"))) return r;
  }
  return r;
}

/**
 * The sandbox one git call runs in: a read, read-only on its one worktree; a call that writes, its one worktree
 * writable and nothing else of ion's (security re-review 2, 2026-11-28: a filter planted in the project's git ran in
 * `git worktree add` with every chat's worktree writable); a call in the project, nothing of ion's.
 */
export function callBox(
  sb: RunSandbox | undefined,
  o: { readOnly?: string; writes?: string; sees?: string },
): RunSandbox | undefined {
  if (!sb) return sb;
  if (o.readOnly) return { ...sb, paths: { ...sb.paths, read: [o.readOnly], write: [], readOnly: true } };
  const read = o.sees ? [...sb.paths.read, o.sees] : sb.paths.read;
  return { ...sb, paths: { ...sb.paths, read, write: o.writes ? [o.writes] : [] } };
}

function gitOnce(
  args: string[],
  cwd: string,
  o: {
    yours?: boolean;
    input?: string;
    env?: Record<string, string>;
    readOnly?: string;
    writes?: string;
    sees?: string;
  },
): Promise<GitResult> {
  const run = sandboxed(callBox(box, o), resolveGit(), [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    ...args,
  ]);
  return new Promise((resolve) => {
    const child = execFile(
      run.command,
      run.args,
      // Diffs can be large: Node's 1 MB default would cut them off silently.
      {
        cwd,
        env: { ...gitEnv(o.yours), ...o.env },
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        // git's own exit code; -1 when git didn't finish (couldn't start, timed out, output too large).
        let code = 0;
        if (err) code = typeof err.code === "number" ? err.code : -1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    // What git reads on stdin (a pathspec file), when there is one. A git that ended early can't break ion (EPIPE:
    // pnpm check, 2026-11-23, when every git call wrote to its stdin).
    if (o.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(o.input);
    }
  });
}
