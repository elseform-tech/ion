import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
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

const { harnessRunner, sweepTmp } = await import("./runner.js");

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
  it("starts the agent in a run's sandbox, in a folder in ion's data folder, removed after", async () => {
    const o = setup();
    started.length = 0;
    expect(await harnessRunner({ ...o, sandbox: "seatbelt" })("hi", new AbortController().signal)).toBe("ok");
    const s = started[0]!;
    expect(s.cwd.startsWith(join(o.dataDir, "scratch", "ion-judge-"))).toBe(true);
    expect(seen[0]?.dirExists).toBe(true);
    expect(existsSync(s.cwd)).toBe(false);
    expect(s.bare).toBe(true);
    expect(s.sandbox?.kind).toBe("seatbelt");
    expect(s.sandbox?.paths.deny).toContain(o.dataDir);
    expect(s.sandbox?.paths.write).toEqual([s.cwd]);
    expect(s.sandbox?.paths.noWrite.length).toBeGreaterThan(0);
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
    for (const d of ["ion-probe-a", "ion-judge-b", "ion-tour", "ion-tour2", "ion-setup-c", "other"])
      mkdirSync(join(tmp, d));
    writeFileSync(join(tmp, "ion-probe-file"), "x");
    sweepTmp(tmp);
    expect(readdirSync(tmp).sort()).toEqual(["ion-probe-file", "ion-setup-c", "ion-tour", "ion-tour2", "other"]);
  });
});
