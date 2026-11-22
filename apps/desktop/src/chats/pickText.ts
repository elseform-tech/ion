import type { PickInfo } from "@ion/schema";

/**
 * Picks in the sentence (the user, 2026-11-22): each one you pick stays in the text where you typed it, as its token
 * ("/review", "@github"), and is drawn there as a chip. `name` is what it sends (a resource's: "<server> resource
 * <uri>").
 */
export type InlinePick = { name: string; k: "skills" | "mentions"; kind: PickInfo["kind"]; token: string };

/** Where a pick's token is in the text. */
export type Span = { start: number; end: number; pick: InlinePick };

const AFTER = /[\s.,;:!?)]/;

/** A token's places in the text: a whole word (after a space or the start; before a space, the end or a stop). */
function placesOf(text: string, pick: InlinePick): Span[] {
  const out: Span[] = [];
  for (let i = text.indexOf(pick.token); i >= 0; i = text.indexOf(pick.token, i + 1)) {
    const end = i + pick.token.length;
    const before = i === 0 || /\s/.test(text[i - 1] ?? "");
    if (before && (end === text.length || AFTER.test(text[end] ?? ""))) out.push({ start: i, end, pick });
  }
  return out;
}

/** Every pick's token in the text, in order, none overlapping (the longer of two at one place). */
export function spansOf(text: string, picks: InlinePick[]): Span[] {
  const all = picks.flatMap((p) => placesOf(text, p)).sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of all) if (!out.some((o) => s.start < o.end && o.start < s.end)) out.push(s);
  return out;
}

/** The picks the text holds, each once, in the order they come. */
export const inOrder = (spans: Span[]): InlinePick[] =>
  spans.map((s) => s.pick).filter((p, i, all) => all.findIndex((x) => x.name === p.name) === i);

/** The text cut into words and chips, for drawing. */
export function piecesOf(text: string, spans: Span[]): (string | Span)[] {
  const out: (string | Span)[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(s);
    at = s.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

type Caret = { start: number; end: number };

/**
 * What a key does to a chip at the caret: Backspace after it or Delete before it takes it out whole; an arrow steps
 * over it. Null: the box does what it always does.
 */
export function chipKey(
  key: string,
  text: string,
  caret: Caret,
  spans: Span[],
): { text: string; caret: number } | null {
  if (caret.start !== caret.end) return null;
  const c = caret.start;
  const after = spans.find((s) => c > s.start && c <= s.end);
  const before = spans.find((s) => c >= s.start && c < s.end);
  const cut = (s: Span) => ({ text: text.slice(0, s.start) + text.slice(s.end), caret: s.start });
  if (key === "Backspace" && after) return cut(after);
  if (key === "Delete" && before) return cut(before);
  if (key === "ArrowLeft" && after) return { text, caret: after.start };
  if (key === "ArrowRight" && before) return { text, caret: before.end };
  return null;
}

/** A caret inside a chip (a click) goes to its end: a chip is one thing. */
export const outOfChip = (c: number, spans: Span[]): number =>
  spans.find((s) => c > s.start && c < s.end)?.end ?? c;
