import { spawn } from "node:child_process";
import { type HarnessAdapter, readVersion, whichOnPath } from "@ion/adapter-kit";
import type { Capabilities } from "@ion/schema";
import { connect, probeSignedIn, setOption } from "./connection.js";
import type { AcpHarness } from "./harnesses.js";
import { startAcpSession } from "./session.js";

export { type AcpHarness, GROK_BUILD, OPENCODE } from "./harnesses.js";

const CAPABILITIES: Capabilities = {
  models: [],
  effort: { levels: ["low", "medium", "high"], canDisableThinking: false },
  thinking: "summary",
  approvals: "interactive",
  resume: true,
  interrupt: true,
  images: false,
  mcp: true,
  skills: false,
  usage: "cost",
};

/** One adapter for any agent that speaks ACP over stdio (Grok Build, opencode, …). */
export function createAcpAdapter(
  h: AcpHarness,
  deps: { which?: (bin: string) => string | null; startTimeoutMs?: number } = {},
): HarnessAdapter {
  const which = deps.which ?? whichOnPath;
  const binary = () => which(h.bin);
  return {
    id: h.id,
    async detect() {
      const path = binary();
      if (!path) return { installed: false };
      const version = await readVersion(path, h.versionArgs);
      return { installed: true, ...(version ? { version } : {}), path };
    },
    auth: {
      async status() {
        const path = binary();
        if (!path) return { signedIn: false, method: "Not installed" };
        const probe = await probeSignedIn(h, path, deps.startTimeoutMs);
        const method = { yes: "Signed in", no: "Not signed in", "not-responding": "Not responding" }[probe];
        return { signedIn: probe === "yes", method };
      },
      login: () =>
        new Promise<void>((resolve, reject) => {
          const path = binary();
          if (!path) return reject(new Error(`${h.label} isn't installed`));
          spawn(path, h.loginArgs, { stdio: "inherit" }).on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error("Sign-in didn't finish")),
          );
        }),
    },
    capabilities: async () => CAPABILITIES,
    async start(opts) {
      const path = binary();
      if (!path) throw new Error(`${h.label} isn't installed`);
      const c = await connect(h, path, {
        cwd: opts.cwd,
        timeoutMs: deps.startTimeoutMs,
        resume: opts.resume,
      });
      const model =
        (await setOption(c, "model", opts.model ?? h.defaultModel)) ?? h.defaultModel ?? "default";
      await setOption(c, "thought_level", opts.effort === "max" ? "high" : opts.effort);
      return startAcpSession(c, opts, { harness: h.id, model });
    },
  };
}
