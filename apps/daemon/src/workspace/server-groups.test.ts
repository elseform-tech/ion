import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepGroups } from "./server-groups.js";

// Task review, 2026-11-21: a daemon that died (crash, kill -9) left your local servers running with no one to stop
// them. ion records each server's process group and, at its next start, stops the ones an earlier daemon started.

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const groupAlive = (pgid: number) => alive(-pgid);
const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0))
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Gone.
    }
});

const exits = new Map<number, Promise<unknown>>();

/** A process group like a server's: its own group, as ion starts them. */
function group(): number {
  const child = spawn("sleep", ["4242"], { detached: true, stdio: "ignore" });
  started.push(child.pid!);
  exits.set(child.pid!, new Promise((r) => child.once("exit", r)));
  return child.pid!;
}

describe("the startup sweep", () => {
  it("stops the groups an earlier daemon started, leaves a reused one alone, and clears the record", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ion-groups-")), "mcp-groups.json");
    const ours = group();
    const reused = group();
    writeFileSync(
      file,
      JSON.stringify([
        { pgid: ours, started: Date.now(), command: "sleep" },
        // Recorded an hour ago: the live group with that id now is someone else's.
        { pgid: reused, started: Date.now() - 3600_000, command: "sleep" },
        { pgid: 999_999, started: Date.now(), command: "gone" },
      ]),
    );
    await new Promise((r) => setTimeout(r, 100));
    await sweepGroups(file);
    await exits.get(ours);
    expect(alive(ours)).toBe(false);
    expect(alive(reused)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  // Task review, 2026-11-21: with the leader gone, a reused id whose new leader also exited passed the check, and an
  // unrelated group was killed. Only a group whose recorded leader is there, started when recorded, is killed.
  it("leaves a group alone when its leader is gone", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ion-groups-")), "mcp-groups.json");
    const child = spawn("/bin/sh", ["-c", "sleep 4242 & exit 0"], { detached: true, stdio: "ignore" });
    const pgid = child.pid!;
    started.push(pgid);
    await new Promise((r) => child.once("exit", r));
    expect(groupAlive(pgid)).toBe(true);
    writeFileSync(file, JSON.stringify([{ pgid, started: Date.now(), command: "sh" }]));
    await sweepGroups(file);
    await new Promise((r) => setTimeout(r, 200));
    expect(groupAlive(pgid)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("a missing or broken record is nothing to sweep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-groups-"));
    await expect(sweepGroups(join(dir, "none.json"))).resolves.toBeUndefined();
    writeFileSync(join(dir, "bad.json"), "{");
    await expect(sweepGroups(join(dir, "bad.json"))).resolves.toBeUndefined();
  });
});
