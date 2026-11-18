/** One line of the lab's .code: a hunk header, context, an addition or a deletion, with its line number. */
export type DiffLine = { kind: "h" | "ctx" | "add" | "del"; n: string; sign: string; text: string };

const HEADERS =
  /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename |\\ No newline)/;

/** A patch as numbered lines: deletions keep their old number, additions and context the new one. */
export function diffLines(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldN = 0;
  let newN = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldN = Number(m?.[1] ?? 0);
      newN = Number(m?.[2] ?? 0);
      out.push({ kind: "h", n: "", sign: "", text: line });
    } else if (line === "" || HEADERS.test(line)) {
      // file headers and the trailing newline aren't shown
    } else if (line.startsWith("+")) {
      out.push({ kind: "add", n: String(newN++), sign: "+", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", n: String(oldN++), sign: "−", text: line.slice(1) });
    } else {
      out.push({ kind: "ctx", n: String(newN++), sign: "", text: line.slice(1) });
      oldN++;
    }
  }
  return out;
}

/** The Files tab's mark: A added, D deleted, M modified. */
export function fileMark(patch: string): "A" | "D" | "M" {
  if (/^new file mode/m.test(patch)) return "A";
  return /^deleted file mode/m.test(patch) ? "D" : "M";
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
