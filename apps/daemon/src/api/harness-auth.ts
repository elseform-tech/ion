import type { HarnessInfo, LoginPage, SignInResult, SignOutResult } from "@ion/schema";
import { getHarness, type HarnessEntry } from "../adapters/registry.js";
import { signInChanged } from "../runs/ready.js";
import type { Db } from "../store/index.js";
import { runsView } from "../views/runs.js";
import { AskFirst, UserError } from "./errors.js";

/** What signing in and out needs: the agent, and reading it again once it's done. */
export type SignInDeps = { refresh: (id: string) => Promise<void> };

/** Chats whose run on this agent is queued or going. */
function chatsWorking(db: Db, id: string): number {
  const rows = runsView
    .rows(db)
    .filter((r) => r.harness === id && (r.status === "running" || r.status === "queued"));
  return new Set(rows.map((r) => r.chatId)).size;
}

function agent(id: string): HarnessEntry {
  const h = getHarness(id);
  if (!h) throw new UserError(`Unknown agent: ${id}`);
  return h;
}

/**
 * Signing in and out of each coding agent from ion (the user, 2026-11-23): its own login and logout, which ion runs
 * only where they need no terminal; else their commands. A sign-in ion started is kept here (its page and code only)
 * until the agent's login ends; then the agent is read again at once.
 */
export class AgentSignIns {
  private readonly going = new Map<string, { page: LoginPage; stop: AbortController }>();

  constructor(private readonly deps: SignInDeps) {}

  /** The page and code of a sign-in ion is waiting on, for the agent's row. */
  pageOf(id: string): Pick<HarnessInfo, "signingIn"> {
    const g = this.going.get(id);
    return g ? { signingIn: g.page } : {};
  }

  async login(id: string, confirm: boolean): Promise<SignInResult> {
    const h = agent(id);
    const login = h.adapter.auth.login;
    const g = this.going.get(id);
    if (g) return { kind: "started", ...g.page };
    if (!login.start) return { kind: "command", command: login.command };
    if (!(await h.adapter.detect()).installed) throw new UserError(`${h.label} isn't installed`);
    // Asked now, not from a list a minute old: Codex's login deletes the sign-in it has.
    if ((await h.adapter.auth.status()).signedIn) throw new UserError(`${h.label} is already signed in`);
    if (login.clears && !confirm)
      throw new AskFirst(`Sign in to ${h.label}? Starting it clears any ${h.label} sign-in on this Mac.`);
    const stop = new AbortController();
    const run = login.start(stop.signal);
    const page = await run.prompt;
    this.going.set(id, { page, stop });
    void run.done.then(() => this.ended(id, stop));
    return { kind: "started", ...page };
  }

  /** Stops a sign-in ion started. */
  cancel(id: string): void {
    const g = this.going.get(id);
    this.going.delete(id);
    g?.stop.abort();
  }

  async logout(id: string, confirm: boolean, db: Db): Promise<SignOutResult> {
    const h = agent(id);
    const logout = h.adapter.auth.logout;
    if (!logout.run) return { kind: "command", command: logout.command };
    // It signs the agent out everywhere, not only in ion: never without your yes.
    if (!confirm)
      throw new AskFirst(`Sign out of ${h.label}? This signs ${h.label} out on this Mac, not just in ion.`);
    const n = chatsWorking(db, id);
    if (n) {
      const chats = n === 1 ? "a chat" : `${n} chats`;
      throw new UserError(`${h.label} is working in ${chats}. Sign out after they finish.`);
    }
    try {
      await logout.run();
    } finally {
      signInChanged();
      await this.deps.refresh(id);
    }
    return { kind: "done", signedIn: (await h.adapter.auth.status()).signedIn };
  }

  private async ended(id: string, stop: AbortController): Promise<void> {
    signInChanged();
    await this.deps.refresh(id);
    // Only this sign-in's: a new one may have started meanwhile.
    if (this.going.get(id)?.stop === stop) this.going.delete(id);
  }
}
