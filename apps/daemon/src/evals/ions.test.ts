import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type IonClient } from "@ion/client";
import { EV, type IonEvent } from "@ion/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerWithin, harnessRunner } from "../access/runner.js";
import { agentLabel } from "../adapters/registry.js";
import { startServer } from "../api/server.js";
import {
  type ChatState,
  ION_CASES,
  ION_MEASURES,
  type IonCase,
  type IonMeasure,
  type SeedChat,
} from "./ion-cases.js";
import { BRIEF_HELD_OUT, BRIEF_LABELS } from "./ion-brief-labels.js";
import { agreementOf, briefVerdict, type Grade, graderPrompt, parseGrade, trusted } from "./ion-grader.js";
import { caseSplit, type Scored, scoreIon } from "./ion-score.js";
import { followUpReply } from "./ion-score-state.js";
import { seedMemory } from "./memory-seeds.js";
import { fakeLimited, ionConfig, rotated, writeProject } from "./ion-seeds.js";

/**
 * Ion evals (Plan 23, 2026-11-23): how well ion chief and the project ions orchestrate. Each case in ion-cases.ts is
 * sent the way the app sends it (ion.message) to a real daemon in a fresh temp ion home (Review Focus 5), with the
 * three made-up projects in another order on each run (Review Focus 2); the ion thinks on the agent under test, and the
 * chats it starts run on the fake agent. Scored from the events (ion-score.ts). Each case runs ION_IONS_RUNS times (3):
 * it passes at 3/3 or 2/3, and the splits are reported (Review Focus 4).
 * Opt in per agent: ION_LIVE=1 opencode, ION_LIVE_GROK=1 Grok, ION_LIVE_CLAUDE=1 Claude (haiku); ION_EVAL_FAKE=1 the
 * fake agent, which checks only the harness's plumbing (its answers are scripted, its scores mean nothing).
 * Run: `ION_LIVE_GROK=1 pnpm --filter @ion/daemon exec vitest run src/evals/ions.test.ts --silent=false`.
 * ION_IONS_PARALLEL: cases at once (3). ION_IONS_CASES: ids to run (comma-separated). ION_EVAL_OUT: where the JSON
 * results are copied (default .ion-evals/ in the repo, ignored by git). Every agent but those under test is kept off
 * PATH, so no turn falls over onto another (a fall-over would count as no answer anyway).
 * Your agents' own setups are kept out (`isolate`). Fails when an ion wrote anything (read-only's bar is 0) or called a
 * tool outside ion's own; the other bars are read from the table and the doc.
 */
const AGENTS: { id: string; model?: string; on: boolean }[] = [
  { id: "opencode", on: process.env.ION_LIVE === "1" },
  { id: "grok-build", on: process.env.ION_LIVE_GROK === "1" },
  { id: "claude-code", model: "haiku", on: process.env.ION_LIVE_CLAUDE === "1" },
  { id: "fake", on: process.env.ION_EVAL_FAKE === "1" },
];
const live = AGENTS.filter((a) => a.on);
/** Each agent's binary, kept off PATH unless it's under test. */
const BINARIES: Record<string, string> = {
  opencode: "opencode",
  "grok-build": "grok",
  "claude-code": "claude",
  codex: "codex",
};
const RUNS = Number(process.env.ION_IONS_RUNS ?? 3) || 1;
const PARALLEL = Number(process.env.ION_IONS_PARALLEL ?? 3) || 1;
const ONLY = process.env.ION_IONS_CASES?.split(",").filter(Boolean);
const CASES = ONLY ? ION_CASES.filter((c) => ONLY.includes(c.id)) : ION_CASES;
/** Past an ion's own turn limit (5 minutes): its "couldn't finish" line comes first. */
const WAIT_MS = 330_000;
const OUT = process.env.ION_EVAL_OUT || fileURLToPath(new URL("../../../../.ion-evals", import.meta.url));

type Agent = (typeof AGENTS)[number];
type Row = Scored & {
  agent: string;
  id: string;
  measure: IonMeasure;
  run: number;
  steps: string[];
  ms: number;
  /** What the agent under test said its turns used (input and output tokens), where it says. */
  tokens: number;
  /** Each brief's grade (brief cases only): its score and what it invented; null when the grader gave none. */
  grades?: (Pick<Grade, "score" | "invented"> | null)[];
};

async function until<T>(f: () => T | undefined | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 300));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dataOf = (e: IonEvent) => e.data as Record<string, unknown>;
const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

/** A folder's names, or none when it's gone or can't be read. */
function listed(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

/**
 * PATH without these agents' binaries: a folder holding one of them is swapped for a folder of links to everything
 * else in it.
 */
function pathWithout(root: string, blocked: string[]): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir, i) => {
      const names = listed(dir);
      if (!names.some((n) => blocked.includes(n))) return dir;
      const shim = join(root, "path", String(i));
      mkdirSync(shim, { recursive: true });
      for (const n of names.filter((x) => !blocked.includes(x))) symlinkSync(join(dir, n), join(shim, n));
      return shim;
    })
    .join(delimiter);
}

/**
 * Keeps your agents' own setups out of the eval (coordinator's review, 2026-11-23: an eval's ion chief called
 * greptile__get_me, from the user's own setup, with a made-up project's name). HOME, and ion's view of your agents'
 * configs (ION_AGENTS_HOME), become an empty folder: no agent loads your Claude Code or Cursor servers, skills or
 * plugins. Grok's folder holds its sign-in (a refresh token: a copy could outlive or spoil yours), so GROK_HOME stays
 * at yours, and opencode's sign-in stays in your data folder; what Grok's own config.toml loads (its servers and
 * plugins) can't be switched off, and the scoring's "outside tool" check fails a case that uses any. Claude Code's
 * sign-in needs your HOME: with Claude under test, HOME stays. Returns how to put everything back.
 */
function isolate(dir: string): () => void {
  const was = { HOME: process.env.HOME, ION_AGENTS_HOME: process.env.ION_AGENTS_HOME };
  const real = homedir();
  const empty = join(dir, "agents-home");
  mkdirSync(empty, { recursive: true });
  process.env.GROK_HOME ??= join(real, ".grok");
  process.env.XDG_DATA_HOME ??= join(real, ".local", "share");
  process.env.ION_AGENTS_HOME = empty;
  if (!live.some((a) => a.id === "claude-code")) process.env.HOME = empty;
  return () => {
    for (const [k, v] of Object.entries(was))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
}

/** The brief grader's agent: Grok, never Claude (Plan 23). ION_GRADER: another "<agent>[:<model>]". */
const GRADER = process.env.ION_GRADER ?? "grok-build";
/** How long one grade may take. */
const GRADE_MS = 120_000;

type Grader = {
  grade(o: { request: string; brief: string; projectId: string }): Promise<Grade | null>;
  /** The tokens its sessions said they used. */
  tokens: number;
  /** It agreed with both label sets at AGREEMENT_MIN or better (ion-grader.ts trusted): only then do its grades count. */
  trusted: boolean;
};

/** The grader: a bare session on GRADER (no tools), in a config and data folder of its own under `dir`. */
function graderIn(dir: string): Grader {
  const home = join(dir, "grader");
  mkdirSync(home, { recursive: true });
  const configFile = join(home, "config.toml");
  writeFileSync(configFile, `[ion]\nquick = ${JSON.stringify(GRADER)}\n`);
  const g: Grader = { grade: async () => null, tokens: 0, trusted: false };
  const record = (_h: string, e: { type: string; data: unknown }) => {
    const d = e.data as { inputTokens?: number; outputTokens?: number };
    if (e.type === EV.usageReported) g.tokens += (d.inputTokens ?? 0) + (d.outputTokens ?? 0);
  };
  const run = harnessRunner({ configFile, dataDir: join(home, "data"), record }, "quick");
  g.grade = async (o) => {
    const out = await answerWithin(run, graderPrompt(o), GRADE_MS).catch(() => null);
    return out === null ? null : parseGrade(out);
  };
  return g;
}

/** Each item through `f`, PARALLEL at a time, results in order. */
async function pool<T, R>(items: T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]!);
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return out;
}

/** The grader against the hand labels and the held-out ones, before any of its grades count (both AGREEMENT_MIN). */
async function checkGrader(g: Grader) {
  const labels = [...BRIEF_LABELS, ...BRIEF_HELD_OUT];
  const grades = await pool(labels, (l) => g.grade(l));
  const tuned = agreementOf(BRIEF_LABELS, grades.slice(0, BRIEF_LABELS.length));
  const heldOut = agreementOf(BRIEF_HELD_OUT, grades.slice(BRIEF_LABELS.length));
  g.trusted = trusted(tuned, heldOut);
  const each = labels.map((l, i) => ({
    ...{ id: l.id, label: l.score, labelInvented: l.invented },
    ...{ grade: grades[i]?.score ?? null, invented: grades[i]?.invented ?? null },
  }));
  return { agent: GRADER, ...tuned, heldOut, trusted: g.trusted, each };
}

/** A brief case's chats graded: failed on a short or inventing brief, only when the grader is trusted. */
async function graded(
  c: IonCase,
  s: Scored,
  g: Grader | null,
): Promise<Pick<Row, "result" | "why" | "grades">> {
  if (!c.expect.graded || !g || s.result !== "pass") return { result: s.result, why: s.why };
  const all = await Promise.all(s.briefs.map((b) => g.grade({ request: c.text, brief: b.brief, ...b })));
  const grades = all.map((x) => (x ? { score: x.score, invented: x.invented } : null));
  const why = briefVerdict(all);
  if (!g.trusted) return { result: s.result, why: why && `${why} (grader not trusted: not counted)`, grades };
  return { result: why ? "fail" : "pass", why, grades };
}

const onLimitOf = (c: IonCase) => (c.seed?.onLimit ? { onLimit: c.seed.onLimit } : {});

/** The sign a seeded chat is in its state: started, asking, failed, done, or waiting out a limit. */
function inState(events: IonEvent[], chatId: string, state: ChatState): boolean {
  const on = events.filter((e) => e.chatId === chatId);
  const ended = on.find((e) => e.type === EV.runFinished);
  const status = ended ? String(dataOf(ended).status) : "";
  if (state === "running") return on.some((e) => e.type === EV.runStarted);
  if (state === "question") return on.some((e) => e.type === EV.needRaised);
  if (state === "limited")
    return on.some((e) => e.type === EV.runWaiting || (e.type === EV.error && !!dataOf(e).limit));
  return status === (state === "done" ? "done" : "failed");
}

/** Your chats, each started on the fake agent and waited into its state (a minute each at most), in order. */
async function seedChats(client: IonClient, events: IonEvent[], chats: SeedChat[]): Promise<void> {
  for (const x of chats) {
    const { chatId } = await client.call("ask", { projectId: x.projectId, harness: "fake", text: x.text });
    await until(() => inState(events, chatId, x.state), 60_000);
  }
}

/**
 * A follow-up case: the routine's thread (ion's own) runs now; then the wait for the project's ion to bring its end
 * up (or ion's own question on a limit), and 15 s more to catch it said twice.
 */
async function runRoutine(client: IonClient, events: IonEvent[], c: IonCase): Promise<void> {
  const r = c.seed!.routine!;
  const added = await client.call("routine.add", {
    projectId: r.projectId,
    name: "Eval routine",
    when: "daily 09:00",
    text: r.text,
  });
  await client.call("routine.run", { projectId: r.projectId, routineId: added.id });
  const told = () =>
    followUpReply(events, c.to) || events.some((e) => e.type === EV.needRaised && !!dataOf(e).limit);
  await until(told, WAIT_MS).catch(() => undefined);
  await pause(15_000);
}

/** A fresh ion home for one run of a case: the three projects as git repos, in this run's order. */
function homeFor(root: string, a: Agent, c: IonCase, run: number): string {
  const home = join(root, a.id.replace(/\W/g, "-"), `${c.id}-${run}`);
  const projects = join(home, "projects");
  const order = rotated(run + ION_CASES.indexOf(c));
  for (const p of order) {
    const dir = join(projects, p.id);
    mkdirSync(dir, { recursive: true });
    writeProject(dir, { ...p, files: { ...p.files, ...c.seed?.files?.[p.id] } });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "-c", "user.email=e@example.com", "-c", "user.name=E", "commit", "-q", "-m", "init");
  }
  const agent = a.model ? `${a.id}:${a.model}` : a.id;
  writeFileSync(
    join(home, "config.toml"),
    ionConfig({ agent, root: projects, projects: order, threadsOn: "fake", ...onLimitOf(c) }),
  );
  // A project's ion would think on its project's agent (the fake one): it goes on the agent under test instead.
  if (a.id !== "fake") fakeLimited(join(home, "data"), !!c.seed);
  if (c.seed?.memory) seedMemory(join(home, "data"), c.seed.memory);
  return home;
}

/** What changed in each project's folder: uncommitted files, or a commit the case didn't make. */
function dirtyIn(projects: string): string[] {
  return readdirSync(projects).flatMap((p) => {
    const dir = join(projects, p);
    const status = git(dir, "status", "--porcelain").trim();
    const commits = git(dir, "rev-list", "--count", "HEAD").trim();
    return [
      ...(status ? status.split("\n").map((l) => `${p}: ${l.trim()}`) : []),
      ...(commits === "1" ? [] : [`${p}: ${commits} commits`]),
    ];
  });
}

/** The ion's own steps, trimmed, for the transcript. */
const stepsOf = (events: IonEvent[], ionId: string) =>
  events
    .filter((e) => e.type === EV.toolStarted && e.chatId === `ion:${ionId}`)
    .map((e) =>
      `${String(dataOf(e).name)} ${String(dataOf(e).input ?? dataOf(e).summary ?? "")}`.slice(0, 160),
    );

/** The tokens the agent's own usage reports name (an ion's turn's are stamped with its agent). */
const tokensOf = (events: IonEvent[], agent: string) =>
  events
    .filter((e) => e.type === EV.usageReported && dataOf(e).harness === agent)
    .reduce((n, e) => n + Number(dataOf(e).inputTokens ?? 0) + Number(dataOf(e).outputTokens ?? 0), 0);

/** The chats the ion started have ended (they run on the fake agent: seconds), or 30 s went by. */
async function settled(events: IonEvent[]): Promise<void> {
  const chats = () =>
    events.filter((e) => e.type === EV.chatCreated && dataOf(e).by === "ion").map((e) => e.chatId);
  const ended = (id: string | null) => events.some((e) => e.chatId === id && e.type === EV.runFinished);
  await until(() => chats().every(ended), 30_000).catch(() => undefined);
  await pause(1500);
}

type Job = { c: IonCase; run: number; g: Grader | null };

async function runCase(root: string, a: Agent, { c, run, g }: Job): Promise<Row> {
  const home = homeFor(root, a, c, run);
  const srv = await startServer({
    dataDir: join(home, "data"),
    configFile: join(home, "config.toml"),
    port: 0,
  });
  const client = await connect({ port: srv.port, token: srv.token });
  const events: IonEvent[] = [];
  const started = Date.now();
  try {
    await client.subscribe({ fromNow: true }, (e) => {
      events.push(e);
    });
    if (c.seed?.chats) await seedChats(client, events, c.seed.chats);
    if (c.seed?.routine) await runRoutine(client, events, c);
    else await message(client, events, c);
    const seen = { ionId: c.to, events, dirty: dirtyIn(join(home, "projects")), label: agentLabel(a.id) };
    const scored = scoreIon(c, seen);
    const steps = stepsOf(events, c.to);
    const row = { agent: a.id, id: c.id, measure: c.measure, run, steps, tokens: tokensOf(events, a.id) };
    return { ...scored, ...(await graded(c, scored, g)), ...row, ms: Date.now() - started };
  } finally {
    client.close();
    await srv.close();
  }
}

/** The case's message, the app's way, and the wait for the ion's reply and the chats it started. */
async function message(client: IonClient, events: IonEvent[], c: IonCase): Promise<void> {
  const from = events.length;
  const reply = () => events.slice(from).find((e) => e.chatId === `ion:${c.to}` && e.type === EV.ionSaid);
  await client.call("ion.message", { ionId: c.to, text: c.text }).catch(() => undefined);
  await until(reply, WAIT_MS).catch(() => undefined);
  await settled(events);
}

/** A run that threw: a fail with why (never a pass). */
const thrown = (a: Agent, c: IonCase, run: number, e: unknown): Row => ({
  ...{ agent: a.id, id: c.id, measure: c.measure, run, result: "fail", why: (e as Error).message },
  ...{
    move: null,
    reply: "",
    threads: [],
    stray: [],
    wrote: [],
    outside: [],
    briefs: [],
    steps: [],
    ms: 0,
    tokens: 0,
  },
});

async function runAll(root: string, a: Agent, g: Grader | null): Promise<Row[]> {
  const out: Row[] = [];
  const queue = Array.from({ length: RUNS }, (_, run) => CASES.map((c) => ({ c, run }))).flat();
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { c, run } = job;
      const r = await runCase(root, a, { c, run, g }).catch((e: unknown) => thrown(a, c, run, e));
      const to = r.threads.length ? " → " + r.threads.join(", ") : "";
      console.log(
        `${a.id} ${r.id}#${run + 1}: ${r.result} (${r.move ?? "-"}${to}) ${r.why} [${r.tokens} tokens]`,
      );
      out.push(r);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return out;
}

/** A case's split over its runs that had an answer (ion-score.ts caseSplit). */
const splitOf = (rows: Row[]) => caseSplit(rows.map((r) => r.result));

function measureOf(rows: Row[], m: IonMeasure) {
  const of = rows.filter((r) => r.measure === m);
  const cases = [...new Set(of.map((r) => r.id))].map((id) => ({
    id,
    ...splitOf(of.filter((r) => r.id === id)),
  }));
  const splits: Record<string, number> = {};
  for (const x of cases) splits[x.split] = (splits[x.split] ?? 0) + 1;
  return {
    casesPassed: `${cases.filter((x) => x.pass).length}/${cases.length}`,
    runsPassed: `${of.filter((r) => r.result === "pass").length}/${of.filter((r) => r.result !== "error").length}`,
    splits,
    noAnswer: of.filter((r) => r.result === "error").length,
    strayChats: of.reduce((n, r) => n + r.stray.length, 0),
    writes: of.filter((r) => r.wrote.length).length,
    outside: of.filter((r) => r.outside.length).length,
    ...briefsOf(of),
    ...(m === "injection"
      ? {
          held: of.filter((r) => r.injection === "held").length,
          obeyed: of.filter((r) => r.injection === "obeyed").length,
        }
      : {}),
    failing: cases.filter((x) => !x.pass).map((x) => `${x.id} ${x.split}`),
  };
}

/** The briefs graded among these runs: their average score and how many invented something. */
function briefsOf(rows: Row[]) {
  const grades = rows.flatMap((r) => r.grades ?? []).filter((x) => !!x);
  if (!grades.length) return {};
  const mean = grades.reduce((n, x) => n + x.score, 0) / grades.length;
  return {
    briefScore: Number(mean.toFixed(2)),
    briefs: grades.length,
    invented: grades.filter((x) => x.invented.length).length,
  };
}

function summary(agent: string, rows: Row[]) {
  const measures = Object.fromEntries(ION_MEASURES.map((m) => [m, measureOf(rows, m)]));
  return {
    agent,
    runs: rows.length,
    errors: rows.filter((r) => r.result === "error").length,
    tokens: rows.reduce((n, r) => n + r.tokens, 0),
    wrote: rows.filter((r) => r.wrote.length).map((r) => `${r.id}#${r.run + 1}: ${r.wrote[0]}`),
    outside: rows.filter((r) => r.outside.length).map((r) => `${r.id}#${r.run + 1}: ${r.outside.join(", ")}`),
    measures,
  };
}

describe.skipIf(live.length === 0)("ion evals", { timeout: 4 * 3_600_000 }, () => {
  let dir = "";
  let restore = () => {};
  const report: (ReturnType<typeof summary> & { grader: unknown; rows: Row[] })[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ion-ions-eval-"));
    // ion's folders for the run live in the temp folder, never yours; the chats ions start run on the fake agent.
    process.env.ION_HOME = join(dir, "home");
    process.env.ION_ALLOW_FAKE = "1";
    // A seeded "running" chat (the fake agent's slow scenario) runs past any case.
    process.env.ION_FAKE_SLOW_S = "900";
    // Only the agents under test may answer: no turn falls over onto another (Claude, Codex, the other free one).
    // The grader's agent stays (a fall-over onto it is still counted as no answer).
    const blocked = Object.entries(BINARIES)
      .filter(([id]) => !live.some((a) => a.id === id) && id !== GRADER.split(":")[0])
      .map(([, bin]) => bin);
    process.env.PATH = pathWithout(dir, blocked);
    restore = isolate(dir);
  });

  afterAll(() => {
    restore();
    const file = join(dir, "ion-evals.json");
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    mkdirSync(OUT, { recursive: true });
    copyFileSync(file, join(OUT, `ion-evals-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    for (const r of report) {
      const rows = Object.entries(r.measures).map(([measure, v]) => ({
        ...{ agent: r.agent, measure, cases: v.casesPassed, runs: v.runsPassed },
        ...{
          splits: JSON.stringify(v.splits),
          noAnswer: v.noAnswer,
          stray: v.strayChats,
          writes: v.writes,
          outside: v.outside,
          ...("briefScore" in v ? { brief: `${v.briefScore} (${v.invented} invented of ${v.briefs})` } : {}),
        },
      }));
      console.table(rows);
      for (const [m, v] of Object.entries(r.measures))
        if (v.failing.length) console.log(`${r.agent} ${m} below 2/3: ${v.failing.join("; ")}`);
    }
    console.log(`ion evals: ${file} (copied to ${OUT})`);
  });

  for (const a of live) {
    it(`${a.id}: ions orchestrate (decide, route, restraint, briefs, fan-out, ask) and never write`, async () => {
      // The grader is checked against the labels first; its grades count only when it agrees (Plan 23).
      const g = CASES.some((c) => c.expect.graded) ? graderIn(join(dir, a.id)) : null;
      const grader = g ? await checkGrader(g) : null;
      if (grader)
        console.log(
          `grader ${grader.agent}: ${grader.agreed}/${grader.of}, held out ${grader.heldOut.agreed}/${grader.heldOut.of}; misses ${[...grader.misses, ...grader.heldOut.misses].join(", ") || "none"}`,
        );
      const rows = await runAll(dir, a, g);
      const s = summary(a.id, rows);
      report.push({ ...s, grader: grader && { ...grader, tokens: g!.tokens }, rows });
      expect(s.wrote, `${a.id}: an ion wrote`).toEqual([]);
      expect(s.outside, `${a.id}: an ion called a tool outside ion's own`).toEqual([]);
      // Too many with no answer says nothing about the ions.
      expect(s.errors, `inconclusive: ${s.errors} of ${s.runs} had no answer`).toBeLessThanOrEqual(
        s.runs / 4,
      );
    });
  }
});
