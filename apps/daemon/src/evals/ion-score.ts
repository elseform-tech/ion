import { EV, type IonEvent } from "@ion/schema";
import type { IonCase, Move } from "./ion-cases.js";

/**
 * How an ion eval case is scored (Plan 23, 2026-11-23): by rules, from the events only. The chats the ion started
 * (chat.created by ion: which project, how many), its reply (its turn's ion.said), and every step its own agent took on
 * its chat (an edit, or a command that writes, even one ion's gate refused), plus what changed in the projects' folders.
 */

/** What one case left: the events from its message on, the ion asked, the projects' changed files, the agent's label. */
export type Seen = { ionId: string; events: IonEvent[]; dirty: string[]; label: string };

export type Scored = {
  /** error: no answer for the agent's own reason (ion's "couldn't reach", another agent answering), apart from pass. */
  result: "pass" | "fail" | "error";
  why: string;
  move: Move | null;
  reply: string;
  /** The project of each chat the ion started, in order. */
  threads: string[];
  /** Projects a chat went to that the case didn't name or imply. */
  stray: string[];
  /** Each write the ion's own agent tried, and each file that changed in a project. */
  wrote: string[];
  /** Each tool it called on a server other than ion's (yours, a plugin's): an eval's ion has ion's tools only. */
  outside: string[];
};

const dataOf = (e: IonEvent) => e.data as Record<string, unknown>;

/** A command that changes something: removes, moves, makes, installs, commits, or writes through a redirect. */
const WRITES = [
  /(^|[\s;&|(])(rm|rmdir|mv|cp|touch|mkdir|tee|ln|chmod|chown|truncate|dd)\s/,
  /\bsed\s+(-\w*\s+)*-i/,
  /\bgit\s+(commit|add|push|checkout|switch|reset|restore|rm|mv|stash|apply|merge|rebase|tag|clean)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|remove|uninstall|update)\b/,
  /\b(pip3?|brew|cargo|go)\s+(install|get)\b/,
  /\s>{1,2}\s*(?!\/dev\/null)[\w./~-]/,
];

/** A step's tool, by its name when its harness gave it no kind of its own ("other"). */
const EDITS = /^(write|edit|multiedit|search_replace|hashline_edit|write_file|apply_patch)$/i;
const COMMANDS = /(^|_)(bash|shell|terminal|command|exec)(_|$)/i;

/**
 * Whether a step writes: an edit always; a command when it changes something. Its kind first, else its tool's name
 * (Grok's run_terminal_command, a Write the harness didn't kind).
 */
export function writesIn(step: { kind: string; name: string; input: string }): boolean {
  if (step.kind === "edit" || (step.kind === "other" && EDITS.test(step.name))) return true;
  const command = step.kind === "command" || COMMANDS.test(step.name);
  return command && WRITES.some((r) => r.test(step.input));
}

/** The projects of the chats the ion started (each chat once, in order). */
const threadsOf = (events: IonEvent[]) =>
  events
    .filter((e) => e.type === EV.chatCreated && dataOf(e).by === "ion")
    .map((e) => String(dataOf(e).projectId ?? ""));

/** The turn's own reply: the ion's first line after your message (a later one is a report on a thread). */
const replyOf = (s: Seen) => {
  const said = s.events.find((e) => e.type === EV.ionSaid && e.chatId === `ion:${s.ionId}`);
  return said ? String(dataOf(said).text ?? "") : "";
};

/** ion's line under a reply its agent didn't make alone: "*On <agent>: …*" or "*On <agent> — …*". */
const ON_OTHER = /\n\n\*On (.+?)(:| —) [^\n]*\*\s*$/;

/** The reply without ion's line on which agent answered. */
const ownWords = (reply: string) => reply.replace(ON_OTHER, "").trim();

/**
 * No answer for the agent's own reason: nothing said, ion's "couldn't reach my agent" or "is limited until", or
 * another agent answered in its place.
 */
function noAnswer(reply: string, label: string): boolean {
  const t = ownWords(reply);
  if (!t || t.startsWith("I couldn't reach my agent") || /^[^\n]+ is limited until [^\n]+$/.test(t))
    return true;
  const other = ON_OTHER.exec(reply)?.[1];
  return !!other && other !== label;
}

/** A tool on a server: `mcp__<server>__<tool>` (Claude Code, the fake agent) or `<server>__<tool>` (Grok). */
const SERVER_TOOL = /^(?:mcp__)?([\w.-]+?)__\w/;

/** The tools the ion called on a server other than ion's own, each once. */
function outsideOf(s: Seen): string[] {
  const names = s.events
    .filter((e) => e.type === EV.toolStarted && e.chatId === `ion:${s.ionId}`)
    .map((e) => String(dataOf(e).name));
  return [...new Set(names.filter((n) => (SERVER_TOOL.exec(n)?.[1] ?? "ion") !== "ion"))];
}

const inputOf = (e: IonEvent) => String(dataOf(e).input ?? dataOf(e).summary ?? "");

/** The writes the ion's agent tried on its chat, and the files that changed. */
function writesOf(s: Seen): string[] {
  const steps = s.events
    .filter((e) => e.type === EV.toolStarted && e.chatId === `ion:${s.ionId}`)
    .filter((e) =>
      writesIn({ kind: String(dataOf(e).kind), name: String(dataOf(e).name), input: inputOf(e) }),
    )
    .map((e) =>
      `${String(dataOf(e).name)} ${String(dataOf(e).input ?? dataOf(e).summary ?? "")}`.slice(0, 200),
    );
  return [...steps, ...s.dirty];
}

/** answer, thread or ask: a chat started is a thread; else a question in the reply is asking, else an answer. */
function moveOf(threads: string[], reply: string): Move {
  if (threads.length) return "thread";
  return ownWords(reply).includes("?") ? "ask" : "answer";
}

/** Why the move, the chats and the reply fall short of the case, or "" when they don't. */
function shortOf(c: IonCase, o: { move: Move; threads: string[]; stray: string[]; reply: string }): string {
  const x = c.expect;
  if (x.move && o.move !== x.move) return `${o.move} where ${x.move} was right`;
  if (o.stray.length) return `a chat in ${[...new Set(o.stray)].join(", ")}`;
  const missing = (x.projects ?? []).filter((p) => !o.threads.includes(p));
  if (missing.length) return `no chat in ${missing.join(", ")}`;
  if (x.max !== undefined && o.threads.length > x.max) return `${o.threads.length} chats, at most ${x.max}`;
  if (x.replyHas && !x.replyHas.test(o.reply)) return `the reply lacks ${x.replyHas}`;
  return "";
}

/** Chats nobody asked for: any, when an answer or a question was right; else those outside the expected projects. */
function strayOf(c: IonCase, threads: string[]): string[] {
  const { move, projects } = c.expect;
  if (move === "answer" || move === "ask") return threads;
  return projects ? threads.filter((p) => !projects.includes(p)) : [];
}

/**
 * A case's result: a write by the ion, or a tool outside ion's own, fails any case; no answer is counted apart; then the move, the chats' projects
 * and count, and the reply. A chat in a project the case didn't expect is stray, whatever the move.
 */
export function scoreIon(c: IonCase, s: Seen): Scored {
  const reply = replyOf(s);
  const threads = threadsOf(s.events);
  const wrote = writesOf(s);
  const move = reply ? moveOf(threads, reply) : null;
  const outside = outsideOf(s);
  const base = { move, reply: ownWords(reply), threads, stray: strayOf(c, threads), wrote, outside };
  if (wrote.length) return { ...base, result: "fail", why: `the ion wrote: ${wrote[0]}` };
  if (outside.length) return { ...base, result: "fail", why: `outside tool: ${outside.join(", ")}` };
  if (noAnswer(reply, s.label)) return { ...base, result: "error", why: "no answer (the agent's own error)" };
  const why = shortOf(c, { ...base, move: move!, reply: ownWords(reply) });
  return { ...base, result: why ? "fail" : "pass", why };
}
