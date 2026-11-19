/** One line of the lab's .code: a hunk header, context, an addition or a deletion, with its line number. */
export type DiffLine = { kind: "h" | "ctx" | "add" | "del"; n: string; sign: string; text: string };

/** A patch line's place in the lab's .code, given the numbers so far (null: not shown). */
function bodyLine(line: string, at: { old: number; new: number }): DiffLine | null {
  const text = line.slice(1);
  switch (line[0]) {
    case "+":
      return { kind: "add", n: String(at.new++), sign: "+", text };
    case "-":
      return { kind: "del", n: String(at.old++), sign: "−", text };
    case " ":
      at.old++;
      return { kind: "ctx", n: String(at.new++), sign: "", text };
    case "\\":
      return { kind: "h", n: "", sign: "", text: line };
    default:
      return null;
  }
}

/**
 * A patch as numbered lines: deletions keep their old number, additions and context the new one. File headers are
 * read only before a file's first hunk; inside a hunk every line is shown by its first character, so a changed line
 * that looks like a header ("+++ x" is an added "++ x") is never hidden.
 */
export function diffLines(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  const at = { old: 0, new: 0 };
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      inHunk = true;
      at.old = Number(hunk[1]);
      at.new = Number(hunk[2]);
      out.push({ kind: "h", n: "", sign: "", text: line });
    } else if (line.startsWith("diff --git ")) {
      inHunk = false;
    } else if (inHunk) {
      const l = bodyLine(line, at);
      if (l) out.push(l);
    }
  }
  return out;
}

/** The Files tab's mark: A added, D deleted, M modified. */
export function fileMark(patch: string): "A" | "D" | "M" {
  if (/^new file mode/m.test(patch)) return "A";
  return /^(deleted file mode|\+\+\+ \/dev\/null)/m.test(patch) ? "D" : "M";
}

/** Paths grouped by folder, in the order they come; files at the root last. */
export function treeOf(paths: string[]): { folder: string; files: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const folder = i < 0 ? "" : p.slice(0, i);
    groups.set(folder, [...(groups.get(folder) ?? []), p.slice(i + 1)]);
  }
  const all = [...groups].map(([folder, files]) => ({ folder, files }));
  return [...all.filter((g) => g.folder), ...all.filter((g) => !g.folder)];
}
