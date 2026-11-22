import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@ion/client";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { type DreamInfo, EV, type MemoryHeader, type MemoryScope } from "@ion/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../api/server.js";
import { MemoryFiles } from "../memory/index.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { DREAM_CASES, DREAM_MEASURES, type DreamCase } from "./dream-cases.js";

/**
 * The dream's evals (the user, 2026-11-22: ion tidies memory overnight): each case in dream-cases.ts through a real
 * daemon (a temp ion home, its memory seeded as ion chief's and its chats as the last week's) and one dream turn on a
 * real agent (`memory.dream`), scored from the memory folder after. Opt in per agent: ION_LIVE=1 opencode,
 * ION_LIVE_GROK=1 Grok, ION_LIVE_CLAUDE=1 Claude. ION_MEMORY_CASES: ids to run; ION_EVAL_OUT: where to copy results.
 * Run: `ION_LIVE_GROK=1 pnpm --filter @ion/daemon exec vitest run src/evals/dream.test.ts --silent=false`.
 * Fails when a valid fact was forgotten or rewritten, a person file changed, or a to-do was closed.
 */
const AGENTS = [
  { id: "opencode", on: process.env.ION_LIVE === "1" },
  { id: "grok-build", on: process.env.ION_LIVE_GROK === "1" },
  { id: "claude-code", on: process.env.ION_LIVE_CLAUDE === "1" },
];
const live = AGENTS.filter((a) => a.on);
const ONLY = process.env.ION_MEMORY_CASES?.split(",").filter(Boolean);
const CASES = ONLY ? DREAM_CASES.filter((c) => ONLY.includes(c.id)) : DREAM_CASES;

type Row = {
  agent: string;
  id: string;
  measure: DreamCase["measure"];
  result: "pass" | "fail" | "error";
  why: string;
  /** Valid facts it forgot or rewrote (must be none). */
  validBroken: string[];
  did: DreamInfo | null;
  ms: number;
};

const scopeOf = (path: string): MemoryScope =>
  path.startsWith("you/") ? "you" : { projectId: path.split("/")[1]! };
const slugOf = (path: string) => path.slice(path.lastIndexOf("/") + 1, -3);

function repo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Shop\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=e@example.com", "-c", "user.name=E", "commit", "-q", "-m", "init");
}

/** A fresh ion home: shop, the agent everywhere, memory written by ion chief, and the case's chats. */
function homeFor(root: string, agent: string, c: DreamCase): { dataDir: string; configFile: string } {
  const home = join(root, agent.replace(/\W/g, "-"), c.id);
  repo(join(home, "projects", "shop"));
  const configFile = join(home, "config.toml");
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    ion: { ...DEFAULT_CONFIG.ion, quick: agent },
    access: { judge: agent },
    memory: { dream: "off" },
    projects: [{ id: "shop", path: join(home, "projects", "shop"), starred: false, harness: agent }],
  });
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, "ion.db"));
  const store = new EventStore(db, allViews);
  const memory = new MemoryFiles({ root: join(dataDir, "memory"), store, db });
  for (const s of c.seeds) {
    const header = s.header as unknown as MemoryHeader;
    memory.write({
      scope: scopeOf(s.path),
      slug: slugOf(s.path),
      header,
      text: s.text,
      by: { ion: "chief" },
    });
  }
  c.chats.forEach((x, i) => {
    const chatId = `c${i}`;
    const at = { chatId, runId: null, origin: "daemon" as const };
    store.append({ ...at, type: EV.chatCreated, data: { title: x.title, projectId: x.projectId } });
    store.append({ ...at, type: EV.messageSent, data: { text: x.you } });
    store.append({ ...at, origin: "adapter", type: EV.messageCompleted, data: { text: x.agent } });
  });
  db.close();
  return { dataDir, configFile };
}

const fileText = (dataDir: string, path: string) => {
  const f = join(dataDir, "memory", path);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
};

/** Every memory file's text after (yours and shop's). */
function allTexts(dataDir: string): string[] {
  return ["you", "projects/shop"].flatMap((d) => {
    const dir = join(dataDir, "memory", d);
    if (!existsSync(dir)) return [];
    const names = readdirSync(dir).filter((n) => n.endsWith(".md"));
    return names.map((n) => readFileSync(join(dir, n), "utf8"));
  });
}

/** A stale fact caught: no file says the old thing, and one says the new. */
function fixedWhy(f: { has?: RegExp; lacks: RegExp }, texts: string[]): string {
  if (texts.some((t) => f.lacks.test(t))) return "the stale fact is still there";
  if (f.has && !texts.some((t) => f.has!.test(t))) return "nothing says what changed";
  return "";
}

/** Two duplicates merged: one left, with every detail of both. */
function mergedWhy(m: { paths: [string, string]; has: RegExp[] }, dataDir: string): string {
  const left = m.paths.map((p) => fileText(dataDir, p)).filter((t): t is string => t !== null);
  if (left.length !== 1) return left.length ? "both duplicates are still there" : "both were forgotten";
  const lost = m.has.filter((r) => !r.test(left[0]!));
  return lost.length ? `the merge lost ${lost.join(" ")}` : "";
}

/** Why the case failed, or "" (valid facts are scored apart, in `validBroken`). */
function judge(c: DreamCase, dataDir: string, before: Map<string, string>, texts: string[]): string {
  const x = c.expect;
  const why = (x.fixed ? fixedWhy(x.fixed, texts) : "") || (x.merged ? mergedWhy(x.merged, dataDir) : "");
  if (why) return why;
  if (x.same && fileText(dataDir, x.same) !== before.get(x.same)) return "the person file changed";
  if (x.open && !/^status: *"?open"?$/m.test(fileText(dataDir, x.open) ?? "")) return "the to-do was closed";
  if (x.private && texts.some((t) => t.includes(x.private!) && !/^see: *"?ions"?$/m.test(t)))
    return "private text reached a file chats see";
  return "";
}

async function runCase(root: string, agent: string, c: DreamCase): Promise<Row> {
  const { dataDir, configFile } = homeFor(root, agent, c);
  const before = new Map(c.seeds.map((s) => [s.path, fileText(dataDir, s.path) ?? ""]));
  const srv = await startServer({ dataDir, configFile, port: 0 });
  const client = await connect({ port: srv.port, token: srv.token });
  const started = Date.now();
  try {
    const did = await client.call("memory.dream", {});
    const texts = allTexts(dataDir);
    const validBroken = c.valid.filter((p) => fileText(dataDir, p) !== before.get(p));
    const why = judge(c, dataDir, before, texts);
    const result = why ? "fail" : "pass";
    return { agent, id: c.id, measure: c.measure, result, why, validBroken, did, ms: Date.now() - started };
  } finally {
    client.close();
    await srv.close();
  }
}

function summary(agent: string, rows: Row[]) {
  const measures = Object.fromEntries(
    DREAM_MEASURES.map((m) => {
      const of = rows.filter((r) => r.measure === m);
      return [m, { pass: of.filter((r) => r.result === "pass").length, cases: of.length }];
    }),
  );
  return {
    agent,
    cases: rows.length,
    passed: rows.filter((r) => r.result === "pass").length,
    errors: rows.filter((r) => r.result === "error").map((r) => r.id),
    validBroken: rows.flatMap((r) => r.validBroken.map((p) => `${r.id}: ${p}`)),
    measures,
  };
}

describe.skipIf(live.length === 0)("dream evals", { timeout: 3_600_000 }, () => {
  let dir = "";
  const report: (ReturnType<typeof summary> & { rows: Row[] })[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ion-dream-eval-"));
    // ion's folders for the run live in the temp folder, never yours.
    process.env.ION_HOME = join(dir, "home");
  });

  afterAll(() => {
    const file = join(dir, "dream-evals.json");
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    const out = process.env.ION_EVAL_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      copyFileSync(file, join(out, `dream-evals-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    }
    for (const r of report)
      console.table(
        Object.entries(r.measures).map(([m, v]) => ({
          agent: r.agent,
          measure: m,
          passed: `${v.pass}/${v.cases}`,
        })),
      );
    console.log(`dream evals: ${file}`);
  });

  for (const a of live) {
    it(`${a.id}: valid facts, person files and to-dos are left alone`, async () => {
      const rows: Row[] = [];
      for (const c of CASES) {
        const r = await runCase(dir, a.id, c).catch(
          (e: unknown): Row => ({
            ...{ agent: a.id, id: c.id, measure: c.measure, result: "error", why: (e as Error).message },
            ...{ validBroken: [], did: null, ms: 0 },
          }),
        );
        console.log(
          `${a.id} ${r.id}: ${r.result}`,
          r.why && `(${r.why})`,
          r.validBroken.length ? "VALID BROKEN" : "",
        );
        rows.push(r);
      }
      const s = summary(a.id, rows);
      report.push({ ...s, rows });
      expect(s.validBroken, `${a.id} broke valid facts`).toEqual([]);
      for (const m of ["person", "todo"] as const)
        expect(
          rows.filter((r) => r.measure === m && r.result === "fail").map((r) => r.why),
          m,
        ).toEqual([]);
    });
  }
});
