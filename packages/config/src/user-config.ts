import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

const Effort = z.enum(["low", "medium", "high", "max"]);

const Project = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  starred: z.boolean().default(false),
});

// Loose objects keep keys this version doesn't know (newer ion, other tools), so saving never drops them.
const UserConfigSchema = z.looseObject({
  ion: z
    .looseObject({
      quick: z.string().default("claude-code:Haiku 5.5"),
      deep: z.string().default("claude-code:Opus 5.5"),
      deepEffort: Effort.default("high"),
      useDeep: z.enum(["auto", "always", "never"]).default("auto"),
    })
    .prefault({}),
  projects: z.array(Project).default([]),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;
export type ProjectEntry = UserConfig["projects"][number];

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
