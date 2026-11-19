import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AdapterEvent,
  createEventQueue,
  type HarnessAdapter,
  type Session,
  type StartOpts,
  ResumeFailed,
} from "@ion/adapter-kit";
import { type Capabilities, EV } from "@ion/schema";
import { SCENARIOS, type Script } from "./scenarios.js";

const CAPABILITIES: Capabilities = {
  models: [
    { id: "fake", label: "Fake" },
    { id: "fake-big", label: "Fake Big" },
  ],
  defaultModel: "fake",
  modelsLive: true,
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
const HISTORY_END = /<\/ion-data id="\w+">\n\n/;

/** Sessions started per working folder, so scenarios can behave differently on a retry. */
const triesByCwd = new Map<string, number>();

/**
 * Which scenario a message plays: an ion's turn by its instructions (ion's ions start "You are ion"; a run's
 * start "You're running under ion"), ion's judge and ion chief's routing by their first words, else its first word.
 */
function scenarioOf(text: string, own: string, instructions = ""): string {
  if (instructions.startsWith("You are ion")) return "ion";
  // ion's prompts carry data blocks too; they're recognised by their first words.
  if (text.startsWith("Judge this action")) return "judge";
  if (text.startsWith("Route this message for ion")) return "route";
  if (text.startsWith("Decide for this project's ion")) return "decide";
  if (text.startsWith("Tell the user what came of a thread")) return "report";
  return own.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function createFakeAdapter(opts: { delayMs?: number; signedIn?: boolean } = {}): HarnessAdapter {
  const signedIn = opts.signedIn ?? true;
  const delayMs = opts.delayMs ?? 5;
  return {
    id: "fake",
    detect: async () => {
      if (process.env.ION_FAKE_DETECT_FAIL) throw new Error("The fake harness didn't answer");
      return { installed: true, version: "0.0.0", path: "fake" };
    },
    auth: {
      status: async () => ({ signedIn, method: signedIn ? "Fake" : "Not signed in" }),
      login: async () => {},
    },
    capabilities: async () => CAPABILITIES,
    // The fake hook already sends ion's own shape.
    gateCall: (payload) => {
      const p = payload as
        | { toolName?: unknown; kind?: unknown; summary?: unknown; input?: unknown }
        | undefined;
      if (typeof p?.toolName !== "string" || typeof p.kind !== "string") return null;
      const input = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : {};
      return { toolName: p.toolName, kind: p.kind, summary: String(p.summary ?? ""), input };
    },
    start: async (start) => {
      // Test switches for the daemon's lifecycle tests: a slow or failing harness start.
      await new Promise((r) => setTimeout(r, Number(process.env.ION_FAKE_START_MS ?? 0)));
      if (process.env.ION_FAKE_START_FAIL) throw new Error("The fake harness didn't start");
      if (start.resume && process.env.ION_FAKE_RESUME_FAIL) throw new ResumeFailed("No such session");
      return fakeSession(start, delayMs);
    },
  };
}

/** Reports a call at ion's gate like a real hook: no gate means allow; no answer means deny (fail closed). */
async function postGate(
  gate: StartOpts["gate"],
  req: unknown,
): Promise<{ decision: string; reason?: string }> {
  if (!gate) return { decision: "allow" };
  try {
    const r = await fetch(gate.url, { method: "POST", body: JSON.stringify(req) });
    return (await r.json()) as { decision: string; reason?: string };
  } catch {
    return { decision: "deny", reason: "ion didn't answer" };
  }
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
  const tries = (triesByCwd.get(start.cwd) ?? 0) + 1;
  triesByCwd.set(start.cwd, tries);
  const nativeId = start.resume ?? `fake-${randomUUID()}`;
  let sent = "";
  const script: Script = {
    emit: (e) => queue.push(e),
    ask: (toolId, summary, req) => {
      const requestId = `q${++n}`;
      const r = req ?? { kind: "edit", toolName: "Write", input: { file_path: join(start.cwd, "notes.md") } };
      queue.push({ type: EV.approvalRequested, data: { requestId, toolId, kind: r.kind, summary } });
      return start.decide({ requestId, toolId, toolName: r.toolName, kind: r.kind, summary, input: r.input });
    },
    write: (file, content) => writeFileSync(join(start.cwd, file), content),
    tries: () => tries,
    text: () => sent,
    mcp: () => start.mcp ?? null,
    instructions: () => start.instructions ?? "",
    gate: (req) => postGate(start.gate, req),
    wait: async (ms) => {
      await sleep(ms);
      return interrupted ? "interrupted" : "ok";
    },
  };
  return {
    id: randomUUID(),
    nativeId,
    async send({ text }) {
      // The scenario is the first word of your message, after any history ion put before it.
      const own = text.split(HISTORY_END).at(-1) ?? text;
      const name = scenarioOf(text, own, start.instructions);
      const scenario = SCENARIOS[name] ?? SCENARIOS.hello!;
      sent = text;
      queue.push({
        type: EV.runStarted,
        data: {
          harness: "fake",
          model: start.model ?? "fake",
          effort: start.effort,
          authMethod: "Fake",
          sessionId: nativeId,
        },
      });
      void (async () => {
        if (delayMs) await sleep(delayMs);
        // Test switch: a resumed session that then fails for real (e.g. its context is too long).
        const resumedFails = start.resume && process.env.ION_FAKE_RESUMED_FAILS;
        if (resumedFails)
          queue.push({
            type: EV.error,
            data: { code: "agent", retryable: false, message: "Prompt too long" },
          });
        let status: Awaited<ReturnType<typeof scenario>> = "interrupted";
        if (!interrupted) status = resumedFails ? "failed" : await scenario(script);
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
      // Test switch: a harness whose close never returns.
      if (process.env.ION_FAKE_CLOSE_HANGS) await new Promise(() => {});
    },
  };
}
