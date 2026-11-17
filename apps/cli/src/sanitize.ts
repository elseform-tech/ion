// Agents' text must not drive the terminal: C0/C1 control characters (except newline and tab) and
// invisible direction marks that reorder what's shown.
const CONTROL = new RegExp(
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
  "g",
);
export const text = (x: unknown): string => String(x ?? "").replace(CONTROL, "");
/** For one-line fields (paths, summaries, errors): also no line breaks, so they can't fake extra lines. */
export const clean = (x: unknown): string =>
  text(x)
    .split(/[\r\n]+/)
    .join(" ")
    .trim();

/**
 * A need's detail as indented lines: the exact command, URL and paths when it names them, else the raw input.
 * The summary is the agent's own words; this is what will actually happen.
 */
export function detailLines(detail: unknown): string {
  if (typeof detail !== "string" || !detail) return "";
  const lines = detail.split("\n");
  const lead = lines.filter((l) => !l.startsWith("{"));
  return (lead.length ? lead : lines).map((l) => `  ${clean(l)}\n`).join("");
}
