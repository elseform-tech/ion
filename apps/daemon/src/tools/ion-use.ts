import { createHash } from "node:crypto";
import { type ServerToolInfo, stripControl } from "@ion/schema";

/**
 * "Ions can use" for your servers' tools (the user, 2026-11-21: ions use your tools read-only). A tool starts as its
 * server labels it (on only when `readOnlyHint` and not `destructiveHint`; unlabelled: off); your switch beats the
 * label both ways; either is kept with a mark of what the tool is (its name, description and labels), so a tool
 * that changes is off for ions until you look. Entries: "<server>/<tool>@<mark>=on|off|label".
 */

/** A tool as a server's tools/list gives it. */
export type ListedTool = { name: string; description?: string; annotations?: Record<string, unknown> };

type State = "on" | "off" | "label";
type Entry = { server: string; tool: string; mark: string; state: State };

/** What the tool is now: its name, description and labels, hashed. */
const toolMark = (server: string, t: ListedTool): string =>
  createHash("sha256")
    .update(JSON.stringify([server, t.name, t.description ?? "", t.annotations ?? {}]))
    .digest("hex")
    .slice(0, 16);

/** The server's label: read-only and not destructive. */
const labelledReadOnly = (t: ListedTool): boolean =>
  t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true;

function parse(e: string): Entry | null {
  const eq = e.lastIndexOf("=");
  const key = e.slice(0, eq);
  const at = key.lastIndexOf("@");
  const slash = key.indexOf("/");
  const state = e.slice(eq + 1);
  if (eq < 0 || at < 0 || slash < 0 || !["on", "off", "label"].includes(state)) return null;
  return {
    server: key.slice(0, slash),
    tool: key.slice(slash + 1, at),
    mark: key.slice(at + 1),
    state: state as State,
  };
}

const entryOf = (server: string, t: ListedTool, state: State) =>
  `${server}/${t.name}@${toolMark(server, t)}=${state}`;
const find = (entries: string[], server: string, tool: string) =>
  entries.map(parse).find((x) => x?.server === server && x.tool === tool) ?? null;

/** Whether ions can use this tool as it is now, and what you set (undefined: you didn't), and whether it changed. */
function stateOf(entries: string[], server: string, t: ListedTool) {
  const e = find(entries, server, t.name);
  if (!e) return { ions: labelledReadOnly(t), seen: false };
  if (e.mark !== toolMark(server, t)) return { ions: false, seen: true, changed: true as const };
  if (e.state === "label") return { ions: labelledReadOnly(t), seen: true };
  return { ions: e.state === "on", seen: true, yours: e.state === "on" };
}

/** Whether an ion may call this tool (as the server lists it now). */
export const ionMayUse = (entries: string[], server: string, t: ListedTool): boolean =>
  stateOf(entries, server, t).ions;

/** A server's tools for Settings, and entries to keep for the ones ion sees for the first time. */
export function ionUseOf(
  entries: string[],
  server: string,
  tools: ListedTool[],
): { tools: ServerToolInfo[]; seen: string[] } {
  const fresh: string[] = [];
  const out = tools.map((t): ServerToolInfo => {
    const s = stateOf(entries, server, t);
    if (!s.seen) fresh.push(entryOf(server, t, "label"));
    return {
      name: stripControl(t.name).slice(0, 100),
      description: stripControl(t.description ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300),
      readOnly: labelledReadOnly(t),
      ions: s.ions,
      ...("yours" in s && s.yours !== undefined ? { yours: s.yours } : {}),
      ...("changed" in s ? { changed: true as const } : {}),
    };
  });
  return { tools: out, seen: [...entries, ...fresh] };
}

/** Your switch for one tool, kept with what it is now. */
export function setIonUse(entries: string[], server: string, t: ListedTool, on: boolean): string[] {
  const kept = entries.filter((e) => {
    const x = parse(e);
    return !(x?.server === server && x.tool === t.name);
  });
  return [...kept, entryOf(server, t, on ? "on" : "off")];
}
