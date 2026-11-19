import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

const Effort = z.enum(["low", "medium", "high", "max"]);

const Access = z.enum(["auto", "full"]);

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

const Routine = z.object({
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

const Project = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  starred: z.boolean().default(false),
  /** The name ion shows, when you renamed it (its id stays: events, decisions and threads refer to it). */
  name: z.string().min(1).max(60).optional(),
  /** This project's access mode; without it, `[access] default` applies. */
  access: Access.optional(),
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
  /** What its ion does on a schedule. */
  routines: z.array(Routine).optional(),
  /** What the project is, in a line or two (its ion writes it); absent: its README's first paragraph. */
  profile: z.string().max(PROFILE_CHARS).optional(),
  /** A profile its ion suggested; ion never reads it as the profile until you accept it in Settings. */
  profileSuggestion: z.string().max(PROFILE_CHARS).optional(),
});

// Loose objects keep keys this version doesn't know (newer ion, other tools), so saving never drops them.
const MaxRuns = z.union([z.literal("auto"), z.number().int().min(MIN_RUNS).max(MAX_RUNS)]);

const UserConfigSchema = z.looseObject({
  ion: z
    .looseObject({
      // "<harness>" uses that harness's own default model; "<harness>:<model>" picks one from its list.
      quick: z.string().default("claude-code"),
      /** How hard ion's quick model thinks; absent: the agent's own default. */
      quickEffort: Effort.optional(),
      deep: z.string().default("claude-code"),
      deepEffort: Effort.default("high"),
      useDeep: z.enum(["auto", "always", "never"]).default("auto"),
    })
    .prefault({}),
  projects: z.array(Project).default([]),
  /** Where `ion projects new <name>` makes projects. */
  folders: z.looseObject({ projects: z.string().default("~/ion/projects") }).prefault({}),
  /** "auto": ion decides each action outside the chat's worktree; "full": everything runs. */
  access: z
    .looseObject({
      default: Access.default("auto"),
      /** Who decides in Auto: "<harness>:<model>", a small model (it runs for every new action). */
      judge: z.string().default("claude-code:haiku"),
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
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
export type ProjectEntry = UserConfig["projects"][number];
export type RoutineEntry = NonNullable<ProjectEntry["routines"]>[number];

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
];

/** A project's bad `notify` is dropped (its default applies); returns "<id>.notify" for each. */
function dropBadNotify(raw: unknown): string[] {
  const projects = (raw as { projects?: unknown } | null)?.projects;
  const bad = (Array.isArray(projects) ? projects : []).filter((p): p is Record<string, unknown> =>
    isBadNotify(p),
  );
  for (const p of bad) delete p.notify;
  return bad.map((p) => `${String(p.id)}.notify`);
}

const isBadNotify = (p: unknown): boolean =>
  typeof p === "object" && p !== null && "notify" in p && !Notify.safeParse(p.notify).success;

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

/** Drops each invalid setting from `raw` (its default applies) and says which, so the rest of the file still loads. */
function dropBad(raw: unknown, file: string): string | null {
  const dropped = FALLBACKS.filter(([path, schema]) => dropIfBad(raw, path, schema)).map(([path]) =>
    path.length === 1 ? path[0]! : path.slice(1).join("."),
  );
  dropped.push(...dropBadNotify(raw));
  if (!dropped.length) return null;
  const verb = dropped.length > 1 ? "are" : "is";
  return `${basename(file)}: ${dropped.join(", ")} ${verb} not valid; using the default`;
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
  const warning = dropBad(raw, file);
  const r = UserConfigSchema.safeParse(raw);
  if (!r.success)
    return { config: defaults(), error: describeIssue(file, r.error.issues[0]!), warning: null };
  return { config: r.data, error: null, warning };
}

/** Writes the config atomically (temp file, then rename). */
export function saveUserConfig(file: string, c: UserConfig): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, stringify(UserConfigSchema.parse(c)), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
