import { DEFAULT_PROJECT, projectIdOf } from "./projects.js";
import { type RoutineEntry, type UserConfig, WHEN } from "./user-config.js";

type Effort = NonNullable<RoutineEntry["effort"]>;
export type NewRoutine = { name: string; when: string; text: string; effort?: Effort; on?: boolean };
/** Each field set, or null to clear it (effort: the project's again; skip: run the next one). */
export type RoutinePatch = {
  name?: string;
  when?: string;
  text?: string;
  on?: boolean;
  effort?: Effort | null;
  skip?: string | null;
};

/** "Daily 9:00" → "daily 09:00": the one way a schedule is written. Throws when it isn't one. */
function normalWhen(when: string): string {
  const t = when
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ (\d):/, " 0$1:");
  if (!WHEN.test(t)) throw new Error("Pick when it runs");
  return t;
}

function checkedName(name: string): string {
  const n = name.trim().slice(0, 80);
  if (!n) throw new Error("Give it a name");
  return n;
}

function checkedText(text: string): string {
  const t = text.trim().slice(0, 4000);
  if (!t) throw new Error("Say what to do");
  return t;
}

/** The project's routines, after checking it can have them (`default` has no ion). */
function routinesOf(c: UserConfig, projectId: string): RoutineEntry[] {
  if (projectId === DEFAULT_PROJECT) throw new Error("default has no ion");
  const p = c.projects.find((x) => x.id === projectId);
  if (!p) throw new Error(`Unknown project: ${projectId}`);
  return p.routines ?? [];
}

function withRoutines(c: UserConfig, projectId: string, routines: RoutineEntry[]): UserConfig {
  return { ...c, projects: c.projects.map((p) => (p.id === projectId ? { ...p, routines } : p)) };
}

/** Adds a routine to a project's ion, on unless `on` is false; its id comes from its name. */
export function addRoutine(
  c: UserConfig,
  projectId: string,
  r: NewRoutine,
): { config: UserConfig; routine: RoutineEntry } {
  const list = routinesOf(c, projectId);
  const name = checkedName(r.name);
  const base = projectIdOf(name) || "routine";
  const taken = new Set(list.map((x) => x.id));
  let id = base;
  let n = 1;
  while (taken.has(id)) id = `${base}-${++n}`;
  const routine: RoutineEntry = {
    id,
    name,
    when: normalWhen(r.when),
    text: checkedText(r.text),
    on: r.on !== false,
    ...(r.effort ? { effort: r.effort } : {}),
  };
  return { config: withRoutines(c, projectId, [...list, routine]), routine };
}

/** Sets the given fields; a null removes the field. */
export function updateRoutine(c: UserConfig, projectId: string, id: string, patch: RoutinePatch): UserConfig {
  const list = routinesOf(c, projectId);
  if (!list.some((r) => r.id === id)) throw new Error(`Unknown routine: ${id}`);
  const fields: Record<string, unknown> = { ...patch };
  if (patch.name !== undefined) fields.name = checkedName(patch.name);
  if (patch.when !== undefined) fields.when = normalWhen(patch.when);
  if (patch.text !== undefined) fields.text = checkedText(patch.text);
  const next = list.map((r) => {
    if (r.id !== id) return r;
    const out: Record<string, unknown> = { ...r };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) delete out[k];
      else if (v !== undefined) out[k] = v;
    }
    return out as RoutineEntry;
  });
  return withRoutines(c, projectId, next);
}

export function removeRoutine(c: UserConfig, projectId: string, id: string): UserConfig {
  const list = routinesOf(c, projectId);
  if (!list.some((r) => r.id === id)) throw new Error(`Unknown routine: ${id}`);
  return withRoutines(
    c,
    projectId,
    list.filter((r) => r.id !== id),
  );
}
