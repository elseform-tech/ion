import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { getHarness } from "../adapters/registry.js";

/**
 * Runs a prompt on ion's quick harness (`ion.quick` = "<harness>" or "<harness>:<model>") in an empty folder,
 * with every tool denied, and returns what it said.
 */
export function harnessRunner(configFile: string): (prompt: string, signal: AbortSignal) => Promise<string> {
  return async (prompt, signal) => {
    const spec = loadUserConfig(configFile).config.ion.quick;
    const [id, model] = [spec.split(":")[0]!, spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : null];
    const h = getHarness(id);
    if (!h) throw new Error(`Unknown harness: ${id}`);
    const dir = mkdtempSync(join(tmpdir(), "ion-judge-"));
    const session = await h.adapter.start({
      cwd: dir,
      model,
      effort: null,
      signal,
      decide: async () => "deny",
    });
    // Stopped when the judge gives up: the session closes and its folder goes.
    const stop = () => void session.close().catch(() => {});
    signal.addEventListener("abort", stop, { once: true });
    try {
      await session.send({ text: prompt });
      const said: string[] = [];
      for await (const e of session.events())
        if (e.type === EV.messageCompleted) said.push(String((e.data as { text: unknown }).text));
      return said.join("\n");
    } finally {
      await session.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
