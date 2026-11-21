import { sameMark } from "../secrets/consent-key.js";
import { CANT_READ_KEYCHAIN } from "../secrets/index.js";
import type { McpServer } from "./mcp-file.js";
import type { Tools } from "./index.js";

/** The servers you turned on, by name: what each ran then ("<name>@<consent mark>" in your config). */
export function turnedOn(mcpOn: string[]): Map<string, string> {
  return new Map(mcpOn.map((e) => [e.slice(0, e.lastIndexOf("@")), e.slice(e.lastIndexOf("@") + 1)]));
}

type Consent = { on: boolean; new?: true; changed?: true; keychain?: string };

/**
 * On only while it runs what you turned on (its record verifies with ion's key); new (never turned on) or changed (it
 * runs something else) are off. A keychain that can't be read: off, and said.
 */
export async function consentOf(
  tools: Pick<Tools, "consent">,
  s: McpServer,
  on: Map<string, string>,
): Promise<Consent> {
  const was = on.get(s.name);
  if (was === undefined) return { on: false, new: true };
  const now = await tools.consent(s).catch(() => null);
  if (now === null) return { on: false, keychain: CANT_READ_KEYCHAIN };
  return sameMark(was, now) ? { on: true } : { on: false, changed: true };
}
