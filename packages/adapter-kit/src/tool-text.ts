/** How much of a tool's input and output reaches the chat: enough to see what happened, not a whole file. */
export const TOOL_INPUT_MAX = 8 * 1024;
export const TOOL_OUTPUT_MAX = 20 * 1024;

/** A tool's input or output as text: strings as they are, anything else as indented JSON; cut at `max`. */
export function toolText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}\n… (cut)` : text;
}

/** The text in a list of content blocks ({type: "text", text}), joined; null when there is none. */
export function blocksText(blocks: unknown): string | null {
  if (typeof blocks === "string") return blocks || null;
  if (!Array.isArray(blocks)) return null;
  const parts = blocks.flatMap((b) => {
    const x = b as { type?: unknown; text?: unknown; content?: { type?: unknown; text?: unknown } };
    if (x.type === "text" && typeof x.text === "string") return [x.text];
    if (x.content?.type === "text" && typeof x.content.text === "string") return [x.content.text];
    return [];
  });
  return parts.length ? parts.join("\n") : null;
}
