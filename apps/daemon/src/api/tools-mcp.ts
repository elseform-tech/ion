import type { McpToolInfo } from "@ion/schema";
import { matchOf } from "../tools/own.js";
import type { OAuth } from "../secrets/oauth.js";
import {
  keysNeeded,
  type McpServer,
  refsOf,
  shownArgs,
  shownCommand,
  shownHost,
  type Tools,
} from "../tools/index.js";
import { consentOf, turnedOn } from "../tools/on.js";

const firstRef = (o: Record<string, string>) => Object.keys(o).find((k) => /\$\{\w+/.test(o[k]!));

/** A server as the app sees it: names, never values (only a remote server's host; a command's safe arguments). */
function toolOf(s: McpServer, on: boolean): McpToolInfo {
  return { ...toolBase(s, on), match: matchOf(s) };
}

function toolBase(s: McpServer, on: boolean): McpToolInfo {
  const base = { id: s.name, name: s.name, on, keys: refsOf(s), signedIn: true };
  if (s.transport === "http") {
    const keyHeader = firstRef(s.headers) ?? Object.keys(s.headers)[0];
    return {
      ...base,
      auth: keyHeader ? "apiKey" : "none",
      transport: "http",
      url: shownHost(s.url),
      ...(keyHeader ? { keyHeader } : {}),
      headers: Object.keys(s.headers),
    };
  }
  const keyEnv = firstRef(s.env);
  return {
    ...base,
    auth: keyEnv ? "apiKey" : "none",
    transport: "stdio",
    command: shownCommand(s.command),
    args: shownArgs(s.args),
    ...(keyEnv ? { keyEnv } : {}),
    env: Object.keys(s.env),
  };
}

/**
 * A remote server with no key of its own and a sign-in: kept (signed in, or sign in again), or none yet on one
 * that's on and answers 401 (only servers you turned on are asked).
 */
async function withSignIn(oauth: OAuth, t: McpToolInfo, on: boolean): Promise<McpToolInfo> {
  if (t.transport !== "http" || t.keyHeader) return t;
  const st = await oauth.status(t.id, { probe: on });
  if (!st) return t;
  const signedIn = st === "signed in";
  return { ...t, auth: "oauth", signedIn, ...(signedIn ? {} : { needs: st }) };
}

/** Each server as the app shows it, and why the keychain couldn't be read, if it couldn't. */
export async function mcpInfo(
  { tools, oauth }: { tools: Tools; oauth: OAuth },
  servers: McpServer[],
  mcpOn: string[],
): Promise<{ mcp: McpToolInfo[]; keychain?: string }> {
  const on = turnedOn(mcpOn);
  let keychain: string | undefined;
  const mcp = await Promise.all(
    servers.map(async (s) => {
      const { on: isOn, keychain: unread, ...flags } = await consentOf(tools, s, on);
      keychain ??= unread;
      const t = { ...toolOf(s, isOn), ...flags };
      const k = await keysNeeded(s, tools.lookup);
      keychain ??= k.keychain;
      if (k.missing.length) return { ...t, signedIn: false, needs: "key" as const, missing: k.missing };
      return k.unread.length ? { ...t, signedIn: false } : withSignIn(oauth, t, isOn);
    }),
  );
  return { mcp, ...(keychain ? { keychain } : {}) };
}
