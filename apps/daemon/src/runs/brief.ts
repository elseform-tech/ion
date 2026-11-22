import { EV, type IonEvent } from "@ion/schema";
import { wrapData } from "../context/index.js";
import type { EventStore } from "../store/index.js";
import { chatDiff } from "../workspace/index.js";
import { projectPath } from "./projects.js";

/** A file the chat's worktree changed, with its line counts (its diff stat). */
export type FileStat = { path: string; added: number; removed: number };

/** What the next session is told to do first: the last edit may not have finished (Review Focus 2). */
export const CHECK_FIRST =
  "Check git status and the tests before continuing: the last step may not have finished.";

const FIELD = 600;
const STEPS = 8;
const FILES = 30;
/** The whole brief's most, in characters. */
const BRIEF_CHARS = 6000;

type D = Record<string, unknown>;

/** One line of an agent's or your words: control characters out, cut, quoted (a line can't fake another field). */
const quoted = (s: string) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's taken out.
  const clean = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return JSON.stringify(clean.length > FIELD ? `${clean.slice(0, FIELD)}…` : clean);
};

const textOf = (e: IonEvent) => {
  const d = e.data as D;
  return String(d.shown ?? d.text ?? "");
};

/** Your messages, not ion's own briefs. */
const yours = (events: IonEvent[]) =>
  events.filter((e) => e.type === EV.messageSent && (e.data as D).handoff !== true);

/** The newest run's last steps: what each did, and whether it failed. */
function lastSteps(events: IonEvent[], runId: string | null): string[] {
  const ok = new Map<string, boolean>();
  for (const e of events)
    if (e.type === EV.toolFinished) ok.set(String((e.data as D).toolId), (e.data as D).ok === true);
  return events
    .filter((e) => e.type === EV.toolStarted && e.runId === runId)
    .slice(-STEPS)
    .map((e) => {
      const d = e.data as D;
      const failed = ok.get(String(d.toolId)) === false ? " (failed)" : "";
      return `${String(d.name)}: ${String(d.summary).replace(/\s+/g, " ").slice(0, 160)}${failed}`;
    });
}

const fileLine = (f: FileStat) => `${f.path} (+${f.added} −${f.removed})`;

/**
 * ion's brief of a chat, built from its events and its worktree's diff (no model call): your request, the files
 * changed, the newest run's last steps and its last error, and where the agent left off (its last words). Each field
 * is cut and quoted, and the whole is capped; it goes to the next session as data, with what to check first.
 */
export function chatBrief(events: IonEvent[], files: FileStat[]): string {
  const asked = yours(events);
  const lastRun = events.findLast((e) => e.type === EV.runStarted)?.runId ?? null;
  const out: string[] = [];
  if (asked[0]) out.push(`Your request: ${quoted(textOf(asked[0]))}`);
  const latest = asked.at(-1);
  if (latest && latest !== asked[0]) out.push(`Latest message: ${quoted(textOf(latest))}`);
  const changed = files.slice(0, FILES).map(fileLine);
  if (files.length > FILES) changed.push(`and ${files.length - FILES} more`);
  out.push(`Files changed so far: ${changed.length ? changed.join(", ") : "none"}`);
  const steps = lastSteps(events, lastRun);
  if (steps.length) out.push(`Last steps: ${steps.join("; ")}`);
  const error = events.findLast((e) => e.type === EV.error && e.runId === lastRun);
  if (error) out.push(`Last error: ${quoted(String((error.data as D).message ?? ""))}`);
  const left = events.findLast((e) => e.type === EV.messageCompleted && e.runId === lastRun);
  if (left) out.push(`Where it left off: ${quoted(textOf(left))}`);
  const body = out.join("\n").slice(0, BRIEF_CHARS);
  return `${wrapData("ion's summary of this chat", body)}\n${CHECK_FIRST}`;
}

type Summarized = { chatId: string; runId: string; cwd: string; projectId: string; handoff?: true };

/**
 * A long chat's run starting a new session (not a handoff's, whose message is a brief already): ion's summary of the
 * chat before this run, from its events and its worktree's diff, kept on the run (`long.brief`); the chat says
 * "Started fresh with a summary" once per run (`b.summarized`).
 */
export async function summarize<L extends Summarized & { long?: { budget: number; brief?: string } }>(
  d: { store: EventStore; configFile: string },
  l: L,
  b: { summarized?: boolean },
): Promise<L> {
  if (!l.long || l.handoff || l.long.brief) return l;
  const events = d.store.read({ chatId: l.chatId }).filter((e) => e.runId !== l.runId);
  const files = await chatDiff(projectPath(d.configFile, l.projectId), l.cwd).then(
    (x) => x.files,
    () => [],
  );
  l.long.brief = chatBrief(events, files);
  if (!b.summarized) {
    b.summarized = true;
    const data = { kind: "fresh", text: "Started fresh with a summary" };
    d.store.append({ chatId: l.chatId, runId: l.runId, origin: "daemon", type: EV.chatHandoff, data });
  }
  return l;
}
