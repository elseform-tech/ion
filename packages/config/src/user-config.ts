import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

const Effort = z.enum(["low", "medium", "high", "max"]);

const Access = z.enum(["auto", "full"]);

/**
 * When a routine runs, local time: "daily 09:00", "weekdays 09:00", "mon 09:00" (any weekday), "every 4h" (1-23).
 * The same format @ion/schema's `parseWhen` reads.
 */
export const WHEN =
  /^((daily|weekdays|sun|mon|tue|wed|thu|fri|sat) ([01]\d|2[0-3]):[0-5]\d|every ([1-9]|1\d|2[0-3])h)$/;

/** Something a project's ion does on a schedule: a thread titled `name`, briefed with `text`. */
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
  /** What its ion does on a schedule. */
  routines: z.array(Routine).optional(),
});

// Loose objects keep keys this version doesn't know (newer ion, other tools), so saving never drops them.
const UserConfigSchema = z.looseObject({
  ion: z
    .looseObject({
      // "<harness>" uses that harness's own default model; "<harness>:<model>" picks one from its list.
      quick: z.string().default("claude-code"),
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
    .looseObject({ max_runs: z.union([z.literal("auto"), z.number().int().min(1)]).default("auto") })
    .default({ max_runs: "auto" }),
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

/** Reads the config file. Missing file → defaults. Invalid file → defaults plus a one-line error. */
export function loadUserConfig(file: string): { config: UserConfig; error: string | null } {
  if (!existsSync(file)) return { config: defaults(), error: null };
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    const first = String((e as Error).message).split("\n")[0];
    return { config: defaults(), error: `${basename(file)}: ${first}` };
  }
  const r = UserConfigSchema.safeParse(raw);
  if (!r.success) return { config: defaults(), error: describeIssue(file, r.error.issues[0]!) };
  return { config: r.data, error: null };
}

/** Writes the config atomically (temp file, then rename). */
export function saveUserConfig(file: string, c: UserConfig): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, stringify(UserConfigSchema.parse(c)), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
