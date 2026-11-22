import { randomBytes } from "node:crypto";

/**
 * How an agent takes what you picked with "/" and "@" (the user, 2026-11-21): "slash", it runs a command written as
 * `/name` at the start of the prompt (Claude Code, opencode); "tell", it doesn't (a command's text is given instead).
 * Skills are named ("Use the <name> skill."): an agent that loads them finds them by name; one that can't is given
 * the skill's instructions.
 */
export type PickStyle = "slash" | "tell";

/** A skill or command you picked; `body`: its text, when the agent can't load it itself. */
export type PickedSkill = { name: string; kind: "skill" | "command"; body?: string };

/** What you picked for one message: skills and commands ("/"), servers and resources ("@"), by name. */
export type Picks = { skills?: PickedSkill[]; mentions?: string[] };

/** The most of one skill's text an agent is given. */
const BODY_MAX = 16_000;
const MARKER = /<(?=[\s/]*ion[\s_‐-―-]*data)/gi;

/** Text labelled as data the agent reads, its markers neutralised so it can't close its block. */
function asData(source: string, body: string): string {
  const id = randomBytes(8).toString("hex");
  const safe = stripControl(body.slice(0, BODY_MAX)).replace(MARKER, "‹");
  return `<ion-data id="${id}" source="${source.replaceAll('"', "'")}">\n${safe}\n</ion-data id="${id}">`;
}

/** One picked skill or command, as a line (and its text, when given). */
function line(p: PickedSkill): string {
  if (p.kind === "command") {
    const data = asData(`the ${p.name} command`, p.body ?? "");
    return `Do what the ${p.name} command says:\n${data}`;
  }
  if (p.body === undefined) return `Use the ${p.name} skill.`;
  const data = asData(`the ${p.name} skill`, p.body);
  return `Use the ${p.name} skill. Its instructions:\n${data}`;
}

/** A server you picked ("Use the <name> connection's tools."), or one of its resources ("<server> resource <uri>"). */
const mention = (m: string) =>
  m.includes(" resource ")
    ? `Read the ${stripControl(m)}.`
    : `Use the ${stripControl(m)} connection's tools.`;

/** Text without control characters (a name or a skill's text from a file). */
const stripControl = (t: string) => t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

/** Whether the text starts with `/name` as a whole word (a pick typed in place; the user, 2026-11-22). */
const startsWith = (text: string, name: string) =>
  text.startsWith(`/${name}`) && /^(\s|$)/.test(text.slice(name.length + 1));

/**
 * The text as sent: the command run as `/name` leads it once (you may have put it there yourself); any other pick at
 * its start loses its slash, so the agent never takes it for a command.
 */
function headOf(text: string, lead: PickedSkill | undefined, skills: PickedSkill[]): string {
  if (lead && startsWith(text, lead.name)) return text;
  const body = skills.some((p) => startsWith(text, p.name)) ? text.slice(1) : text;
  return lead ? `/${lead.name} ${body}` : body;
}

/** Your message with what you picked, the way this agent takes it. */
export function withPicks(text: string, style: PickStyle, picks: Picks): string {
  const skills = picks.skills ?? [];
  // An agent that runs commands gets the first one it can run as `/name` (only one can lead a prompt).
  const lead =
    style === "slash" ? skills.find((p) => p.kind === "command" && p.body === undefined) : undefined;
  const rest = skills.filter((p) => p !== lead && (p.kind === "skill" || p.body !== undefined));
  const lines = [...rest.map(line), ...(picks.mentions ?? []).map(mention)];
  const head = headOf(text, lead, skills);
  return lines.length ? `${head}\n\n${lines.join("\n")}` : head;
}
