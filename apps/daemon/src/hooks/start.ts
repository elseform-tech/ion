import { hookSandbox } from "../runs/sandbox.js";
import type { Sign } from "../secrets/consent-key.js";
import type { Db, EventStore } from "../store/index.js";
import { Hooks } from "./index.js";
import type { HookIon } from "./reach.js";

/**
 * Your hooks, hearing every event stored from now on (until the store closes with the daemon). Sandboxed (automated
 * review, 2026-11-21: a hook can run code an agent wrote in the project), with `ion` reachable from inside.
 */
export function startHooks(
  d: { store: EventStore; db: Db; opts: { dataDir: string; configFile: string }; tools: { sign: Sign } },
  o: Omit<HookIon, "port"> & { base: () => string },
): Hooks {
  const sandbox = hookSandbox(d.opts, o.bin);
  const ion = { ...o, port: () => Number(new URL(o.base()).port) };
  const hooks = new Hooks({
    ...{ store: d.store, db: d.db, configFile: d.opts.configFile, sign: d.tools.sign },
    ...{ ion, ...(sandbox ? { sandbox } : {}) },
  });
  hooks.start();
  return hooks;
}
