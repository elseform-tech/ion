import type { AdapterEvent, Decision } from "@ion/adapter-kit";
import { EV } from "@ion/schema";

type Asked = { kind: string; toolName: string; input: Record<string, unknown> };

/** What a scenario can do: emit events, ask for approval, wait (and notice interrupts). */
export type Script = {
  emit(e: AdapterEvent): void;
  /** Asks permission; by default to write notes.md in the working folder. */
  ask(toolId: string, summary: string, req?: Asked): Promise<Decision>;
  /** Writes a file in the working folder (the run's cwd), like a real agent would. */
  write(file: string, content: string): void;
  /** How many sessions have started in this working folder, this one included (retries are new sessions). */
  tries(): number;
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

const transient = async (s: Script) => {
  s.emit({ type: EV.error, data: { code: "rate_limit", retryable: true, message: "Rate limited" } });
  return "failed" as const;
};

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
    s.write("notes.md", "hello\n");
    done(s, "t1", true);
    edited(s);
    say(s, "Wrote notes.md.");
    return "done";
  },
  async shell(s) {
    tool(s, { toolId: "t1", name: "Bash", kind: "command", summary: "pnpm test" });
    const decision = await s.ask("t1", "Run pnpm test", {
      kind: "command",
      toolName: "Bash",
      input: { command: "pnpm test" },
    });
    done(s, "t1", decision !== "deny", decision === "deny" ? "Not allowed" : null);
    say(s, decision === "deny" ? "I wasn't allowed to run the tests." : "Tests pass.");
    return "done";
  },
  async outside(s) {
    tool(s, { toolId: "t1", name: "Write", kind: "edit", summary: "/etc/ion-test.txt" });
    const decision = await s.ask("t1", "Write /etc/ion-test.txt", {
      kind: "edit",
      toolName: "Write",
      input: { file_path: "/etc/ion-test.txt" },
    });
    done(s, "t1", false, decision === "deny" ? "Not allowed" : "Read-only file system");
    return "done";
  },
  async fail(s) {
    s.emit({
      type: EV.error,
      data: { code: "crash", retryable: false, message: "The fake harness crashed" },
    });
    return "failed";
  },
  /** Rate-limited twice, then fine: retries should get it through. */
  async flaky(s) {
    if (s.tries() < 3) return transient(s);
    say(s, "Done after retrying.");
    return "done";
  },
  /** Always rate-limited. */
  async overloaded(s) {
    return transient(s);
  },
  async slow(s) {
    tool(s, { toolId: "t1", name: "Bash", kind: "command", summary: "sleep 30" });
    const r = await s.wait(30_000);
    done(s, "t1", r === "ok");
    return r === "ok" ? "done" : "interrupted";
  },
};
