import { redactor } from "../runs/servers.js";
import { envDropOf } from "../tools/env-drop.js";
import { looksLikeToken } from "../tools/shown.js";

/** Key-like characters: base64, JWTs and API keys use these. */
const WORD = /[\w.+/=-]{20,}/g;
const MASK = "•••";

/**
 * A hook's output as ion keeps it: every one of your keys (from mcp.json, the keychain or ion's environment) and
 * anything that looks like a key, masked.
 */
export async function maskKeys(text: string, configFile: string): Promise<string> {
  const { values } = await envDropOf(configFile);
  const known = redactor(values)(text);
  return known.replace(WORD, (w) => (looksLikeToken(w) ? MASK : w));
}
