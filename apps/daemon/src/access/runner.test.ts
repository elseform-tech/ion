import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartOpts } from "@ion/adapter-kit";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { describe, expect, it, vi } from "vitest";

const started: StartOpts[] = [];
const seen: { dirExists: boolean }[] = [];

vi.mock("../adapters/registry.js", () => ({
  getHarness: (id: string) =>
    id === "x"
      ? {
          label: "X",
          loginHint: "x login",
          adapter: {
            start: async (o: StartOpts) => {
              started.push(o);
              seen.push({ dirExists: existsSync(o.cwd) });
              return {
                id: "s",
                nativeId: null,
                send: async () => {},
                async *events() {
                  yield { type: EV.messageCompleted, data: { text: "ok" } };
                },
                interrupt: async () => {},
                close: async () => {},
              };
            },
          },
        }
      : null,
}));

const { clearScratch, harnessRunner, sweepTmp } = await import("./runner.js");

function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ion-runner-")));
  const configFile = join(home, "config", "config.toml");
  saveUserConfig(configFile, { ...DEFAULT_CONFIG, access: { ...DEFAULT_CONFIG.access, judge: "x" } });
  return { configFile, dataDir: join(home, "data") };
}

describe("harnessRunner's sandbox and folder", () => {
  // Final review, 2026-11-22: the judge (and ion's quick model) started agents outside the OS sandbox, in $TMPDIR;
  // on Grok and opencode those processes keep their tools and load their plugins. Each now starts in a run's sandbox
  // (ion's folders denied, agents' configs read-only), in a folder of ion's data folder that's removed after.
  // PR #25 review, 2026-11-22: the judge and the quick model shared one folder per agent, kept between verdicts, and
  // Grok's profile was written inside it. Each session now gets a fresh folder (removed when it ends) under its kind's
  // own folder (judge and quick model apart: their processes too), and the agent's own files (Grok's profile) go in a
  // daemon-only folder outside it.
  it("gives every session its own folder, judge and quick model apart, removed when it ends", async () => {
    const o = setup();
    saveUserConfig(o.configFile, {
      ...DEFAULT_CONFIG,
      ion: { ...DEFAULT_CONFIG.ion, quick: "x" },
      access: { ...DEFAULT_CONFIG.access, judge: "x" },
    });
    started.length = 0;
    seen.length = 0;
    expect(await harnessRunner({ ...o, sandbox: "seatbelt" })("hi", new AbortController().signal)).toBe("ok");
    await harnessRunner({ ...o, sandbox: "seatbelt" })("hi", new AbortController().signal);
    await harnessRunner({ ...o, sandbox: "seatbelt" }, "quick")("hi", new AbortController().signal);
    const [a, b, q] = started as [StartOpts, StartOpts, StartOpts];
    const judgeBase = join(o.dataDir, "scratch", "ion-judge-x");
    const quickBase = join(o.dataDir, "scratch", "ion-quick-x");
    expect(a.cwd.startsWith(`${judgeBase}/`)).toBe(true);
    expect(b.cwd.startsWith(`${judgeBase}/`)).toBe(true);
    expect(a.cwd).not.toBe(b.cwd);
    expect(q.cwd.startsWith(`${quickBase}/`)).toBe(true);
    expect(seen.every((x) => x.dirExists)).toBe(true);
    for (const s of started) expect(existsSync(s.cwd)).toBe(false);
    expect(a.sandbox?.paths.write).toEqual([judgeBase]);
    expect(q.sandbox?.paths.write).toEqual([quickBase]);
    expect(a.bareHome?.startsWith(join(o.dataDir, "scratch"))).toBe(true);
    expect(a.bareHome?.startsWith(`${judgeBase}/`)).toBe(false);
    expect(q.bareHome).not.toBe(a.bareHome);
    expect(a.sandbox?.kind).toBe("seatbelt");
    expect(a.sandbox?.paths.deny).toContain(o.dataDir);
    expect(a.bare).toBe(true);
  });

  it("empties ion's scratch folder at the daemon's start", async () => {
    const o = setup();
    await harnessRunner({ ...o, sandbox: "seatbelt" })("hi", new AbortController().signal);
    expect(existsSync(join(o.dataDir, "scratch"))).toBe(true);
    clearScratch(o.dataDir);
    expect(existsSync(join(o.dataDir, "scratch"))).toBe(false);
  });

  it("starts it with no sandbox only where the computer has none", async () => {
    const o = setup();
    started.length = 0;
    await harnessRunner({ ...o, sandbox: "none" })("hi", new AbortController().signal);
    expect(started[0]?.sandbox).toBeUndefined();
  });
});

describe("sweepTmp", () => {
  // Final review, 2026-11-22: probes and judges left ion-probe-* and ion-judge-* folders in $TMPDIR. They go at the
  // daemon's start; nothing else there is touched (the tour's /tmp/ion-tour folders least of all).
  it("removes only ion-probe-* and ion-judge-* folders (not files)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sweep-"));
    const old = new Date(Date.now() - 2 * 3600_000);
    for (const d of ["ion-probe-a", "ion-judge-b", "ion-tour", "ion-tour2", "ion-setup-c", "other"]) {
      mkdirSync(join(tmp, d));
      utimesSync(join(tmp, d), old, old);
    }
    writeFileSync(join(tmp, "ion-probe-file"), "x");
    sweepTmp(tmp);
    expect(readdirSync(tmp).sort()).toEqual([
      "ion-probe-file",
      "ion-setup-c",
      "ion-tour",
      "ion-tour2",
      "other",
    ]);
  });

  // pnpm check, 2026-11-22: a daemon another test started swept a test's live ion-judge-* home out from under it (the
  // judge then read no config). Only folders untouched for an hour go: none in use.
  it("leaves a folder that's been touched in the last hour", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sweep-"));
    mkdirSync(join(tmp, "ion-judge-live"));
    sweepTmp(tmp);
    expect(readdirSync(tmp)).toEqual(["ion-judge-live"]);
  });
});
