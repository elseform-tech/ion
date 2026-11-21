/** Where the string starting at `i` (a quote) ends, just past its closing quote. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** Where the comment starting at `i` ends (a line comment keeps its newline), or `i` when there's none. */
function commentEnd(text: string, i: number): number {
  if (text.startsWith("//", i)) {
    const nl = text.indexOf("\n", i);
    return nl < 0 ? text.length : nl;
  }
  if (!text.startsWith("/*", i)) return i;
  const end = text.indexOf("*/", i + 2);
  return end < 0 ? text.length : end + 2;
}

/** JSON with comments and trailing commas (opencode's JSONC), or null. Strings are kept as they are. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const next = text[i] === '"' ? stringEnd(text, i) : commentEnd(text, i);
    if (next === i) out += text[i++];
    else {
      if (text[i] === '"') out += text.slice(i, next);
      i = next;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}
