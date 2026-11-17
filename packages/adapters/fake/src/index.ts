import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AdapterEvent,
  createEventQueue,
  type HarnessAdapter,
  type Session,
  type StartOpts,
} from "@ion/adapter-kit";
import { type Capabilities, EV } from "@ion/schema";
import { SCENARIOS, type Script } from "./scenarios.js";

const CAPABILITIES: Capabilities = {
  models: [{ id: "fake", label: "Fake" }],
  effort: { levels: ["low", "medium", "high", "max"], canDisableThinking: true },
  thinking: "none",
  approvals: "interactive",
  resume: false,
  interrupt: true,
  images: false,
  mcp: false,
  skills: false,
  usage: "none",
};

/** A scripted harness for tests: the prompt's first word picks a scenario (hello, edit, approve, fail, slow). */
export function createFakeAdapter(opts: { delayMs?: number; signedIn?: boolean } = {}): HarnessAdapter {
  const signedIn = opts.signedIn ?? true;
  const delayMs = opts.delayMs ?? 5;
  return {
    id: "fake",
    detect: async () => ({ installed: true, version: "0.0.0", path: "fake" }),
    auth: {
      status: async () => ({ signedIn, method: signedIn ? "Fake" : "Not signed in" }),
      login: async () => {},
    },
    capabilities: async () => CAPABILITIES,
    start: async (start) => fakeSession(start, delayMs),
  };
}

function fakeSession(start: StartOpts, delayMs: number): Session {
  const queue = createEventQueue<AdapterEvent>();
  let interrupted = false;
  let wakeSleeper: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wakeSleeper = () => {
        clearTimeout(t);
        r();
      };
    });
  let n = 0;
  const script: Script = {
    emit: (e) => queue.push(e),
    ask: (toolId, summary, req) => {
      const requestId = `q${++n}`;
      const r = req ?? { kind: "edit", toolName: "Write", input: { file_path: join(start.cwd, "notes.md") } };
      queue.push({ type: EV.approvalRequested, data: { requestId, toolId, kind: r.kind, summary } });
      return start.decide({ requestId, toolId, toolName: r.toolName, kind: r.kind, summary, input: r.input });
    },
    write: (file, content) => writeFileSync(join(start.cwd, file), content),
    wait: async (ms) => {
      await sleep(ms);
      return interrupted ? "interrupted" : "ok";
    },
  };
  return {
    id: randomUUID(),
    nativeId: null,
    async send({ text }) {
      const name = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const scenario = SCENARIOS[name] ?? SCENARIOS.hello!;
      queue.push({
        type: EV.runStarted,
        data: { harness: "fake", model: start.model ?? "fake", effort: start.effort, authMethod: "Fake" },
      });
      void (async () => {
        if (delayMs) await sleep(delayMs);
        const status = interrupted ? "interrupted" : await scenario(script);
        queue.push({ type: EV.runFinished, data: { status } });
        queue.end();
      })();
    },
    events: () => queue,
    async interrupt() {
      interrupted = true;
      wakeSleeper?.();
    },
    async close() {
      queue.end();
    },
  };
}
