import { stripControl } from "@ion/schema";

// Agents' text must not drive the terminal (control characters, invisible formatters): see stripControl.
export const text = (x: unknown): string => stripControl(String(x ?? ""));
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
  // needDetail ends with the input as one JSON line; every line before it (a multi-line command included)
  // is shown whatever it starts with.
  const lines = detail.split("\n");
  const shown = lines.length > 1 ? lines.slice(0, -1) : lines;
  return shown.map((l) => `  ${clean(l)}\n`).join("");
}
