import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentEnv,
  type AdapterEvent,
  createEventQueue,
  type HarnessAdapter,
  type LoginRun,
  type Session,
  type StartOpts,
  ResumeFailed,
} from "@ion/adapter-kit";
import { type Capabilities, EV } from "@ion/schema";
import { ownText, SCENARIOS, type Script } from "./scenarios.js";

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

const BILLINGS = ["subscription", "api", "free"] as const;

/** Sessions started per working folder, so scenarios can behave differently on a retry. */
const triesByCwd = new Map<string, number>();

/**
 * Which scenario a message plays: an ion's turn by its instructions (ion's ions start "You are ion"; a run's
 * start "You're running under ion"), ion's judge by its first words, else its first word.
 */
function scenarioOf(text: string, own: string, instructions = ""): string {
  if (instructions.startsWith("You are ion")) return "ion";
  // ion's judge prompt carries data blocks too; it's recognised by its first words.
  if (text.startsWith("Judge this action")) return "judge";
  return own.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** The fake account's sign-in lives in ION_FAKE_SIGNED_OUT, so it lasts across adapters (the daemon makes one per use). */
const signedOut = () => process.env.ION_FAKE_SIGNED_OUT === "1";

/**
 * A scripted sign-in: a page and a code at once, signed in ION_FAKE_LOGIN_MS later (default 1.5 s), or never when
 * stopped. ION_FAKE_LOGIN=command: an agent whose login needs a terminal (only its command).
 */
function fakeLogin(signal: AbortSignal): LoginRun {
  const ms = Number(process.env.ION_FAKE_LOGIN_MS ?? 1500);
  const done = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => {
      delete process.env.ION_FAKE_SIGNED_OUT;
      resolve(true);
    }, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve(false)), { once: true });
  });
  return {
    prompt: Promise.resolve({ url: "https://example.test/fake-sign-in", code: "FAKE-0001" }),
    done,
    // No process: done ends with its signal.
    stopped: async () => {
      await done;
    },
  };
}

/** Its sign-in state (in ION_FAKE_SIGNED_OUT), and its scripted login and logout. */
function fakeAuth(): HarnessAdapter["auth"] {
  return {
    // ION_FAKE_BILLING: how it bills (the tour's agent paid per use).
    status: async () => {
      // ION_FAKE_STATUS_UNKNOWN=1: its check doesn't answer.
      if (process.env.ION_FAKE_STATUS_UNKNOWN === "1")
        return { signedIn: false, unknown: true as const, method: "Couldn't tell" };
      const signedIn = !signedOut();
      const billing = BILLINGS.find((b) => b === process.env.ION_FAKE_BILLING);
      return { signedIn, method: signedIn ? "Fake" : "Not signed in", ...(billing ? { billing } : {}) };
    },
    login: {
      command: "ion fake login",
      // ION_FAKE_LOGIN_CLEARS=1: starting it clears the sign-in it has (as Codex's does).
      ...(process.env.ION_FAKE_LOGIN_CLEARS === "1" ? { clears: true as const } : {}),
      ...(process.env.ION_FAKE_LOGIN === "command" ? {} : { start: fakeLogin }),
    },
    logout: {
      command: "ion fake logout",
      run: async () => {
        process.env.ION_FAKE_SIGNED_OUT = "1";
      },
    },
  };
}

export function createFakeAdapter(opts: { delayMs?: number } = {}): HarnessAdapter {
  const delayMs = opts.delayMs ?? 5;
  return {
    id: "fake",
    detect: async () => {
      if (process.env.ION_FAKE_DETECT_FAIL) throw new Error("The fake harness didn't answer");
      // ION_FAKE_GONE=1: its binary went away.
      if (process.env.ION_FAKE_GONE === "1") return { installed: false };
      return { installed: true, version: "0.0.0", path: "fake" };
    },
    auth: fakeAuth(),
    capabilities: async () => CAPABILITIES,
    // ION_FAKE_NO_HTTP=1: an agent that takes local servers only.
    mcpTransports: { http: process.env.ION_FAKE_NO_HTTP !== "1" },
    // ION_FAKE_CONTEXT_TOKENS: a small context, so a chat's history outgrows it in tests.
    ...(process.env.ION_FAKE_CONTEXT_TOKENS
      ? { contextTokens: Number(process.env.ION_FAKE_CONTEXT_TOKENS) }
      : {}),
    // ion's judge: a pinned model (ION_FAKE_JUDGE_MODEL: another, as when an adapter's pin changes).
    judge: { model: process.env.ION_FAKE_JUDGE_MODEL ?? "fake-judge" },
    // No web on request (ion's dream): it has no web.
    ...(process.env.ION_FAKE_HAS_WEB === "1" ? {} : { noWeb: true as const }),
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

/** This session's try in its working folder (retries are new sessions). */
function nextTry(cwd: string): number {
  const tries = (triesByCwd.get(cwd) ?? 0) + 1;
  triesByCwd.set(cwd, tries);
  return tries;
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
  let sent = "";
  const [tries, nativeId] = [nextTry(start.cwd), start.resume ?? `fake-${randomUUID()}`];
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
    servers: () => start.mcpServers ?? [],
    env: () => start.env ?? {},
    inherited: () => agentEnv(process.env, start.envDrop),
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
      const own = ownText(text);
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
        // A scenario that throws (ion's server gone mid-call) ends its turn failed, never as an unhandled rejection.
        if (!interrupted)
          status = resumedFails ? "failed" : await scenario(script).catch(() => "failed" as const);
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
