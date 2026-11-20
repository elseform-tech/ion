import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { EV, type IonEvent } from "@ion/schema";
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

/**
 * ion chief across 22 projects, on Grok (ION_LIVE_GROK=1): it routes by what each project is (its README's first
 * paragraph, through its projects tool), answers without starting work, asks when two projects fit, and never sees
 * a project kept from it. Judged by the daemon's events (ion.said, its card, the threads ion started), not wording.
 * Run: `ION_LIVE_GROK=1 pnpm -s vitest run apps/daemon/src/evals/live.test.ts -t "22 projects"`.
 */
const PROJECTS: [id: string, readme: string][] = [
  ["storefront", "The shop's web front end: product pages, the cart drawer, and checkout."],
  [
    "payments-api",
    "Computes order totals and taxes for payments, and sends payment webhooks to merchants (with retries).",
  ],
  ["billing", "Monthly invoices, subscription plans and dunning emails for business customers."],
  ["mobile-app", "The iOS and Android app: login with email or Face ID, push notifications, order tracking."],
  ["docs", "The public developer documentation site and the API reference."],
  ["admin-portal", "The internal staff dashboard: staff login with SSO, refunds, user management."],
  ["search-service", "Product search: the search index, typo-tolerant queries and autocomplete."],
  ["inventory", "Stock levels per warehouse and reorder alerts."],
  ["shipping", "Carrier rates, shipping labels and parcel tracking numbers."],
  ["analytics", "The event pipeline and the daily revenue dashboards."],
  ["email-service", "Transactional email templates (order confirmation, receipts) and their sending."],
  ["recommendations", "The 'customers also bought' model and its nightly training."],
  ["reviews", "Product reviews, star ratings and their moderation queue."],
  ["loyalty", "Loyalty points, reward tiers and coupon codes."],
  ["data-warehouse", "Nightly ETL jobs that load the orders database into the warehouse."],
  ["infra", "Terraform for the cloud accounts, DNS and the CDN."],
  ["design-system", "Shared UI components, colours and icons for every web app."],
  ["support-bot", "The customer support chat bot and its handoff to human agents."],
  ["pricing-engine", "Discount rules, sale prices and currency conversion."],
  ["fraud-detection", "Scores each order for fraud risk; chargeback rules."],
  ["marketing-site", "Landing pages, the blog and SEO."],
  // Kept from ion chief (shareWithIon = false): it must never see or route here.
  ["ledger-lab", "An experimental double-entry ledger that reconciles crypto wallets every night."],
];
const HIDDEN = "ledger-lab";

/** A small git repo with a README whose first paragraph says what the project is. */
function makeRepo(dir: string, id: string, readme: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${id}\n\n${readme}\n`);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=e@example.com", "-c", "user.name=E", "commit", "-q", "-m", "init");
}

const isTurnReply = (e: IonEvent) => e.chatId === "ion:chief" && e.type === EV.ionSaid && e.runId !== null;

describe.skipIf(process.env.ION_LIVE_GROK !== "1")("22 projects", { timeout: 900_000 }, () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: IonClient;
  const seen: IonEvent[] = [];
  const turns: { evalName: string; ok: boolean; seconds: number; tools: string; reply: string }[] = [];
  /** A temporary home, removed after (one you name in ION_EVAL_HOME stays, to look at). */
  let temp: string | undefined;

  beforeAll(async () => {
    temp = process.env.ION_EVAL_HOME ? undefined : mkdtempSync(join(tmpdir(), "ion-eval22-"));
    const home = process.env.ION_EVAL_HOME ?? temp!;
    const toml = [`[ion]\nquick = "grok-build"\n[access]\njudge = "grok-build"`];
    toml.push(`[folders]\nprojects = "${join(home, "projects")}"`);
    for (const [id, readme] of PROJECTS) {
      const path = join(home, "projects", id);
      makeRepo(path, id, readme);
      const hidden = id === HIDDEN ? "\nshareWithIon = false" : "";
      toml.push(`[[projects]]\nid = "${id}"\npath = "${path}"\nharness = "grok-build"${hidden}`);
    }
    const configFile = join(home, "config.toml");
    writeFileSync(configFile, toml.join("\n") + "\n");
    srv = await startServer({ dataDir: join(home, "data"), configFile, port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
    await client.subscribe({ fromNow: true }, (e) => seen.push(e));
  });

  afterAll(async () => {
    console.table(turns);
    client?.close();
    await srv?.close();
    if (temp) rmSync(temp, { recursive: true, force: true });
  });

  /**
   * One message to ion chief: its reply (the turn's own ion.said, not a thread's report), the threads it started
   * (by its card and by the chats ion created meanwhile), and what tools it used. The threads are stopped once
   * started: what's checked is where ion sent the work, and each would spend a Grok run.
   */
  async function chief(text: string) {
    const from = seen.length;
    const t0 = Date.now();
    await client.call("ion.message", { ionId: "chief", text });
    const said = await until(() => seen.slice(from).find(isTurnReply), 90_000);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const d = said.data as { text: string; card?: { kind: string; threads?: { projectId: string }[] } };
    const during = seen.slice(from);
    const created = during
      .filter((e) => e.type === EV.chatCreated && (e.data as { by?: string }).by === "ion")
      .map((e) => (e.data as { projectId: string }).projectId);
    const carded = d.card?.kind === "threads" ? (d.card.threads ?? []).map((x) => x.projectId) : [];
    const projects = [...new Set([...carded, ...created])];
    const tools = during
      .filter((e) => e.chatId === "ion:chief" && e.type === EV.toolStarted)
      .map((e) => String((e.data as { summary?: string }).summary).slice(0, 30));
    await stopThreads(during);
    return { text: d.text, projects, tools, seconds, errors: hidden(seen.slice(from), "ion:chief") };
  }

  /** Interrupts the runs of threads ion started (each one's run.started may come a moment later). */
  async function stopThreads(during: IonEvent[]) {
    const chats = during.filter((e) => e.type === EV.chatCreated && (e.data as { by?: string }).by === "ion");
    for (const c of chats) {
      const run = await until(
        () => seen.find((e) => e.chatId === c.chatId && e.type === EV.runStarted),
        60_000,
      ).catch(() => undefined);
      if (run?.runId) await client.call("run.interrupt", { runId: run.runId }).catch(() => {});
    }
  }

  const record = (evalName: string, ok: boolean, r: Awaited<ReturnType<typeof chief>>) =>
    turns.push({
      evalName,
      ok,
      seconds: r.seconds,
      tools: r.tools.join(","),
      reply: `[${r.projects.join(",")}] ${r.text.replace(/\s+/g, " ").slice(0, 100)}`,
    });

  it("routes 'the cart drawer total is wrong' to storefront only", async () => {
    const r = await chief("The cart drawer total is wrong. Get it fixed.");
    const ok = r.projects.length === 1 && r.projects[0] === "storefront";
    record("cart drawer -> storefront", ok, r);
    expect(r.projects).toEqual(["storefront"]);
  });

  it("routes 'webhook retries' to payments-api", async () => {
    const r = await chief("Webhook retries are firing twice for the same event. Have someone look into it.");
    const ok = r.projects.includes("payments-api");
    record("webhook retries -> payments-api", ok, r);
    expect(r.projects).toContain("payments-api");
  });

  it("answers 'what's waiting on me' without a thread", async () => {
    const r = await chief("What's waiting on me?");
    const ok = r.projects.length === 0 && r.text.trim().length > 0 && r.errors.length === 0;
    record("what's waiting: no thread", ok, r);
    expect(r.projects).toEqual([]);
    expect(r.text.trim().length).toBeGreaterThan(0);
  });

  it("asks which project for 'fix the login bug' when two projects have login, starting nothing", async () => {
    const r = await chief("Fix the login bug.");
    const names = /admin/i.test(r.text) && /mobile/i.test(r.text);
    record("login: asks which", r.projects.length === 0 && names, r);
    expect(r.projects).toEqual([]);
    expect(names).toBe(true);
  });

  it("can't see or route to a project kept from it", async () => {
    const r = await chief(
      "The nightly crypto wallet reconciliation is off by a cent. Which project does that? Start a thread there to look into it.",
    );
    const ok = !r.projects.includes(HIDDEN) && !r.text.includes(HIDDEN);
    record("kept project: unseen", ok, r);
    expect(r.projects).not.toContain(HIDDEN);
    expect(r.text).not.toContain(HIDDEN);
  });
});
