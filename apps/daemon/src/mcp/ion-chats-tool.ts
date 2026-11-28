import { loadUserConfig, saveUserConfig, type UserConfig } from "@ion/config";
import type { EffortLevel, HarnessInfo } from "@ion/schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../api/errors.js";
import { agentLabel, listedHarnessIds } from "../adapters/registry.js";
import type { IonScope } from "./grants.js";
import { guard, ok } from "./result.js";
import type { Confirm } from "../ions/confirms.js";

type Args = { projectId?: string; harness?: string; model?: string; effort?: EffortLevel; clear?: boolean };

const EFFORT_LABEL: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", max: "Max" };

/** "Codex · gpt-5.6-sol · Low": what was saved, by its names. */
const said = (a: Args) =>
  [agentLabel(a.harness!), a.model, a.effort && EFFORT_LABEL[a.effort]].filter(Boolean).join(" · ");

/** What you asked for, checked: an agent ion knows, signed in, with that model for your sign-in. */
async function checked(a: Args, agent?: (id: string) => Promise<HarnessInfo | undefined>): Promise<void> {
  // Only agents the app lists (PR #36 final review, 2026-11-24).
  if (!a.harness || !listedHarnessIds().includes(a.harness))
    throw new UserError(`Unknown agent: ${a.harness ?? ""}`);
  const h = await agent?.(a.harness).catch(() => undefined);
  if (!agent) return;
  if (!h?.installed || !h.signedIn) throw new UserError(`${agentLabel(a.harness)} isn't signed in`);
  if (a.model && !h.models.some((m) => m.id === a.model))
    throw new UserError(
      `${h.label} can't use ${a.model} with this sign-in: it has ${h.models.map((m) => m.id).join(", ")}`,
    );
}

/** The project's own agent, model and effort for its ion's chats, set or cleared. */
function projectSet(c: UserConfig, projectId: string, a: Args): UserConfig {
  const projects = c.projects.map((p) => {
    if (p.id !== projectId) return p;
    const rest = { ...p };
    delete rest.harness;
    delete rest.model;
    delete rest.effort;
    if (a.clear) return rest;
    return {
      ...rest,
      harness: a.harness!,
      ...(a.model ? { model: a.model } : {}),
      ...(a.effort ? { effort: a.effort } : {}),
    };
  });
  return { ...c, projects };
}

/** "Chats ions start run on", set or cleared (back to Automatic). */
function allSet(c: UserConfig, a: Args): UserConfig {
  const ion = { ...c.ion };
  delete ion.chats;
  delete ion.chatsEffort;
  if (a.clear) return { ...c, ion };
  const chats = [a.harness, a.model].filter(Boolean).join(":");
  return { ...c, ion: { ...ion, chats, ...(a.effort ? { chatsEffort: a.effort } : {}) } };
}

/**
 * set_chats_model (the user, 2026-11-24): "from now on …" said to an ion asks you to save what its project's chats
 * run on (the project's own, as on its page → More); said to ion chief about all projects, "Chats ions start run on".
 * Only your click on the confirm saves it; `clear` (back to the default) applies at once. Never in a report; only
 * projects this ion may see.
 */
export function registerChatsTool(
  server: McpServer,
  o: {
    scope: IonScope;
    configFile: string;
    need: (projectId: string) => unknown;
    agent?: (id: string) => Promise<HarnessInfo | undefined>;
    /** Your one-click confirm in the ion's thread: a save waits for it. */
    confirm?: (ionId: string, c: Confirm) => void;
  },
): void {
  server.registerTool(
    "set_chats_model",
    {
      description:
        'Only when the user says so for the future ("from now on", "always", "back to the default"): ask the user to save the agent, model and effort the chats you start in a project run on (projectId), or, for ion chief when the user means all projects, every chat ions start (no projectId). The user saves it with one click; say so. clear: back to the default, at once. For one chat only, pass harness/model/effort to start_thread instead.',
      inputSchema: {
        projectId: z.string().min(1).optional(),
        ...brainArgs(),
        clear: z.boolean().optional(),
      },
    },
    guard((a: Args) => save(o, a)),
  );
}

/** An agent (by id), model and effort an ion passes along: start_thread's and set_chats_model's. */
export const brainArgs = () => ({
  harness: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(`The agent's id: ${listedHarnessIds().join(", ")}`),
  model: z.string().min(1).max(100).optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
});

/** Checks what was asked and saves it; the one line saying what changed. */
async function save(o: Parameters<typeof registerChatsTool>[1], a: Args): Promise<ReturnType<typeof ok>> {
  if (o.scope.report) throw new UserError("Not in a report");
  if (!a.projectId && o.scope.ionId !== "chief") throw new UserError("Name the project");
  if (a.projectId) o.need(a.projectId);
  // Back to the default only narrows: at once. A save waits for your click (security scan, 2026-11-24).
  if (a.clear) return ok(write(o.configFile, a));
  await checked(a, o.agent);
  if (!o.confirm) throw new UserError("Can't ask the user here");
  const question = `Save: ${target(o.configFile, a.projectId)} run on ${said(a)}?`;
  const act = async () => {
    // Still yours to save when you click (security scan, 2026-11-24): the project still the ion's, never a report.
    if (o.scope.report) throw new UserError("Not in a report");
    if (a.projectId) o.need(a.projectId);
    return write(o.configFile, a);
  };
  o.confirm(o.scope.ionId, { question, yes: "Save", act });
  return ok(`Asked the user: ${question}`);
}

/** What a save is for, by name: "storefront's chats", or "chats ions start in all projects". */
function target(configFile: string, projectId: string | undefined): string {
  if (!projectId) return "chats ions start in all projects";
  const p = loadUserConfig(configFile).config.projects.find((x) => x.id === projectId);
  return `${p?.name ?? projectId}'s chats`;
}

/** Saves it (read again now: what's there when you click) and says what changed. */
function write(configFile: string, a: Args): string {
  const { config, error } = loadUserConfig(configFile);
  if (error) throw new UserError("Can't read the config");
  saveUserConfig(configFile, a.projectId ? projectSet(config, a.projectId, a) : allSet(config, a));
  return savedLine(a);
}

/** "This project's chats now run on Codex · gpt-5.6-sol", or that they're back to the default. */
function savedLine(a: Args): string {
  if (a.projectId)
    return a.clear
      ? "This project's chats are back to the default"
      : `This project's chats now run on ${said(a)}`;
  return a.clear ? "Chats ions start are back to Automatic" : `Chats ions start now run on ${said(a)}`;
}
