import { type ChildProcess, spawn } from "node:child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { forgetGroup, recordGroup } from "./server-groups.js";

/** SIGTERM to the group, then SIGKILL this long after if any of it is still there. */
const STOP_MS = 3000;
/** One line from the server, at most this long: more and ion stops it (it "sent too much"). */
export const MAX_LINE = 16 * 1024 * 1024;
/** After its exit, what it wrote just before is still read for this long (a child may hold its pipe open). */
const DRAIN_MS = 200;

export type GroupOpts = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Where ion records its servers' process groups (swept at its next start); none: not recorded. */
  groups?: string;
};

const signal = (target: number, s: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(target, s);
    return true;
  } catch {
    return false;
  }
};

/**
 * MCP over stdio (newline-delimited JSON-RPC) to a server ion starts in its own process group, so ion stops the
 * server and everything it started. Its end is its process's exit, not its pipes closing: a child that keeps them
 * open neither hides a crash nor holds up a stop.
 */
export class GroupTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child: ChildProcess | undefined;
  private exited = false;
  private stopping = false;
  /** The line being read, in the chunks it came in (never joined until its newline comes). */
  private parts: Buffer[] = [];
  private size = 0;
  /** The most ion ever held of one line. */
  peak = 0;
  /** It wrote a line longer than MAX_LINE: ion stopped it. */
  tooMuch = false;
  private readonly exit: Promise<void>;
  private resolveExit: () => void = () => {};

  constructor(private readonly o: GroupOpts) {
    this.exit = new Promise((r) => {
      this.resolveExit = r;
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.o.command, this.o.args, {
        cwd: this.o.cwd,
        env: this.o.env,
        // Its own words may hold its keys: never in ion's log.
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
        windowsHide: true,
      });
      this.child = child;
      child.on("spawn", () => {
        if (this.o.groups && child.pid)
          recordGroup(this.o.groups, {
            pgid: child.pid,
            started: Date.now(),
            command: this.o.command,
          });
        resolve();
      });
      child.on("error", (e) => {
        if (child.pid === undefined) {
          reject(e);
          this.ended();
        } else this.onerror?.(e);
      });
      child.on("exit", () => this.ended());
      child.stdout?.on("data", (c: Buffer) => this.read(c));
      child.stdout?.on("error", (e) => this.onerror?.(e));
      child.stdin?.on("error", (e) => this.onerror?.(e));
    });
  }

  /** Each newline is looked for once, in the chunk it came in. */
  private read(chunk: Buffer): void {
    let rest = chunk;
    for (let nl = rest.indexOf(10); nl >= 0; nl = rest.indexOf(10)) {
      if (this.size + nl > MAX_LINE) return this.overflow();
      this.parts.push(rest.subarray(0, nl));
      this.peak = Math.max(this.peak, this.size + nl);
      const line = Buffer.concat(this.parts).toString("utf8").replace(/\r$/, "");
      this.parts = [];
      this.size = 0;
      rest = rest.subarray(nl + 1);
      this.parse(line);
    }
    if (!rest.length) return;
    if (this.size + rest.length > MAX_LINE) return this.overflow();
    this.parts.push(rest);
    this.size += rest.length;
    this.peak = Math.max(this.peak, this.size);
  }

  private parse(line: string): void {
    if (!line.trim()) return;
    try {
      this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
    } catch (e) {
      this.onerror?.(e as Error);
    }
  }

  /** Too much in one line: ion says so, stops reading, and stops the server the normal way (close). */
  private overflow(): void {
    if (this.tooMuch) return;
    this.tooMuch = true;
    this.parts = [];
    this.size = 0;
    this.onerror?.(new Error("server sent too much"));
    this.child?.stdout?.destroy();
    const c = this.child;
    if (c && c.exitCode === null && c.signalCode === null) void this.close();
  }

  /**
   * Its process exited. When it stopped by itself, what it started goes now: the group still has members, so its id
   * is still the one ion started (never reused while it has any). Then nothing is signalled again.
   */
  private ended(): void {
    if (this.exited) return;
    this.exited = true;
    const pid = this.child?.pid;
    if (pid && !this.stopping) {
      if (signal(-pid, 0)) signal(-pid, "SIGKILL");
      if (this.o.groups) forgetGroup(this.o.groups, pid);
    }
    // What it wrote just before it exited is read first, unless a child keeps its pipe open.
    const out = this.child?.stdout;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      out?.destroy();
      this.child?.stdin?.destroy();
      this.resolveExit();
      this.onclose?.();
    };
    if (!out || out.readableEnded || out.destroyed) return finish();
    out.once("end", finish);
    out.once("close", finish);
    setTimeout(finish, DRAIN_MS).unref();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (this.exited || !stdin?.writable) throw new Error("Not connected");
    if (!stdin.write(`${JSON.stringify(message)}\n`))
      await new Promise<void>((r) => stdin.once("drain", () => r()));
  }

  /**
   * Stops the server and everything it started: SIGTERM to its group, SIGKILL after STOP_MS if any of it is still
   * there. Waits for its exit, never for its pipes. Once it has exited (by itself, or a start that failed), nothing
   * is signalled.
   */
  async close(): Promise<void> {
    if (this.stopping) return this.exit;
    this.stopping = true;
    const pid = this.child?.pid;
    if (!pid || this.exited) return;
    signal(-pid, "SIGTERM");
    const deadline = Date.now() + STOP_MS;
    while (Date.now() < deadline && (!this.exited || signal(-pid, 0)))
      await new Promise((r) => setTimeout(r, 50));
    if (!this.exited || signal(-pid, 0)) signal(-pid, "SIGKILL");
    await Promise.race([this.exit, new Promise((r) => setTimeout(r, 1000).unref())]);
    if (this.o.groups) forgetGroup(this.o.groups, pid);
  }
}
