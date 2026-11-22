import { type PickedSkill, type Picks as RunPicks, type PickStyle, withPicks } from "@ion/adapter-kit";

export type { RunPicks };
import type { PickInfo, Picks, SkillInfo } from "@ion/schema";
import { pickStyle, takesResources } from "../adapters/registry.js";
import type { OwnCommand } from "./commands.js";

/**
 * What "/" and "@" list and what a pick hands the agent (the user, 2026-11-21, after Task 13: the agent's own setup
 * first, then ion's). `skills`: every skill found (Settings' list); `bodyOf`: a skill's text by name; `commands`: the
 * agent's own; `servers`: your mcp.json servers and whether each is on; `own`: the agent's own servers.
 */
export type PickSource = {
  skills: SkillInfo[];
  /** A listed skill's text: only that exact skill, while it's on or an agent's own. */
  bodyOf: (s: SkillInfo) => string | null;
  commands: OwnCommand[];
  servers: { name: string; on: boolean }[];
  own: { name: string }[];
  /** The resources of servers ion runs, by server (task review, 2026-11-21: "@" lists them). */
  resources?: Record<string, { name: string; uri: string }[]>;
};

/** Whether "@" lists servers' resources for this agent: only one that reads them (live, 2026-11-21: Grok can't). */
export const readsResources = (agent: string): boolean => takesResources(agent);

/** How a skill reaches an agent: it loads it itself ("own"), ion passes it ("ion"), or ion gives its text ("text"). */
function reach(s: SkillInfo, agent: string): "own" | "ion" | "text" | null {
  if (s.readers?.includes(agent)) return "own";
  if (!s.on || s.own) return null;
  return s.support[agent] === "ion" ? "ion" : "text";
}

const row = (
  name: string,
  description: string,
  kind: PickInfo["kind"],
  from: PickInfo["from"],
): PickInfo => ({
  name,
  description,
  kind,
  from,
});

/**
 * A name more than one different skill has (a repo's named like yours; security review, 2026-11-21): picked by name, it
 * could hand over the wrong one, so it's neither listed nor picked. The same skill in two folders is one.
 */
function ambiguous(skills: SkillInfo[], name: string): boolean {
  return new Set(skills.filter((s) => s.name === name).map((s) => s.hash)).size > 1;
}

/** A chat's "/" and "@": its agent's own commands and skills, then ion's skills that are on; its servers. */
export function chatPicks(agent: string, at: Omit<PickSource, "bodyOf">): Picks {
  const seen = new Set<string>();
  const skills = at.skills.flatMap((s) => {
    if (ambiguous(at.skills, s.name) || seen.has(s.name)) return [];
    const r = reach(s, agent);
    if (r) seen.add(s.name);
    return r ? [{ s, from: r === "own" ? ("own" as const) : ("ion" as const) }] : [];
  });
  const ordered = [...skills.filter((x) => x.from === "own"), ...skills.filter((x) => x.from === "ion")];
  return {
    skills: [
      ...at.commands.map((c) => row(c.name, c.description, "command", "own")),
      ...ordered.map(({ s, from }) => row(s.name, s.description, "skill", from)),
    ],
    servers: [...at.own.map((s) => row(s.name, "", "server", "own")), ...servedRows(at)],
  };
}

/** Your servers that are on, each followed by its resources (ion runs them, so it can list them). */
function servedRows(at: Pick<PickSource, "servers" | "resources">): PickInfo[] {
  return at.servers
    .filter((s) => s.on)
    .flatMap((s) => [
      row(s.name, "", "server", "ion"),
      ...(at.resources?.[s.name] ?? []).map((r) => ({
        ...row(r.name, r.uri, "resource", "ion"),
        ...{ server: s.name, uri: r.uri },
      })),
    ]);
}

/** A mention as the agent gets it: a server's name, or "<server> resource <uri>". */
const mentionOf = (p: PickInfo) => (p.kind === "resource" ? `${p.server} resource ${p.uri}` : p.name);

/** An ion's chat: every skill that's on (it reads them, or names them for a thread), and the servers that are on. */
export function ionPicks(at: Pick<PickSource, "skills" | "servers" | "resources">): Picks {
  const on = at.skills.filter((s) => s.on && !ambiguous(at.skills, s.name));
  return {
    skills: on
      .filter((s, i) => on.findIndex((x) => x.name === s.name) === i)
      .map((s) => row(s.name, s.description, "skill", s.own ? "own" : "ion")),
    servers: servedRows(at),
  };
}

/**
 * What you picked, as the run's agent takes it: its own commands by name (their text for one that can't run them),
 * skills it loads by name, ion's it can't load with their text; servers it has. Anything else is dropped.
 */
export function resolvePicks(
  agent: string,
  at: PickSource,
  names: { skills?: string[]; mentions?: string[] },
): { skills: PickedSkill[]; mentions: string[] } {
  const slash = pickStyle(agent) === "slash";
  const picked = Array.isArray(names.skills) ? names.skills.filter((n) => typeof n === "string") : [];
  const skills = picked.flatMap((n): PickedSkill[] => {
    const c = at.commands.find((x) => x.name === n);
    if (c)
      return [slash && c.runs ? { name: n, kind: "command" } : { name: n, kind: "command", body: c.body }];
    const s = ambiguous(at.skills, n) ? undefined : at.skills.find((x) => x.name === n && reach(x, agent));
    if (!s) return [];
    const body = reach(s, agent) === "text" ? at.bodyOf(s) : null;
    return [body ? { name: n, kind: "skill", body } : { name: n, kind: "skill" }];
  });
  const servers = chatPicks(agent, { ...at, commands: [] }).servers.map(mentionOf);
  const mentions = Array.isArray(names.mentions) ? names.mentions.filter((m) => typeof m === "string") : [];
  return { skills, mentions: mentions.filter((m) => servers.includes(m)) };
}

/**
 * What a message picked with "/" and "@", as this agent takes them (only what it can use); none when nothing was
 * picked or ion can't read them.
 */
export async function picksOfRun(
  source: ((agent: string, projectId: string) => Promise<PickSource>) | undefined,
  agent: string,
  names: { skills?: string[]; mentions?: string[] },
  projectId?: string | null,
): Promise<RunPicks | undefined> {
  const any = (v: unknown) => Array.isArray(v) && v.length > 0;
  if (!any(names.skills) && !any(names.mentions)) return undefined;
  const at = await source?.(agent, projectId ?? "").catch(() => undefined);
  return at ? resolvePicks(agent, at, names) : undefined;
}

/** What the chat shows as picked: the names that reached the agent. */
export const shownPicks = (p?: RunPicks) => ({
  ...(p?.skills?.length ? { skills: p.skills.map((x) => x.name) } : {}),
  ...(p?.mentions?.length ? { mentions: p.mentions } : {}),
});

/** Your words with what you picked, the way this agent takes them. */
export const agentText = (text: string, style: PickStyle | undefined, p?: RunPicks): string =>
  p ? withPicks(text, style ?? "tell", p) : text;
