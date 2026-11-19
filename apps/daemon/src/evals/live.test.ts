import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import type { IonEvent } from "@ion/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../api/server.js";

/**
 * Live evals: what ion promises, on real agents, end to end through the daemon. Opt in per agent (each costs that
 * agent's quota): ION_LIVE=1 opencode (free model), ION_LIVE_GROK=1 Grok, ION_LIVE_CLAUDE=1 Claude (haiku),
 * ION_LIVE_CODEX=1 Codex (ION_CODEX_MODEL picks its model).
 * Run: `ION_LIVE=1 pnpm --filter @ion/daemon exec vitest run src/evals`. A table of results prints at the end.
 */
const AGENTS: { id: string; model?: string; on: boolean }[] = [
  { id: "opencode", on: process.env.ION_LIVE === "1" },
  { id: "grok-build", on: process.env.ION_LIVE_GROK === "1" },
  { id: "claude-code", model: "haiku", on: process.env.ION_LIVE_CLAUDE === "1" },
  { id: "codex", model: process.env.ION_CODEX_MODEL, on: process.env.ION_LIVE_CODEX === "1" },
];
const live = AGENTS.filter((a) => a.on);
const results: { agent: string; evalName: string; ok: boolean; note: string }[] = [];

async function until<T>(f: () => T | undefined | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 250));
  }
}

const textOf = (events: IonEvent[], chatId: string) =>
  events
    .filter((e) => e.chatId === chatId && e.type === "message.completed")
    .map((e) => (e.data as { text: string }).text)
    .join("\n");

/** Errors a screen wouldn't show: a failed tool ("Method not found"), an error event. */
const hidden = (events: IonEvent[], chatId: string) =>
  events
    .filter((e) => e.chatId === chatId)
    .filter(
      (e) =>
        e.type === "error" ||
        (e.type === "tool.output" && /failed|not found/i.test(String((e.data as { text?: string }).text))),
    )
    .map((e) => JSON.stringify(e.data).slice(0, 160));

describe.skipIf(live.length === 0)("live evals", { timeout: 600_000 }, () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: IonClient;
  let repo: string;
  const seen: IonEvent[] = [];

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "ion-eval-"));
    repo = join(home, "projects", "shop");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "cart.py"), "def total(items):\n    return round(sum(items), 2)\n");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.email=e@example.com", "-c", "user.name=E", "commit", "-q", "-m", "init");
    const configFile = join(home, "config.toml");
    // ion's own quick model (judge, ion chief): the free agent unless ION_EVAL_JUDGE names another ("claude-code:haiku").
    const judge = process.env.ION_EVAL_JUDGE ?? "opencode";
    writeFileSync(
      configFile,
      `[access]\njudge = "${judge}"\n[folders]\nprojects = "${join(home, "projects")}"\n`,
    );
    srv = await startServer({ dataDir: join(home, "data"), configFile, port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
    await client.call("projects.add", { path: repo });
    await client.subscribe({ fromNow: true }, (e) => seen.push(e));
  });

  afterAll(async () => {
    console.table(results);
    client?.close();
    await srv?.close();
  });

  /** The chat's run ends; `not`: a run to skip (the one that asked, when waiting for the one your answer starts). */
  const finished = (chatId: string, not?: string) =>
    until(
      () => seen.find((e) => e.chatId === chatId && e.type === "run.finished" && (!not || e.runId !== not)),
      240_000,
    );

  for (const a of live) {
    const record = (evalName: string, ok: boolean, note = "") =>
      results.push({ agent: a.id, evalName, ok, note });

    it(`${a.id}: asks you through ion, then follows your answer`, async () => {
      const { chatId, runId: asking } = await client.call("ask", {
        projectId: "shop",
        harness: a.id,
        ...(a.model ? { model: a.model } : {}),
        text: 'Before changing anything, find out from me how totals should round: "Half up" or "Bankers". Then reply with only my choice. Do not edit files.',
      });
      const need = await until(
        () => seen.find((e) => e.chatId === chatId && e.type === "need.raised"),
        240_000,
      ).catch(() => undefined);
      const choices = (need?.data as { choices?: unknown[] } | undefined)?.choices ?? [];
      record(
        "asks through ion",
        choices.length >= 2,
        need ? `${choices.length} choices` : textOf(seen, chatId).slice(0, 80),
      );
      expect(choices.length).toBeGreaterThanOrEqual(2);
      await client.call("need.answer", { needId: (need!.data as { needId: string }).needId, choice: 2 });
      const end = await finished(chatId, asking);
      const reply = textOf(
        seen.filter((e) => e.runId === end.runId),
        chatId,
      );
      record("follows your answer", /banker/i.test(reply), reply.slice(0, 60));
      expect(reply).toMatch(/banker/i);
      const errors = hidden(seen, chatId);
      record("no hidden errors", errors.length === 0, errors.join(" | "));
      expect(errors).toEqual([]);
    });

    it(`${a.id}: edits a file and reports the change`, async () => {
      const { chatId } = await client.call("ask", {
        projectId: "shop",
        harness: a.id,
        access: "full",
        ...(a.model ? { model: a.model } : {}),
        text: "In cart.py, add a function count(items) that returns len(items). Change nothing else and don't ask me anything.",
      });
      await finished(chatId);
      const changed = seen.some((e) => e.chatId === chatId && e.type === "file.changed");
      const diff = await client.call("chat.diff", { chatId });
      const has = diff.files.some((f) => f.path === "cart.py" && /def count/.test(f.patch ?? ""));
      record("edits in its worktree", has, changed ? "" : "no file.changed event");
      expect(has).toBe(true);
      // Your checkout is untouched: the edit lives in the chat's worktree.
      expect(readFileSync(join(repo, "cart.py"), "utf8")).not.toMatch(/def count/);
    });
  }

  it("ion chief answers and routes one message", async () => {
    await client.call("ion.message", {
      ionId: "chief",
      text: "Is anything waiting on me? Also ask shop to list the functions in cart.py, without editing anything.",
    });
    const said = await until(
      () => seen.find((e) => e.chatId === "ion:chief" && e.type === "ion.said"),
      120_000,
    );
    const d = said.data as { text: string; card?: { kind: string } };
    const routed = d.card?.kind === "threads";
    results.push({
      agent: "ion chief",
      evalName: "answers and routes",
      ok: routed && d.text.length > 0,
      note: d.text.slice(0, 60),
    });
    expect(routed).toBe(true);
    expect(d.text.length).toBeGreaterThan(0);
  });
});
