import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { ToolCheck, ToolType } from "@ion/schema";
import { removeServer } from "../tools/mcp-file.js";
import { searchRegistry } from "../tools/registry.js";
import type { Ctx, Handlers } from "./commands.js";
import { UserError } from "./errors.js";
import { changeConfig } from "./settings.js";
import { addTool } from "./tools-add.js";
import { doctor, skillCheck } from "./tools-doctor.js";
import { type Entry, entries, entry, itemOf, kindOf, originOf } from "./tools-entries.js";
import { hookChange } from "./tools-hooks.js";

/** A chat's agent removes only what its own chat added; you remove anything. */
function mayRemove(ctx: Ctx, e: Entry): void {
  if (!ctx.caller) return;
  if (originOf(ctx, e.kind, e.id, e.hash)?.chatId !== ctx.caller.chatId)
    throw new UserError("Only what this chat added can be removed from a chat");
}

const others = (records: string[], id: string) =>
  records.filter((r) => r.slice(0, r.lastIndexOf("@")) !== id);

async function remove(ctx: Ctx, kind: ToolType, name: string): Promise<void> {
  const e = await entry(ctx, kind, name);
  mayRemove(ctx, e);
  if (kind === "mcp") {
    removeServer(ctx.tools.file.path, e.id);
    changeConfig(ctx.configFile, (c) => ({
      ...c,
      tools: { ...c.tools, mcpOn: others(c.tools.mcpOn, e.id) },
    }));
  } else if (kind === "hook") {
    await hookChange({ configFile: ctx.configFile, sign: ctx.tools.sign }, { op: "remove", id: e.id });
  } else {
    if (e.skill?.whose !== "ion" || !ctx.skills.ionDir)
      throw new UserError("Only skills added with ion can be removed");
    rmSync(join(ctx.skills.ionDir, basename(e.id)), { recursive: true, force: true });
    changeConfig(ctx.configFile, (c) => ({
      ...c,
      tools: { ...c.tools, skills: { ...c.tools.skills, on: others(c.tools.skills.on, e.id) } },
    }));
  }
  ctx.added.drop(kind, e.id);
}

/**
 * `ion <mcp|skills|hooks> …`, for you and for a chat's agent (its run's key): search the MCP Registry, add (always off:
 * you turn it on in Settings → Tools), verify, doctor (never starting anything off), remove and list.
 */
export const toolsCliHandlers: Pick<
  Handlers,
  "tools.search" | "tools.add" | "tools.verify" | "tools.doctor" | "tools.remove" | "tools.items"
> = {
  "tools.search": (a, ctx) => searchRegistry(ctx.net, String(a.query ?? "")),
  "tools.add": (a, ctx) => addTool(ctx, a),
  "tools.verify": async (a, ctx) => {
    const e = await entry(ctx, kindOf(a.kind), String(a.name ?? ""));
    if (e.kind === "skill") return skillCheck(ctx, e);
    return { ...itemOf(ctx, e), problems: e.why ? [e.why] : [] } satisfies ToolCheck;
  },
  "tools.doctor": (a, ctx) => doctor(ctx, kindOf(a.kind), a.name === undefined ? undefined : String(a.name)),
  "tools.remove": async (a, ctx) => {
    await remove(ctx, kindOf(a.kind), String(a.name ?? ""));
    return { ok: true as const };
  },
  "tools.items": async (a, ctx) => (await entries(ctx, kindOf(a.kind))).map((e) => itemOf(ctx, e)),
};
