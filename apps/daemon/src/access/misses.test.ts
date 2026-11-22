import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JudgeMisses } from "./misses.js";

// Final review, 2026-11-22: Grok's judge timed out in every live chat and nothing said so. Each time an agent's judge
// doesn't answer (too slow, or failed) it's counted; Settings → Agents shows the last 7 days' count per agent.
describe("JudgeMisses", () => {
  it("counts each agent's misses over the last 7 days, kept in a file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ion-misses-")), "judge-misses.json");
    let now = 1_000_000_000_000;
    const m = new JudgeMisses(file, () => now);
    m.add("grok-build");
    m.add("grok-build");
    m.add("opencode");
    expect(m.counts()).toEqual({ "grok-build": 2, opencode: 1 });
    now += 6 * 86_400_000;
    m.add("grok-build");
    expect(new JudgeMisses(file, () => now).counts()).toEqual({ "grok-build": 3, opencode: 1 });
    now += 2 * 86_400_000;
    expect(m.counts()).toEqual({ "grok-build": 1 });
  });

  it("starts empty when its file is missing or garbled", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ion-misses-")), "judge-misses.json");
    expect(new JudgeMisses(file).counts()).toEqual({});
  });
});
