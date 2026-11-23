import { execFile, spawn } from "node:child_process";
import { agentEnv } from "./run-env.js";

/**
 * What ion shows while an agent's own sign-in runs: the page to open and the code to confirm there, nothing else of
 * what the agent prints (no account, email or token ever leaves this file).
 */
export type LoginPrompt = { url: string | null; code: string | null };

/** An agent's own sign-in that ion started: what to show, and whether it ended signed in (exit code 0). */
export type LoginRun = { prompt: Promise<LoginPrompt>; done: Promise<boolean> };

/** How you sign in to an agent: its own command, and whether ion can run it and show its page and code. */
export type AgentLogin = {
  /** The command to type in a terminal. */
  command: string;
  /** Runs it in the background (it gives a page or a code); absent: it asks in a terminal, so only the command. */
  start?(signal: AbortSignal): LoginRun;
  /** Starting it clears the sign-in the agent has first (Codex: checked on 0.153.2). */
  clears?: true;
};

/** How you sign out of an agent: its own command, and ion running it (absent: it asks in a terminal). */
export type AgentLogout = { command: string; run?(): Promise<void> };

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Where a terminal escape starting at `i` ends: a link or title (OSC, to BEL or ESC and a backslash), else a colour or move (CSI). */
function escapeEnd(text: string, i: number): number {
  let j = i + 2;
  if (text[i + 1] === "]") {
    while (j < text.length && text[j] !== BEL && !(text[j] === ESC && text[j + 1] === "\\")) j++;
    return text[j] === BEL ? j + 1 : j + 2;
  }
  if (text[i + 1] !== "[") return j;
  while (j < text.length && !/[A-Za-z]/.test(text[j]!)) j++;
  return j + 1;
}

/** Without terminal colours, cursor moves and links (an OSC 8 link keeps its text): what a person would read. */
function plainOf(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === ESC) i = escapeEnd(text, i);
    else out += text[i++];
  }
  return out;
}

/** A device code on a line of its own: letters and digits in two or more groups ("FNAS-DDR6"). */
const CODE = /^\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s*$/;

/**
 * The page and code in what an agent's login printed so far: the first https link (a local address, where its own
 * server waits, is never one to open) and a code on a line of its own.
 */
export function loginPromptOf(text: string): LoginPrompt {
  const plain = plainOf(text);
  const url = /https:\/\/[^\s"'<>]+/.exec(plain)?.[0] ?? null;
  const code =
    plain
      .split(/\r?\n/)
      .map((l) => CODE.exec(l)?.[1])
      .find((c) => !!c) ?? null;
  return { url, code };
}

/** How long a login may take to print its page before ion stops waiting for it (it keeps running). */
const PROMPT_WAIT_MS = 20_000;
/** After the page, how long a code may take to follow it (Grok prints the page, then the code). */
const CODE_WAIT_MS = 1500;
/** At most this much of a login's output is read (a page and a code are near the start). */
const READ_MAX = 16_384;

/**
 * Starts an agent's own login without a shell or a terminal, its output kept in memory only to find the page and the
 * code (never logged or stored). It ends when the agent does, or when `signal` aborts (then it's stopped).
 */
export function startLogin(
  bin: string,
  args: string[],
  o: { env?: NodeJS.ProcessEnv; signal: AbortSignal },
): LoginRun {
  const child = spawn(bin, args, { env: o.env ?? agentEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let seen = "";
  let settle: (p: LoginPrompt) => void = () => {};
  const prompt = new Promise<LoginPrompt>((resolve) => {
    let codeTimer: ReturnType<typeof setTimeout> | undefined;
    const limit = setTimeout(() => resolve(loginPromptOf(seen)), PROMPT_WAIT_MS);
    settle = (p) => {
      clearTimeout(limit);
      clearTimeout(codeTimer);
      resolve(p);
    };
    const read = (chunk: Buffer) => {
      if (seen.length < READ_MAX) seen += chunk.toString("utf8");
      const p = loginPromptOf(seen);
      if (p.url && p.code) settle(p);
      else if (p.url) codeTimer ??= setTimeout(() => settle(loginPromptOf(seen)), CODE_WAIT_MS);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
  });
  const done = new Promise<boolean>((resolve) => {
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  }).then((ok) => {
    settle(loginPromptOf(seen));
    return ok;
  });
  const stop = () => child.kill("SIGTERM");
  if (o.signal.aborted) stop();
  else o.signal.addEventListener("abort", stop, { once: true });
  return { prompt, done };
}

/** Runs an agent's own logout without a shell; what it prints is never kept. Throws when it didn't succeed. */
export function runLogout(bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { env: env ?? agentEnv(), timeout: 30_000 }, (e) =>
      e ? reject(new Error("Sign-out didn't finish")) : resolve(),
    ),
  );
}
