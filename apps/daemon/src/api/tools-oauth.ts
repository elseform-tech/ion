import { keysNeeded, type Tools } from "../tools/index.js";
import { UserError } from "./errors.js";

/** The connection to sign in to: a remote server in mcp.json whose own keys are all there. */
export async function remoteToSignIn(tools: Tools, id: unknown): Promise<string> {
  const name = String(id ?? "");
  const s = tools.read().servers.find((x) => x.name === name);
  if (!s) throw new UserError(`Unknown connection: ${name}`);
  if (s.transport !== "http") throw new UserError("Only remote connections sign in");
  if ((await keysNeeded(s, tools.lookup).catch(() => ({ missing: [] }))).missing.length)
    throw new UserError("Add its key first");
  return name;
}
