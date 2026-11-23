import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { RESERVED_IDS } from "./projects.js";

const Effort = z.enum(["low", "medium", "high", "max"]);

/** A clock time, local: "08:30". */
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const Clock = z.string().regex(CLOCK, "Use a time like 08:30");

/** How much a project may notify: everything, what needs you, only urgent things, nothing. */
export const NOTIFY_LEVELS = ["all", "needs", "digest", "muted"] as const;
const Notify = z.enum(NOTIFY_LEVELS);

/** resources.max_runs: "auto" or how many chats run at once, from MIN_RUNS to MAX_RUNS. */
export const MIN_RUNS = 1;
export const MAX_RUNS = 32;

/**
 * When a routine runs, local time: "daily 09:00", "weekdays 09:00", "mon 09:00" (any weekday), "every 4h" (1-23).
 * The same format @ion/schema's `parseWhen` reads.
 */
export const WHEN =
  /^((daily|weekdays|sun|mon|tue|wed|thu|fri|sat) ([01]\d|2[0-3]):[0-5]\d|every ([1-9]|1\d|2[0-3])h)$/;

/** Something a project's ion does on a schedule: a thread titled `name`, briefed with `text`. */
/** A project's profile is a line or two (what ion chief reads to know what a project is): at most this long. */
export const PROFILE_CHARS = 300;

// Loose, as a project is: a key you added by hand (or a newer ion did) survives a save.
const Routine = z.looseObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  when: z.string().regex(WHEN, "must be like daily 09:00, weekdays 09:00, mon 09:00 or every 4h"),
  text: z.string().min(1).max(4000),
  /** Off: it doesn't run until you turn it on. */
  on: z.boolean().default(true),
  /** The effort its threads run at; absent: the project's. */
  effort: Effort.optional(),
  /** The due time (ISO) of the one run you skipped. */
  skip: z.string().optional(),
});

const Project = z.looseObject({
  id: z.string().min(1),
  path: z.string().min(1),
  starred: z.boolean().default(false),
  /** The name ion shows, when you renamed it (its id stays: events, decisions and threads refer to it). */
  name: z.string().min(1).max(60).optional(),
  /** False: ion (the chief) never reads this project's chats. Absent means true. */
  shareWithIon: z.boolean().optional(),
  /** Its ion's colour (identity only); absent: the palette, by the project's place in this list. */
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  /** The agent its ion's threads run on; absent: ion's default. */
  harness: z.string().min(1).optional(),
  /** The model and effort its ion's threads run on (else the agent's own defaults). */
  model: z.string().min(1).max(200).optional(),
  effort: Effort.optional(),
  /** What may notify you from this project; absent: "needs". */
  notify: Notify.optional(),
  /** Memory in this project (its chats and its ion); absent: as everywhere (`memory.on`). */
  memory: z.boolean().optional(),
  /** What its ion does on a schedule. */
  routines: z.array(Routine).optional(),
  /** What the project is, in a line or two (its ion writes it); absent: its README's first paragraph. */
  profile: z.string().max(PROFILE_CHARS).optional(),
  /** A profile its ion suggested; ion never reads it as the profile until you accept it in Settings. */
  profileSuggestion: z.string().max(PROFILE_CHARS).optional(),
});

/** A command you set to run on an ion event (added only from the app). */
const HookTool = z.looseObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  on: z.boolean().default(true),
  /** The ion event it runs on (the daemon knows which; @ion/schema HOOK_EVENTS). */
  event: z.string().min(1).max(40),
  run: z.string().min(1).max(4000),
  /** Only this project's events; absent: every project's. */
  project: z.string().min(1).optional(),
});

/**
 * Your tools. Servers come only from mcp.json: here are the ones you turned on, your hooks and the
 * skills you turned on. Keys and tokens live in the keychain, never here.
 */
const Tools = z.looseObject({
  /**
   * The servers you turned on, as "<name>@<what it runs>" (a hash of its command and arguments, or its URL's
   * origin): a new server, or one that now runs something else, is off until you turn it on.
   */
  mcpOn: z.array(z.string()).default([]),
  hooks: z.array(HookTool).default([]),
  /**
   * The hooks you turned on in the app, as "<id>@<what it runs>" (a hash of its command, event and project): one
   * added or changed here by hand is off until you turn it on.
   */
  hooksOn: z.array(z.string()).default([]),
  /**
   * The skills you turned on in the app, as "<folder>@<what's in it>" (signed with ion's key): a new skill, or one
   * whose files changed, is off until you turn it on.
   */
  skills: z.looseObject({ on: z.array(z.string()).default([]) }).prefault({}),
  /**
   * A repo's own servers (a project's .mcp.json, which Claude Code would load) you turned on in the app, as
   * "<project>:<name>@<what it runs>" (signed with ion's key): one the repo adds or changes is off until you turn it on.
   */
  repoOn: z.array(z.string()).default([]),
  /**
   * "Ions can use" for your servers' tools (the user, 2026-11-21), as "<server>/<tool>@<what it is>=on|off|label" (a
   * hash of its name, description and labels): "label" is the server's own label as ion first saw it. A tool that
   * changes is off for ions until you look.
   */
  ionUse: z.array(z.string()).default([]),
});

/** routing.onLimit: what ion does when a chat's agent hits its limit. */
export const ON_LIMIT = ["ask", "continue", "wait"] as const;

// Loose objects keep keys this version doesn't know (newer ion, other tools), so saving never drops them.
const MaxRuns = z.union([z.literal("auto"), z.number().int().min(MIN_RUNS).max(MAX_RUNS)]);

/**
 * The file's version, written by every save: 2 since ion's models and the judge have no Claude Code default (Plan 21
 * audit, 2026-11-23). A file without it is older, and the defaults every save wrote then are moved (moveOldDefaults).
 */
const CONFIG_VERSION = 2;

const UserConfigSchema = z.looseObject({
  ion: z
    .looseObject({
      // "<harness>" uses that harness's own default model; "<harness>:<model>" picks one from its list. Absent (quick
      // and deep): the strongest model you're signed in to, at High (the user, 2026-11-23).
      quick: z.string().optional(),
      /** How hard ion's quick model thinks; absent: the agent's own default. */
      quickEffort: Effort.optional(),
      deep: z.string().optional(),
      deepEffort: Effort.default("high"),
      useDeep: z.enum(["auto", "always", "never"]).default("auto"),
    })
    .prefault({}),
  projects: z.array(Project).default([]),
  /** Projects named with ion's own ids (chief, you): kept in your file as written, never used. */
  heldProjects: z.array(z.looseObject({})).optional(),
  /** Where `ion projects new <name>` makes projects. */
  folders: z.looseObject({ projects: z.string().default("~/ion/projects") }).prefault({}),
  /**
   * How Auto decides. Whether a chat runs in Auto or Full access is picked per message with the composer's access
   * icon (new chats start on Auto); there's no default or per-project setting.
   */
  access: z
    .looseObject({
      /**
       * Who decides in Auto: "<harness>[:<model>]", a small model (it runs for every new action). Absent: the first
       * ready agent in your agent order whose pinned judge model ion's judge evals checked.
       */
      judge: z.string().optional(),
    })
    .prefault({}),
  /** Pause all: no routine runs until you resume. Absent: none paused. */
  routines: z.looseObject({ paused: z.boolean().default(false) }).optional(),
  resources: z
    .looseObject({
      max_runs: z.union([z.literal("auto"), z.number().int().min(MIN_RUNS).max(MAX_RUNS)]).default("auto"),
    })
    .default({ max_runs: "auto" }),
  notifications: z
    .looseObject({
      /** One message from ion chief a day: what finished, what needs you. */
      briefing: z.looseObject({ on: z.boolean().default(true), at: Clock.default("08:30") }).prefault({}),
      /** System notifications wait until these hours end. */
      quiet: z
        .looseObject({
          on: z.boolean().default(true),
          from: Clock.default("22:00"),
          to: Clock.default("08:00"),
        })
        .prefault({}),
    })
    .prefault({}),
  tools: Tools.prefault({}),
  /**
   * ion's memory. `on`: memory everywhere (your own memory follows it; the user, 2026-11-23: "a way to disable
   * memory"); off, agents and ions get no memory and nothing new is written. `dream`: how often ion tidies it, in quiet hours (merges, rewrites, forgets; every change undoable);
   * `dreamAgent`: "<harness>[:<model>]" it does it on (absent: ion's quick model).
   */
  memory: z
    .looseObject({
      on: z.boolean().default(true),
      dream: z.enum(["off", "nightly", "weekly"]).default("off"),
      dreamAgent: z.string().optional(),
    })
    .prefault({}),
  /**
   * Each coding agent's own setup, by agent id. `ownTools`: whether it brings its own MCP servers, skills and plugins
   * into ion's chats (the user, 2026-11-21: on by default); off, ion's tools only. Its own hooks never run where ion
   * can turn them off.
   */
  agents: z.record(z.string(), z.looseObject({ ownTools: z.boolean().optional() })).default({}),
  /**
   * How ion picks a chat's agent (Plan 20). `order`: your agent order, best first (empty: ion's own, opencode, Grok
   * Build, Codex, Claude Code); it decides handoff targets, Pick by usage, and an ion's chats when the project names
   * no agent. `onLimit`: when a chat's agent hits its limit, ask you, continue on the next agent, or wait for the
   * reset. `byUsage`: Pick by usage fills in a new chat's agent when you picked none.
   */
  routing: z
    .looseObject({
      order: z.array(z.string()).default([]),
      onLimit: z.enum(ON_LIMIT).default("ask"),
      byUsage: z.boolean().default(false),
    })
    .prefault({}),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
export type ProjectEntry = UserConfig["projects"][number];
export type RoutineEntry = NonNullable<ProjectEntry["routines"]>[number];
export type HookEntry = UserConfig["tools"]["hooks"][number];

export const DEFAULT_CONFIG: UserConfig = Object.freeze(UserConfigSchema.parse({})) as UserConfig;

const defaults = (): UserConfig => structuredClone(DEFAULT_CONFIG);

function describeIssue(file: string, issue: z.core.$ZodIssue): string {
  const where = issue.path.join(".");
  const values = (issue as { values?: unknown[] }).values;
  const what = values ? `must be one of ${values.join(", ")}` : issue.message;
  return [`${basename(file)}:`, where, what].filter(Boolean).join(" ");
}

/** The settings a hand edit can get wrong without losing the rest of the file, each with what it must be. */
const FALLBACKS: [path: string[], schema: z.ZodType][] = [
  [["resources", "max_runs"], MaxRuns],
  [["notifications"], z.looseObject({})],
  [["notifications", "briefing"], z.looseObject({})],
  [["notifications", "briefing", "on"], z.boolean()],
  [["notifications", "briefing", "at"], Clock],
  [["notifications", "quiet"], z.looseObject({})],
  [["notifications", "quiet", "on"], z.boolean()],
  [["notifications", "quiet", "from"], Clock],
  [["notifications", "quiet", "to"], Clock],
  [["tools"], z.looseObject({})],
  [["tools", "mcpOn"], z.array(z.string())],
  [["tools", "hooks"], z.array(z.unknown())],
  [["tools", "hooksOn"], z.array(z.string())],
  [["tools", "repoOn"], z.array(z.string())],
  [["tools", "ionUse"], z.array(z.string())],
  [["tools", "skills"], z.looseObject({ on: z.array(z.string()).optional() })],
  [["agents"], z.looseObject({})],
  [["memory"], z.looseObject({})],
  [["memory", "on"], z.boolean()],
  [["memory", "dream"], z.enum(["off", "nightly", "weekly"])],
  [["memory", "dreamAgent"], z.string()],
  [["routing"], z.looseObject({})],
  [["routing", "order"], z.array(z.string())],
  [["routing", "onLimit"], z.enum(ON_LIMIT)],
  [["routing", "byUsage"], z.boolean()],
];

/** Whether this agent brings its own servers, skills and plugins into ion's chats (on unless you turned it off). */
export const ownToolsOn = (c: Pick<UserConfig, "agents">, agent: string): boolean =>
  c.agents?.[agent]?.ownTools !== false;

/** A project's bad `notify` or `memory` is dropped (its default applies); returns "<id>.<key>" for each. */
function dropBadProjectKeys(raw: unknown): string[] {
  const projects = (raw as { projects?: unknown } | null)?.projects;
  const all = (Array.isArray(projects) ? projects : []).filter(
    (p): p is Record<string, unknown> => typeof p === "object" && p !== null,
  );
  const said: string[] = [];
  for (const [key, schema] of [
    ["notify", Notify],
    ["memory", z.boolean()],
  ] as const)
    for (const p of all.filter((x) => key in x && !schema.safeParse(x[key]).success)) {
      delete p[key];
      said.push(`${String(p.id)}.${key}`);
    }
  return said;
}

/** A hook that isn't valid is dropped alone (the others still run); returns "hooks.<id>" for each. */
function dropBadHooks(raw: unknown): string[] {
  const tools = (raw as { tools?: { hooks?: unknown } } | null)?.tools;
  if (!Array.isArray(tools?.hooks)) return [];
  const bad = tools.hooks.filter((h) => !HookTool.safeParse(h).success);
  tools.hooks = tools.hooks.filter((h) => !bad.includes(h));
  return bad.map((h, i) => `hooks.${String((h as { id?: unknown } | null)?.id ?? i)}`);
}

/** An agent's `ownTools` that isn't true or false is dropped (on applies); returns "<id>.ownTools" for each. */
function dropBadAgents(raw: unknown): string[] {
  const agents = (raw as { agents?: unknown } | null)?.agents;
  if (typeof agents !== "object" || agents === null) return [];
  const bad: string[] = [];
  for (const [id, a] of Object.entries(agents as Record<string, unknown>)) {
    if (typeof a !== "object" || a === null) {
      delete (agents as Record<string, unknown>)[id];
      bad.push(id);
    } else if ("ownTools" in a && typeof (a as { ownTools?: unknown }).ownTools !== "boolean") {
      delete (a as { ownTools?: unknown }).ownTools;
      bad.push(`${id}.ownTools`);
    }
  }
  return bad;
}

/** Removes `path`'s value from `raw` when it's there and `schema` refuses it; true if it did. */
function dropIfBad(raw: unknown, path: string[], schema: z.ZodType): boolean {
  let parent: unknown = raw;
  for (const k of path.slice(0, -1)) parent = (parent as Record<string, unknown> | undefined)?.[k];
  const key = path.at(-1)!;
  if (typeof parent !== "object" || parent === null || !(key in parent)) return false;
  const holder = parent as Record<string, unknown>;
  if (schema.safeParse(holder[key]).success) return false;
  delete holder[key];
  return true;
}

/**
 * A project whose id is ion's own (chief, you) is left out of `projects` and held as written (`heldProjects`), so a
 * save keeps it in your file (task review, 2026-11-22); returns those ids.
 */
function holdReservedProjects(raw: unknown): string[] {
  const r = raw as { projects?: unknown; heldProjects?: unknown } | null;
  if (!Array.isArray(r?.projects)) return [];
  const isReserved = (p: unknown) => RESERVED_IDS.includes(String((p as { id?: unknown } | null)?.id));
  const held = r.projects.filter(isReserved);
  r.projects = r.projects.filter((p) => !isReserved(p));
  if (held.length) r.heldProjects = held;
  return held.map((p) => String((p as { id: unknown }).id));
}

/** Drops each invalid setting from `raw` (its default applies) and says which, so the rest of the file still loads. */
function dropBad(raw: unknown, file: string): string | null {
  const dropped = FALLBACKS.filter(([path, schema]) => dropIfBad(raw, path, schema)).map(([path]) =>
    path.length === 1 ? path[0]! : path.slice(1).join("."),
  );
  dropped.push(...dropBadProjectKeys(raw), ...dropBadHooks(raw), ...dropBadAgents(raw));
  const said = holdReservedProjects(raw).map(
    (id) => `${basename(file)}: rename project '${id}' (the name is ion's own; ion leaves it out until then)`,
  );
  if (dropped.length) {
    const verb = dropped.length > 1 ? "are" : "is";
    said.unshift(`${basename(file)}: ${dropped.join(", ")} ${verb} not valid; using the default`);
  }
  return said.join("; ") || null;
}

/** Removes `holder[key]`; whether it held something other than "auto" (worth a warning). */
function dropKey(holder: unknown, key: string): boolean {
  if (typeof holder !== "object" || holder === null || !(key in holder)) return false;
  const was = (holder as Record<string, unknown>)[key];
  delete (holder as Record<string, unknown>)[key];
  return was !== "auto";
}

/**
 * `access.default` and each project's `access` are no longer read (the user, 2026-11-20: Auto-approval is turned
 * off only per chat, with the composer's access icon): they're removed, so new chats start on Auto, and a value
 * other than auto is said once.
 */
function dropOldAccess(raw: unknown, file: string): string | null {
  const r = raw as { access?: unknown; projects?: unknown } | null;
  const said = dropKey(r?.access, "default") ? ["access.default"] : [];
  for (const p of Array.isArray(r?.projects) ? r.projects : [])
    if (dropKey(p, "access")) said.push(`${String((p as { id?: unknown }).id)}.access`);
  if (!said.length) return null;
  return `${basename(file)}: ${said.join(", ")} no longer used; new chats start on Auto`;
}

/** The defaults every save wrote before version 2 (Claude Code), with where each is. */
const OLD_DEFAULTS: [section: string, key: string, was: string, name: string][] = [
  ["ion", "quick", "claude-code", "quick"],
  ["ion", "deep", "claude-code", "deep"],
  ["access", "judge", "claude-code:haiku", "judge"],
];

/** One line naming what moved: ion's models to the strongest model you have, the judge to your order. */
function movedLine(file: string, moved: string[]): string {
  const brain = moved.filter((m) => m !== "judge");
  const parts = [
    ...(brain.length
      ? [
          `ion's ${brain.join(" and ")} model${brain.length > 1 ? "s" : ""} now use${brain.length > 1 ? "" : "s"} the strongest model you're signed in to`,
        ]
      : []),
    ...(moved.includes("judge") ? ["the judge now follows your order"] : []),
  ];
  const it = moved.length > 1 ? "them" : "it";
  return `${basename(file)}: ${parts.join(", and ")}; set ${it} in Settings to keep Claude Code`;
}

/**
 * A file from before version 2 (Plan 21 audit, 2026-11-23): each of ion's models still on the old default (Claude
 * Code, written by every save whether you picked it or not) is the strongest model you're signed in to now, and the
 * judge follows your agent order (the user, 2026-11-23); any other
 * value is your choice and stays. Older: no version, or one that isn't a number of at least 2 (PR #36 review); a
 * newer file's version is kept so a save never writes it lower. Returns one line naming what moved, or null.
 */
function moveOldDefaults(raw: unknown, file: string): string | null {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) return null;
  const v = r.version;
  delete r.version;
  if (typeof v === "number" && v > CONFIG_VERSION) r.version = v;
  if (typeof v === "number" && v >= CONFIG_VERSION) return null;
  const moved: string[] = [];
  for (const [section, key, was, name] of OLD_DEFAULTS) {
    const holder = r[section] as Record<string, unknown> | undefined;
    if (typeof holder !== "object" || holder === null || holder[key] !== was) continue;
    delete holder[key];
    moved.push(name);
  }
  return moved.length ? movedLine(file, moved) : null;
}

/**
 * Reads the config file. Missing file → defaults. Invalid file → defaults plus a one-line error. A bad notification
 * time or max_runs alone falls back to its default, with a warning; the rest of the file loads.
 */
export function loadUserConfig(file: string): {
  config: UserConfig;
  error: string | null;
  warning: string | null;
} {
  if (!existsSync(file)) return { config: defaults(), error: null, warning: null };
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    const first = String((e as Error).message).split("\n")[0];
    return { config: defaults(), error: `${basename(file)}: ${first}`, warning: null };
  }
  const moved = moveOldDefaults(raw, file);
  const warning = [moved, dropBad(raw, file), dropOldAccess(raw, file)].filter(Boolean).join("; ") || null;
  const r = UserConfigSchema.safeParse(raw);
  if (!r.success)
    return { config: defaults(), error: describeIssue(file, r.error.issues[0]!), warning: null };
  return { config: r.data, error: null, warning };
}

/** Writes the config atomically (temp file, then rename). */
export function saveUserConfig(file: string, c: UserConfig): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const {
    heldProjects,
    version: read,
    ...rest
  } = UserConfigSchema.parse(c) as UserConfig & { version?: unknown };
  // Never lower than the file's own (a newer ion's): PR #36 review, 2026-11-23.
  const parsed = { version: Math.max(CONFIG_VERSION, typeof read === "number" ? read : 0), ...rest };
  // A held project goes back in the file as you wrote it (after the others).
  const out = heldProjects?.length ? { ...parsed, projects: [...parsed.projects, ...heldProjects] } : parsed;
  writeFileSync(tmp, stringify(out), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
