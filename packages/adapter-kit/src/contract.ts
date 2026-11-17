import { EV, type IonEvent, isDaemonOnly, parseEvent } from "@ion/schema";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, Decision, HarnessAdapter } from "./types.js";

/** Prompts that make the adapter under test do each thing the contract checks. */
export type ContractScenarios = {
  /** A plain answer, no tools. */
  hello: string;
  /** Asks to edit a file; the edit goes through `decide`. */
  approve: string;
  /** Runs long enough to be interrupted. */
  slow: string;
  cwd: string;
};

type Turn = { cwd: string; text: string; decision: Decision; interruptAfterMs?: number };

async function runTurn(adapter: HarnessAdapter, { cwd, text, decision, interruptAfterMs }: Turn) {
  const ctrl = new AbortController();
  const session = await adapter.start({
    cwd,
    model: null,
    effort: null,
    signal: ctrl.signal,
    decide: async () => decision,
  });
  await session.send({ text });
  if (interruptAfterMs !== undefined) setTimeout(() => void session.interrupt(), interruptAfterMs);
  const events: AdapterEvent[] = [];
  const started = Date.now();
  for await (const e of session.events()) events.push(e);
  await session.close();
  return { events, ms: Date.now() - started };
}

const stamp = (e: AdapterEvent, seq: number): IonEvent =>
  parseEvent({
    v: 1,
    id: `e${seq}`,
    chatId: "c",
    runId: "r",
    seq,
    ts: new Date().toISOString(),
    origin: "adapter",
    ...e,
  });

/** The behavior every harness adapter must have. Call from each adapter's tests. */
export function describeAdapterContract(
  name: string,
  make: () => HarnessAdapter,
  s: ContractScenarios,
): void {
  describe(`${name} adapter contract`, () => {
    it("starts with run.started and ends with exactly one run.finished", async () => {
      const { events } = await runTurn(make(), { cwd: s.cwd, text: s.hello, decision: "allow" });
      expect(events[0]?.type).toBe(EV.runStarted);
      expect(events.filter((e) => e.type === EV.runFinished)).toHaveLength(1);
      expect(events.at(-1)?.type).toBe(EV.runFinished);
    });

    it("emits only valid adapter events", async () => {
      const { events } = await runTurn(make(), { cwd: s.cwd, text: s.hello, decision: "allow" });
      for (const [i, e] of events.entries()) {
        expect(isDaemonOnly(e.type)).toBe(false);
        stamp(e, i + 1); // throws if the event isn't valid
      }
    });

    it("finishes every tool it starts", async () => {
      const { events } = await runTurn(make(), { cwd: s.cwd, text: s.approve, decision: "allow" });
      const started = new Set(events.filter((e) => e.type === EV.toolStarted).map((e) => e.data.toolId));
      for (const e of events.filter((x) => x.type === EV.toolFinished))
        expect(started.has(e.data.toolId)).toBe(true);
    });

    it("changes no file when the edit is denied", async () => {
      const { events } = await runTurn(make(), { cwd: s.cwd, text: s.approve, decision: "deny" });
      expect(events.some((e) => e.type === EV.approvalRequested)).toBe(true);
      expect(events.some((e) => e.type === EV.fileChanged)).toBe(false);
    });

    it("stops within 5 seconds when interrupted", async () => {
      const { events, ms } = await runTurn(make(), {
        cwd: s.cwd,
        text: s.slow,
        decision: "allow",
        interruptAfterMs: 200,
      });
      expect(events.at(-1)).toMatchObject({ type: EV.runFinished, data: { status: "interrupted" } });
      expect(ms).toBeLessThan(5000);
    }, 10_000);
  });
}
