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
  /** The text this session was sent. */
  text(): string;
  mcp(): unknown;
  /** ion's standing instructions for the run, if any. */
  instructions(): string;
  /** Reports a call to ion's gate like a real hook (allow when the run has no gate). */
  gate(req: Asked & { summary: string }): Promise<{ decision: string; reason?: string }>;
  wait(ms: number): Promise<"ok" | "interrupted">;
};

const say = (s: Script, text: string) => {
  s.emit({ type: EV.messageDelta, data: { text } });
  s.emit({ type: EV.messageCompleted, data: { text } });
};

type ToolStart = {
  toolId: string;
  name: string;
  kind: "read" | "edit" | "command";
  summary: string;
  input?: string;
};
const tool = (s: Script, data: ToolStart) => s.emit({ type: EV.toolStarted, data });

const done = (s: Script, toolId: string, ok: boolean, summary: string | null = null) =>
  s.emit({ type: EV.toolFinished, data: { toolId, ok, summary } });

const edited = (s: Script) =>
  s.emit({ type: EV.fileChanged, data: { path: "notes.md", change: "add", added: 1, removed: null } });

type IonServer = { url: string; headers: Record<string, string> };

/** Calls one of ion's MCP tools over HTTP, as an agent's MCP client would (stateless: no handshake needed). */
const callIon = (server: IonServer, name: string, args: Record<string, unknown>) =>
  fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });

/** A tool of ion's, as a step of the session (so its turn shows its work): what it answered, or "" when refused. */
async function ionTool(s: Script, server: IonServer, name: string, args: Record<string, unknown>) {
  const toolId = `ion-${name}-${String(args.projectId ?? "")}`;
  tool(s, { toolId, name: `mcp__ion__${name}`, kind: "read", summary: name });
  const res = await callIon(server, name, args).catch(() => null);
  // ion's server unreachable: the step failed, as an agent's MCP client would say.
  if (!res) {
    done(s, toolId, false);
    return "";
  }
  const body = (await res.json().catch(() => null)) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
  } | null;
  const ok = res.ok && !body?.result?.isError;
  done(s, toolId, ok);
  return ok ? (body?.result?.content?.[0]?.text ?? "") : "";
}

/** How an ion's turn answers a thread's end ("A thread you started has ended: <status>. …"), or null. */
function endOf(message: string): string | null {
  const status = /^A thread you started has ended: (\w+)\./.exec(message)?.[1];
  if (!status) return null;
  return status === "done" ? "It's done." : "It didn't finish.";
}

/** The projects a message names: "please check <a> and <b> for …", each the first word of its part. */
function namedIn(message: string): string[] {
  return (message.split("please check ")[1] ?? "")
    .replaceAll(" and ", ",")
    .split(",")
    .map((p) => p.trim().split(/\s+/)[0]!)
    .filter(Boolean);
}

/** An ion's turn on your message (see SCENARIOS.ion). */
async function ionTurn(s: Script): Promise<"done" | "failed" | "interrupted"> {
  const server = s.mcp() as IonServer | null;
  if (!server) return "failed";
  const message = s.text();
  const listed = await ionTool(s, server, "projects", {});
  const first = /^(\S+): /m.exec(listed)?.[1] ?? "nothing";
  const edit = message.includes("try-edit") && !(await tryEdit(s)) ? "I couldn't edit notes.md. " : "";
  if (message.includes("take-your-time") && (await s.wait(30_000)) === "interrupted") return "interrupted";
  let started = 0;
  for (const projectId of namedIn(message))
    if (await ionTool(s, server, "start_thread", { projectId, brief: message })) started++;
  const asked = `Asked ${started} project${started === 1 ? "" : "s"}.`;
  say(s, edit + (started ? asked : `This is ${first}.`));
  return "done";
}

/** "try-edit": an ion's agent tries to write a file, as a harness would, through ion's gate first. */
async function tryEdit(s: Script): Promise<boolean> {
  const input = { file_path: "notes.md", content: "hello\n" };
  tool(s, { toolId: "edit", name: "Write", kind: "edit", summary: "notes.md" });
  const g = await s.gate({ kind: "edit", toolName: "Write", input, summary: "notes.md" });
  if (g.decision === "allow") s.write("notes.md", "hello\n");
  done(s, "edit", g.decision === "allow", g.decision === "allow" ? null : "Not allowed");
  return g.decision === "allow";
}

const transient = async (s: Script) => {
  s.emit({ type: EV.error, data: { code: "rate_limit", retryable: true, message: "Rate limited" } });
  return "failed" as const;
};

export const SCENARIOS: Record<string, (s: Script) => Promise<"done" | "failed" | "interrupted">> = {
  /** Says back exactly the text it was sent (to check what ion sends on a continued chat). */
  async echo(s) {
    say(s, s.text());
    return "done";
  },
  /** Says the MCP server ion gave this session, as JSON (or null). */
  async instructions(s) {
    say(s, s.instructions());
    return "done";
  },
  async mcpinfo(s) {
    say(s, JSON.stringify(s.mcp()));
    return "done";
  },
  /** Answers like ion's judge: deny when the action mentions "deny-me", else allow. */
  async judge(s) {
    const deny = s.text().includes("deny-me");
    say(
      s,
      JSON.stringify(
        deny ? { allow: false, reason: "Looks risky" } : { allow: true, reason: "Part of the task" },
      ),
    );
    return "done";
  },
  async hello(s) {
    say(s, "Hi from the fake harness.");
    return "done";
  },
  async edit(s) {
    tool(s, {
      toolId: "t1",
      name: "Read",
      kind: "read",
      summary: "README.md",
      input: '{\n  "file_path": "README.md"\n}',
    });
    s.emit({ type: EV.toolOutput, data: { toolId: "t1", text: "# repo" } });
    done(s, "t1", true);
    tool(s, {
      toolId: "t2",
      name: "Write",
      kind: "edit",
      summary: "notes.md",
      input: '{\n  "file_path": "notes.md",\n  "content": "hello\\n"\n}',
    });
    s.write("notes.md", "hello\n");
    s.emit({ type: EV.toolOutput, data: { toolId: "t2", text: "Wrote notes.md" } });
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
  /** "gated <command>": reports the command at the gate, then asks permission as a harness would, then says. */
  async gated(s) {
    const command = s.text().trim().split(/\s+/).slice(1).join(" ");
    const req = { kind: "command", toolName: "Bash", input: { command } };
    tool(s, { toolId: "t1", name: "Bash", kind: "command", summary: command });
    const g = await s.gate({ ...req, summary: command });
    const asked = await s.ask("t1", command, req);
    const ran = g.decision === "allow" && asked !== "deny";
    done(s, "t1", ran, ran ? null : "Not allowed");
    say(s, ran ? "Ran it." : `Blocked: ${g.reason ?? "denied"}`);
    return "done";
  },
  /**
   * An ion's turn (ion chief or a project's): looks its projects up, starts a thread in each project the message
   * names ("please check <a> and <b> for …": a project is the first word of each), tries a write when it says
   * "try-edit", waits on "take-your-time", and replies "Asked <n> projects." or "This is <its first project>.". A
   * thread's end is answered "It's done." (or "It didn't finish.").
   */
  async ion(s) {
    const ended = endOf(s.text());
    if (!ended) return ionTurn(s);
    // A thread's end: it looks with ion's tools first (as an agent would), then says it in a word, starting nothing.
    const server = s.mcp() as IonServer | null;
    const listed = server ? await ionTool(s, server, "projects", {}).catch(() => "") : "";
    if (!listed) return "failed";
    say(s, ended);
    return "done";
  },
  /** Asks the user through ion's MCP server (tool "ask"), then ends its turn, as told. */
  async asks(s) {
    const server = s.mcp() as IonServer | null;
    if (!server) return "failed";
    const choices = [
      {
        label: "Merge the fix into main now",
        consequence: "Ships today; the tests pass, and it touches only the cart drawer",
        recommended: true,
      },
      {
        label: "Wait until you've tried it yourself",
        consequence: "Safer if you want to see it first; the branch stays open meanwhile",
      },
    ];
    const res = await callIon(server, "ask", {
      question: "Should I merge the cart drawer fix into main now?",
      why: "The tests pass and the change touches only the cart drawer, so merging is low risk.",
      choices,
    });
    // Like an agent: it ends its turn with a word, not ion's raw reply (the tour once showed the JSON).
    say(s, res.ok ? "I asked you whether to merge." : "I couldn't ask you.");
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
