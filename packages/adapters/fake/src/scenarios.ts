import { type AdapterEvent, type Decision, ION_SERVER, type HttpMcpSpec } from "@ion/adapter-kit";
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
  /** Every MCP server the run was given, ion's first. */
  servers(): HttpMcpSpec[];
  /** What ion added to the agent process's environment. */
  env(): Record<string, string>;
  /** The environment the agent's process would start with (ion's, less what it may not inherit). */
  inherited(): NodeJS.ProcessEnv;
  /** ion's standing instructions for the run, if any. */
  instructions(): string;
  /** Reports a call to ion's gate like a real hook (allow when the run has no gate). */
  gate(req: Asked & { summary: string }): Promise<{ decision: string; reason?: string }>;
  wait(ms: number): Promise<"ok" | "interrupted">;
};

/** ion's own MCP server for the run, if it has one. */
const ionServer = (s: Script): IonServer | null => {
  const m = s.servers().find((x) => x.name === ION_SERVER);
  return m?.transport === "http" ? m : null;
};

const say = (s: Script, text: string) => {
  s.emit({ type: EV.messageDelta, data: { text } });
  s.emit({ type: EV.messageCompleted, data: { text } });
};

type ToolStart = {
  toolId: string;
  name: string;
  kind: "read" | "edit" | "command" | "web";
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
  const server = ionServer(s);
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

/** A search result the fake's web search finds. */
const FAKE_FOUND = "https://nodejs.org/en/about/previous-releases";

/**
 * "try-web": an ion's agent searches the web, then reads the page it found, the address in your message, and one it
 * made up, each through ion's gate first; it says what it read and what was refused.
 */
async function tryWeb(s: Script, message: string): Promise<string> {
  tool(s, { toolId: "ws", name: "WebSearch", kind: "web", summary: "node", input: '{"query":"node"}' });
  s.emit({ type: EV.toolOutput, data: { toolId: "ws", text: `Links: [{"url":"${FAKE_FOUND}"}]` } });
  done(s, "ws", true);
  const given = /https:\/\/\S+/.exec(message)?.[0];
  const said: string[] = [];
  for (const url of [FAKE_FOUND, ...(given ? [given] : []), "https://made.up/x"]) {
    const input = { url, prompt: "the version" };
    tool(s, { toolId: url, name: "WebFetch", kind: "web", summary: url });
    const g = await s.gate({ kind: "web", toolName: "WebFetch", input, summary: url });
    done(s, url, g.decision === "allow");
    said.push(g.decision === "allow" ? `Read ${url}.` : `Refused ${url}: ${g.reason ?? "denied"}.`);
  }
  return said.join(" ");
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
  /**
   * Lists the run's MCP servers (names and kinds; every one is ion's URL for it). "retry-once": the first try then
   * fails.
   */
  async mcplist(s) {
    const list = s.servers().map((m) => ({ name: m.name, transport: m.transport }));
    say(s, JSON.stringify(list));
    if (!s.text().includes("retry-once") || s.tries() > 1) return "done";
    await s.wait(300);
    return transient(s);
  },
  /**
   * An agent that prints what it was given, as a careless one could (`env`, `ps eww`): every MCP server's header
   * values, in its thinking, a tool's input and output, and its message.
   */
  async leak(s) {
    const values = s.servers().flatMap((m) => Object.values(m.headers));
    s.emit({ type: EV.thinkingDelta, data: { text: `I have ${values.join(" and ")}` } });
    tool(s, {
      toolId: "ps",
      name: "Bash",
      kind: "command",
      summary: "ps eww",
      input: `ps eww | grep ${values[1]}`,
    });
    s.emit({
      type: EV.toolOutput,
      data: {
        toolId: "ps",
        text: `  PID COMMAND
 4242 node srv.js ${values.join(" ")}`,
      },
    });
    done(s, "ps", true);
    say(s, `ION_MCP_H1=${values[1]} ${JSON.stringify(s.servers())}`);
    return "done";
  },
  /** Fails its first try with an error that quotes its ion key, as a careless agent could; then works like slow. */
  async leakretry(s) {
    if (s.tries() > 1) return SCENARIOS.slow!(s);
    const key = Object.values(ionServer(s)?.headers ?? {})[0] ?? "";
    s.emit({ type: EV.error, data: { code: "rate_limit", retryable: true, message: `Refused ${key}` } });
    return "failed";
  },
  async mcpinfo(s) {
    say(s, JSON.stringify(ionServer(s)));
    return "done";
  },
  /** Says which of ion's test variables (`*_TEST_*`) its process would inherit. */
  async inherits(s) {
    say(
      s,
      JSON.stringify(
        Object.keys(s.inherited())
          .filter((k) => k.includes("_TEST_"))
          .sort(),
      ),
    );
    return "done";
  },
  async envinfo(s) {
    say(s, JSON.stringify(s.env()));
    return "done";
  },
  /**
   * Answers like ion's judge: deny when the action mentions "deny-me", unsure when it mentions "unsure-me" (missing
   * information), else allow (the older `allow` answer, which ion still reads).
   */
  async judge(s) {
    const t = s.text();
    if (t.includes("unsure-me"))
      say(s, JSON.stringify({ verdict: "unsure", reason: "Can't see what the script does" }));
    else if (t.includes("deny-me")) say(s, JSON.stringify({ allow: false, reason: "Looks risky" }));
    else say(s, JSON.stringify({ allow: true, reason: "Part of the task" }));
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
   * "try-edit", searches and reads pages on "try-web", waits on "take-your-time", and replies "Asked <n> projects." or "This is <its first project>.". A
   * thread's end is answered "It's done." (or "It didn't finish.").
   */
  async ion(s) {
    if (s.text().includes("try-web")) {
      say(s, await tryWeb(s, s.text()));
      return "done";
    }
    const ended = endOf(s.text());
    if (!ended) return ionTurn(s);
    // A thread's end: it looks with ion's tools first (as an agent would), then says it in a word, starting nothing.
    const server = ionServer(s);
    const listed = server ? await ionTool(s, server, "projects", {}).catch(() => "") : "";
    if (!listed) return "failed";
    say(s, ended);
    return "done";
  },
  /** Asks the user through ion's MCP server (tool "ask"), then ends its turn, as told. */
  async asks(s) {
    const server = ionServer(s);
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
