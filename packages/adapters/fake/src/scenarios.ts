import type { AdapterEvent, Decision } from "@ion/adapter-kit";
import { EV } from "@ion/schema";

/** What a scenario can do: emit events, ask for approval, wait (and notice interrupts). */
export type Script = {
  emit(e: AdapterEvent): void;
  ask(toolId: string, summary: string): Promise<Decision>;
  wait(ms: number): Promise<"ok" | "interrupted">;
};

const say = (s: Script, text: string) => {
  s.emit({ type: EV.messageDelta, data: { text } });
  s.emit({ type: EV.messageCompleted, data: { text } });
};

type ToolStart = { toolId: string; name: string; kind: "read" | "edit" | "command"; summary: string };
const tool = (s: Script, data: ToolStart) => s.emit({ type: EV.toolStarted, data });

const done = (s: Script, toolId: string, ok: boolean, summary: string | null = null) =>
  s.emit({ type: EV.toolFinished, data: { toolId, ok, summary } });

const edited = (s: Script) =>
  s.emit({ type: EV.fileChanged, data: { path: "notes.md", change: "add", added: 1, removed: null } });

export const SCENARIOS: Record<string, (s: Script) => Promise<"done" | "failed" | "interrupted">> = {
  async hello(s) {
    say(s, "Hi from the fake harness.");
    return "done";
  },
  async edit(s) {
    tool(s, { toolId: "t1", name: "Read", kind: "read", summary: "README.md" });
    done(s, "t1", true);
    tool(s, { toolId: "t2", name: "Write", kind: "edit", summary: "notes.md" });
    done(s, "t2", true);
    edited(s);
    say(s, "Added notes.md.");
    return "done";
  },
  async approve(s) {
    tool(s, { toolId: "t1", name: "Write", kind: "edit", summary: "notes.md" });
    const decision = await s.ask("t1", "Write notes.md");
    if (decision === "deny") {
      done(s, "t1", false, "Not allowed");
      say(s, "I wasn't allowed to write notes.md.");
      return "done";
    }
    done(s, "t1", true);
    edited(s);
    say(s, "Wrote notes.md.");
    return "done";
  },
  async fail(s) {
    s.emit({
      type: EV.error,
      data: { code: "crash", retryable: false, message: "The fake harness crashed" },
    });
    return "failed";
  },
  async slow(s) {
    tool(s, { toolId: "t1", name: "Bash", kind: "command", summary: "sleep 30" });
    const r = await s.wait(30_000);
    done(s, "t1", r === "ok");
    return r === "ok" ? "done" : "interrupted";
  },
};
