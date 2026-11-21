import { loadUserConfig } from "@ion/config";
import type { Commands, ServerTools } from "@ion/schema";
import type { IonServers } from "../ions/servers.js";
import { ionUseOf, setIonUse } from "../tools/ion-use.js";
import { UserError } from "./errors.js";
import { changeConfig } from "./settings.js";

type UseCtx = { configFile: string; ionServers?: IonServers };

/** A server's tools for Settings → Tools, each with "Ions can use"; ones ion sees for the first time are noted. */
export async function serverTools(ctx: UseCtx, id: string): Promise<ServerTools> {
  if (!ctx.ionServers) return { tools: [], problem: "Not available" };
  const listed = await ctx.ionServers.listTools(id);
  if (typeof listed === "string") return { tools: [], problem: listed };
  const was = loadUserConfig(ctx.configFile).config.tools.ionUse;
  const { tools, seen } = ionUseOf(was, id, listed);
  if (seen.length !== was.length)
    changeConfig(ctx.configFile, (c) => ({ ...c, tools: { ...c.tools, ionUse: ionUseOf(c.tools.ionUse, id, listed).seen } }));
  return { tools };
}

/** Your "Ions can use" switch for one tool, kept with what the tool is now. */
export async function turnIonUse(ctx: UseCtx, a: Commands["tools.setIonUse"]["args"]): Promise<{ ok: true }> {
  const listed = ctx.ionServers ? await ctx.ionServers.listTools(String(a.id ?? "")) : "Not available";
  if (typeof listed === "string") throw new UserError(listed);
  const tool = listed.find((t) => t.name === a.tool);
  if (!tool) throw new UserError(`Unknown tool: ${String(a.tool).slice(0, 60)}`);
  changeConfig(ctx.configFile, (c) => ({
    ...c,
    tools: { ...c.tools, ionUse: setIonUse(c.tools.ionUse, a.id, tool, a.on === true) },
  }));
  return { ok: true };
}
