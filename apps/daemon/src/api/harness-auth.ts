import type { LoginRun } from "@ion/adapter-kit";
import type { HarnessInfo, LoginPage, SignInResult, SignOutResult } from "@ion/schema";
import { getHarness, type HarnessEntry } from "../adapters/registry.js";
import { agentAsks, signInChanged, whileSigningOut } from "../runs/ready.js";
import type { Db } from "../store/index.js";
import { runsView } from "../views/runs.js";
import { AskFirst, UserError } from "./errors.js";

/** What signing in and out needs: reading the agent again once it's done; how long a sign-in may wait at most. */
export type SignInDeps = { refresh: (id: string) => Promise<void>; limitMs?: number };

/** A sign-in may wait this long for you, then ion stops it (review of #35, 2026-11-23). */
const LIMIT_MS = 15 * 60_000;

/** Chats whose run on this agent is queued or going, and asks on it that haven't queued theirs yet. */
function working(db: Db, id: string): number {
  const rows = runsView
    .rows(db)
    .filter((r) => r.harness === id && (r.status === "running" || r.status === "queued"));
  return new Set(rows.map((r) => r.chatId)).size + agentAsks.count(id);
}

function agent(id: string): HarnessEntry {
  const h = getHarness(id);
  if (!h) throw new UserError(`Unknown agent: ${id}`);
  return h;
}

/** What an agent's own login or logout said went wrong, in its plain words ("Codex isn't installed"). */
function plainly(e: unknown): UserError {
  if (e instanceof UserError) return e;
  return new UserError(e instanceof Error ? e.message : "Something went wrong");
}

/** A sign-in ion started: how to stop it, its page once it has one, and the answer every caller gets. */
type Going = { stop: AbortController; page?: LoginPage; run?: LoginRun; started: Promise<SignInResult> };

/**
 * Signing in and out of each coding agent from ion (the user, 2026-11-23): its own login and logout, which ion runs
 * only where they need no terminal; else their commands. One sign-in per agent, held from the first call (a second
 * gets the same answer), kept until the agent's login ends, you cancel it, its time is up or ion stops; then the agent
 * is read again at once.
 */
export class AgentSignIns {
  private readonly going = new Map<string, Going>();

  constructor(private readonly deps: SignInDeps) {}

  /** The page and code of a sign-in ion is waiting on, for the agent's row. */
  pageOf(id: string): Pick<HarnessInfo, "signingIn"> {
    const page = this.going.get(id)?.page;
    return page ? { signingIn: page } : {};
  }

  async login(id: string, confirm: boolean): Promise<SignInResult> {
    const h = agent(id);
    const login = h.adapter.auth.login;
    if (!login.start) return { kind: "command", command: login.command };
    // Held before anything is awaited: a second click while this one starts gets this one.
    const g = this.going.get(id);
    if (g) return g.started;
    const entry = { stop: new AbortController() } as Going;
    this.going.set(id, entry);
    entry.started = this.begin(h, confirm, entry).catch((e: unknown) => {
      if (this.going.get(id) === entry) this.going.delete(id);
      throw plainly(e);
    });
    return entry.started;
  }

  private async begin(h: HarnessEntry, confirm: boolean, entry: Going): Promise<SignInResult> {
    const { login } = h.adapter.auth;
    if (!(await h.adapter.detect()).installed) throw new UserError(`${h.label} isn't installed`);
    // Asked now, not from a list a minute old: Codex's login deletes the sign-in it has.
    const status = await h.adapter.auth.status();
    if (status.signedIn) throw new UserError(`${h.label} is already signed in`);
    if (status.unknown && login.clears) throw new UserError(`Couldn't tell whether ${h.label} is signed in`);
    if (login.clears && !confirm)
      throw new AskFirst(`Sign in to ${h.label}? Starting it clears any ${h.label} sign-in on this Mac.`);
    if (entry.stop.signal.aborted) throw new UserError("Sign-in stopped");
    const run = login.start!(entry.stop.signal);
    entry.run = run;
    entry.page = await run.prompt;
    const limit = setTimeout(() => this.cancel(h.adapter.id), this.deps.limitMs ?? LIMIT_MS);
    limit.unref?.();
    void run.done.then(() => {
      clearTimeout(limit);
      return this.ended(h.adapter.id, entry);
    });
    return { kind: "started", ...entry.page };
  }

  /** Stops a sign-in ion started, or one still starting. */
  cancel(id: string): void {
    const g = this.going.get(id);
    this.going.delete(id);
    g?.stop.abort();
  }

  /** ion is stopping: every sign-in it started stops with it, all of each one gone before this resolves. */
  async stopAll(): Promise<void> {
    const runs = [...this.going.values()].map((g) => g.run);
    for (const id of [...this.going.keys()]) this.cancel(id);
    await Promise.all(runs.map((r) => r?.stopped()));
  }

  async logout(id: string, confirm: boolean, db: Db): Promise<SignOutResult> {
    const h = agent(id);
    const logout = h.adapter.auth.logout;
    if (!logout.run) return { kind: "command", command: logout.command };
    // Said before the question: nothing to confirm while it's working.
    const n = working(db, id);
    if (n) {
      const chats = n === 1 ? "a chat" : `${n} chats`;
      throw new UserError(`${h.label} is working in ${chats}. Sign out after they finish.`);
    }
    // It signs the agent out everywhere, not only in ion: never without your yes.
    if (!confirm)
      throw new AskFirst(`Sign out of ${h.label}? This signs ${h.label} out on this Mac, not just in ion.`);
    return whileSigningOut(id, async () => {
      if (!(await h.adapter.detect()).installed) throw new UserError(`${h.label} isn't installed`);
      try {
        await logout.run!();
      } catch (e) {
        throw plainly(e);
      } finally {
        signInChanged();
        await this.deps.refresh(id);
      }
      return { kind: "done" as const, signedIn: (await h.adapter.auth.status()).signedIn };
    });
  }

  private async ended(id: string, entry: Going): Promise<void> {
    signInChanged();
    await this.deps.refresh(id);
    // Only this sign-in's: a new one may have started meanwhile.
    if (this.going.get(id) === entry) this.going.delete(id);
  }
}
