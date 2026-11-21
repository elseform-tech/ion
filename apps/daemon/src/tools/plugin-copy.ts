import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";

/**
 * ion's copy of a Claude Code plugin without hooks (the user, 2026-11-21: hooks stay ion's): its own `hooks/` and the
 * manifest's `hooks` left out, and every skill's, subagent's and command's front matter without a `hooks` key. Automated
 * review, 2026-11-21: front matter is parsed as YAML (a key is judged after YAML's own unescaping), and ion walks
 * those folders itself: a link must stay inside the plugin, anything deeper than the walk is left out, and a file whose
 * front matter can't be parsed is left out. Each thing left out is one plain line in `lines`.
 */

/** The folders whose markdown can carry front matter Claude Code reads. */
const KINDS = new Set(["skills", "agents", "commands"]);
/** Folders below a kind's folder ion walks (skills/<skill>/<folder>/<folder>); deeper is left out. */
const MAX_DEPTH = 3;

type Walk = { root: string; name: string; lines: string[] };

/** A path's real place when it's inside the plugin (links followed), else null. */
function inside(root: string, path: string): string | null {
  try {
    const real = realpathSync(path);
    return real === root || real.startsWith(`${root}${sep}`) ? real : null;
  } catch {
    return null;
  }
}

/** The front matter's text and the rest, or null when there's none (the file is as it is). */
function split(md: string): { yaml: string; rest: string } | null {
  const lines = md.split("\n");
  if (lines[0]?.replace(/\r$/, "") !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, "") === "---");
  if (end < 0) return null;
  return { yaml: lines.slice(1, end).join("\n"), rest: lines.slice(end + 1).join("\n") };
}

/** A markdown file without any top-level `hooks` key in its front matter; null when the front matter can't be read. */
function withoutHooksKey(md: string): string | null {
  const fm = split(md);
  if (!fm) return md;
  let data: unknown;
  try {
    // yaml's defaults: the core schema, no custom tags, duplicate keys refused, aliases capped.
    data = parse(fm.yaml);
  } catch {
    return null;
  }
  if (data === null || data === undefined) return md;
  if (typeof data !== "object" || Array.isArray(data)) return null;
  const kept = Object.entries(data as Record<string, unknown>).filter(([k]) => k.toLowerCase() !== "hooks");
  if (kept.length === Object.keys(data).length) return md;
  return `---\n${kept.length ? stringify(Object.fromEntries(kept)) : ""}---\n${fm.rest}`;
}

/** Copies one entry under a kind's folder: folders walked, markdown checked, other files linked. */
async function walk(w: Walk, src: string, dst: string, depth: number): Promise<void> {
  const rel = relative(w.root, src) || src;
  const say = (why: string) => {
    w.lines.push(`${w.name}: ${rel} left out (${why})`);
  };
  const real = inside(w.root, src);
  if (!real) return say("it links outside the plugin");
  const st = statSync(real);
  if (st.isDirectory()) {
    if (depth > MAX_DEPTH) return say("too deep");
    await mkdir(dst, { recursive: true, mode: 0o700 });
    for (const n of await readdir(real)) await walk(w, join(src, n), join(dst, n), depth + 1);
    return;
  }
  if (!st.isFile()) return;
  if (!src.endsWith(".md")) return symlink(real, dst);
  const text = withoutHooksKey(readFileSync(real, "utf8"));
  if (text === null) return say("its front matter can't be read");
  await writeFile(dst, text, { mode: 0o600 });
}

/** Writes ion's copy of the plugin at `from` to `to` (see above). */
export async function copyWithoutHooks(
  from: string,
  to: string,
  name: string,
  lines: string[],
): Promise<void> {
  const root = realpathSync(from);
  await mkdir(join(to, ".claude-plugin"), { recursive: true, mode: 0o700 });
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.name === "hooks" || e.name === ".claude-plugin") continue;
    const src = join(root, e.name);
    if (KINDS.has(e.name)) await walk({ root, name, lines }, src, join(to, e.name), 0);
    else await symlink(src, join(to, e.name));
  }
  let manifest: Record<string, unknown> = {};
  try {
    const m = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as unknown;
    if (m && typeof m === "object" && !Array.isArray(m)) manifest = m as Record<string, unknown>;
  } catch {
    // no manifest: an empty one
  }
  delete manifest.hooks;
  delete manifest.mcpServers;
  await writeFile(join(to, ".claude-plugin", "plugin.json"), JSON.stringify(manifest), { mode: 0o600 });
}

/** Whether a plugin needs ion's copy: it has hooks of its own, or folders whose front matter could carry some. */
export function needsCopy(from: string, hooks: boolean): boolean {
  if (hooks) return true;
  try {
    return [...KINDS].some((k) => statSync(join(from, k), { throwIfNoEntry: false }) !== undefined);
  } catch {
    return true;
  }
}
