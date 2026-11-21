import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, parseDocument, Scalar, stringify, visit } from "yaml";

/**
 * ion's copy of a Claude Code plugin, built from a whitelist (the user, 2026-11-21: hooks stay ion's; automated reviews,
 * 2026-11-21): for each component (skills, agents, commands), its folders (the default one, whatever its case, and any
 * the manifest names) are walked by ion and written into the default layout; every markdown file is written anew with
 * its front matter parsed as YAML and any top-level `hooks` key dropped; other files are copied from inside the plugin
 * only; the manifest keeps only its name, version and description. Nothing else is carried. Each thing left out is one
 * plain line in `lines`.
 */

const KINDS = ["skills", "agents", "commands"] as const;
/** Folders below a component's folder ion walks (skills/<skill>/<folder>/<folder>); deeper is left out. */
const MAX_DEPTH = 3;
const MARKDOWN = /\.(md|markdown)$/i;

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

/** The front matter's text and the rest; "none" when the file has none; null when it starts one ion can't delimit. */
function split(md: string): { yaml: string; rest: string } | "none" | null {
  const lines = md.replace(/^﻿/, "").split("\n");
  const first = lines[0]?.trimEnd() ?? "";
  if (!first.startsWith("---")) return "none";
  // "--- x" could be front matter to another reader: not guessed at.
  if (first !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === "---" || l.trimEnd() === "..."));
  if (end < 0) return null;
  const yaml = lines.slice(1, end).map((l) => l.replace(/\r$/, ""));
  return { yaml: yaml.join("\n"), rest: lines.slice(end + 1).join("\n") };
}

/**
 * Front matter as data, or null when ion won't read it: a parse error, not a mapping, a key that isn't a plain scalar,
 * a merge key, or any anchor or alias (each could bring hooks back after they're dropped).
 */
function frontMatter(text: string): Record<string, unknown> | null {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  if (doc.contents === null) return {};
  if (!isMap(doc.contents)) return null;
  let tricky = false;
  visit(doc, {
    Alias: () => {
      tricky = true;
      return visit.BREAK;
    },
    Node: (_k, n) => {
      if ((n as { anchor?: string }).anchor) tricky = true;
    },
  });
  const plainKeys = doc.contents.items.every(
    (p) => isScalar(p.key) && p.key.type === Scalar.PLAIN && p.key.value !== "<<",
  );
  if (tricky || !plainKeys) return null;
  const data = doc.toJS() as unknown;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/** A markdown file written anew without any top-level `hooks`; null when its front matter can't be read. */
function withoutHooksKey(md: string): string | null {
  const fm = split(md);
  if (fm === "none") return md.replace(/^﻿/, "");
  if (!fm) return null;
  const data = frontMatter(fm.yaml);
  if (!data) return null;
  const kept = Object.entries(data).filter(([k]) => k.toLowerCase() !== "hooks");
  return `---\n${kept.length ? stringify(Object.fromEntries(kept)) : ""}---\n${fm.rest}`;
}

/** Copies one entry of a component's folder into ion's copy: folders walked, markdown written anew, files copied. */
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
  await mkdir(dirname(dst), { recursive: true, mode: 0o700 });
  if (!MARKDOWN.test(src)) return copyFile(real, dst);
  const text = withoutHooksKey(readFileSync(real, "utf8"));
  if (text === null) return say("its front matter can't be read");
  await writeFile(dst, text, { mode: 0o600 });
}

/** The plugin's manifest (any case of its folder and file), or an empty one. */
function manifestOf(root: string): Record<string, unknown> {
  const find = (dir: string, name: string) => readdirSync(dir).find((n) => n.toLowerCase() === name) ?? null;
  try {
    const folder = find(root, ".claude-plugin");
    const file = folder && find(join(root, folder), "plugin.json");
    if (!folder || !file) return {};
    const m = JSON.parse(readFileSync(join(root, folder, file), "utf8")) as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A component's folders: the default one (whatever its case) and any the manifest names, inside the plugin. */
function foldersOf(root: string, manifest: Record<string, unknown>, kind: string): string[] {
  const named = manifest[kind];
  const given = (Array.isArray(named) ? named : [named]).filter((p): p is string => typeof p === "string");
  const defaults = readdirSync(root)
    .filter((n) => n.toLowerCase() === kind)
    .map((n) => join(root, n));
  return [...new Set([...defaults, ...given.map((p) => resolve(root, p))])];
}

/** Where a component entry goes: a folder becomes the kind's folder; a file goes inside it, by its own name. */
function targetOf(src: string, kindDir: string): string {
  try {
    return statSync(src).isDirectory() ? kindDir : join(kindDir, basename(src));
  } catch {
    return kindDir; // walk says why it's left out
  }
}

/** Writes ion's copy of the plugin at `from` to `to` (see above). */
export async function copyWithoutHooks(
  from: string,
  to: string,
  name: string,
  lines: string[],
): Promise<void> {
  const root = realpathSync(from);
  const manifest = manifestOf(root);
  await mkdir(join(to, ".claude-plugin"), { recursive: true, mode: 0o700 });
  for (const kind of KINDS)
    for (const folder of foldersOf(root, manifest, kind))
      await walk({ root, name, lines }, folder, targetOf(folder, join(to, kind)), 0);
  const kept = Object.fromEntries(
    ["name", "version", "description"]
      .filter((k) => typeof manifest[k] === "string")
      .map((k) => [k, manifest[k]]),
  );
  await writeFile(join(to, ".claude-plugin", "plugin.json"), JSON.stringify(kept), { mode: 0o600 });
}
