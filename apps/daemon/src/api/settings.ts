import { DEFAULT_PROJECT, loadUserConfig, saveUserConfig, type UserConfig } from "@ion/config";
import { chatsView } from "../views/chats.js";
import { runsView } from "../views/runs.js";
import type { ProjectPatch } from "@ion/schema";
import { harnessIds } from "../adapters/registry.js";
import type { Handlers } from "./commands.js";
import { UserError } from "./errors.js";

/** Loads your config, changes it, saves it; a refusal (or a config that doesn't parse) is the error you see. */
export function changeConfig(file: string, change: (c: UserConfig) => UserConfig): void {
  const { config, error } = loadUserConfig(file);
  if (error) throw new UserError(`Fix your config first. ${error}`);
  try {
    saveUserConfig(file, change(config));
  } catch (e) {
    throw new UserError((e as Error).message);
  }
}

const EFFORTS = ["low", "medium", "high", "max"];

/** "<agent>" or "<agent>:<model>", with an agent ion knows. */
function checkAgent(spec: string): string {
  const id = spec.split(":")[0] ?? "";
  if (!harnessIds().includes(id)) throw new UserError(`Unknown agent: ${id}`);
  return spec;
}

/** Each field of the patch checked; undefined: leave it, null: clear it. */
function checked(p: ProjectPatch): Omit<ProjectPatch, "projectId"> {
  if (p.harness) checkAgent(p.harness);
  if (p.color && !/^#[0-9a-fA-F]{6}$/.test(p.color)) throw new UserError("Pick a colour");
  if (p.effort && !EFFORTS.includes(p.effort)) throw new UserError("Pick low, medium, high or max");
  if (p.access && p.access !== "auto" && p.access !== "full") throw new UserError("Pick auto or full");
  if (p.model !== undefined && p.model !== null && !p.model.trim()) throw new UserError("Pick a model");
  // Only these: anything else sent (a path, an id) is never written.
  const fields: Record<string, unknown> = {};
  for (const k of PATCHABLE) if (k in p) fields[k] = p[k];
  return fields as Omit<ProjectPatch, "projectId">;
}

const PATCHABLE = ["harness", "color", "model", "effort", "access", "shareWithIon"] as const;

/** Sets the given fields on one project; a null removes the field (its default applies again). */
function patchProject(c: UserConfig, p: ProjectPatch): UserConfig {
  if (!c.projects.some((x) => x.id === p.projectId)) throw new UserError(`Unknown project: ${p.projectId}`);
  const fields = checked(p);
  return {
    ...c,
    projects: c.projects.map((x) => {
      if (x.id !== p.projectId) return x;
      const next: Record<string, unknown> = { ...x };
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        if (v === null) delete next[k];
        else next[k] = v;
      }
      return next as typeof x;
    }),
  };
}

/** Settings: a project ion's setup and rules, and ion's own quick model. */
export const settingsHandlers: Pick<
  Handlers,
  "project.update" | "settings.get" | "settings.update" | "ion.stats"
> = {
  "ion.stats": (a, ctx) => {
    const ionId = String(a.ionId ?? "");
    const known =
      ionId === "chief" || loadUserConfig(ctx.configFile).config.projects.some((p) => p.id === ionId);
    if (!known || ionId === DEFAULT_PROJECT) throw new UserError(`Unknown ion: ${ionId}`);
    const threads = chatsView
      .list(ctx.db)
      .filter((c) => c.by === "ion" && (ionId === "chief" || c.projectId === ionId))
      .map((c) => c.chatId);
    return runsView.stats(ctx.db, threads, new Date());
  },
  "project.update": (a, ctx) => {
    changeConfig(ctx.configFile, (c) => patchProject(c, a));
    return { ok: true as const };
  },
  "settings.get": (_a, ctx) => ({ quick: loadUserConfig(ctx.configFile).config.ion.quick }),
  "settings.update": (a, ctx) => {
    const quick = a.quick === undefined ? undefined : checkAgent(String(a.quick));
    changeConfig(ctx.configFile, (c) => (quick ? { ...c, ion: { ...c.ion, quick } } : c));
    return { ok: true as const };
  },
};
