import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Your local servers' process groups, recorded in ion's data folder while they run, so a daemon that died without
 * stopping them (a crash, kill -9) has them stopped at its next start.
 */
/** The record's file name in ion's data folder. */
export const MCP_GROUPS = "mcp-groups.json";

type Group = { pgid: number; started: number; command: string };

/** A group's start and ps's clock agree within this (ps counts whole seconds). */
const SLACK_MS = 5000;

function read(file: string): Group[] {
  try {
    const all = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(all)
      ? all.filter(
          (g): g is Group => Number.isInteger(g?.pgid) && g.pgid > 1 && typeof g.started === "number",
        )
      : [];
  } catch {
    return [];
  }
}

function write(file: string, groups: Group[]): void {
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(groups), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.warn(`mcp: ion couldn't record its servers: ${(e as Error).name}`);
  }
}

/** Notes a server's group as it starts. */
export function recordGroup(file: string, g: Group): void {
  write(file, [...read(file).filter((x) => x.pgid !== g.pgid), g]);
}

/** Forgets a group once nothing of it is left. */
export function forgetGroup(file: string, pgid: number): void {
  const all = read(file);
  if (all.some((g) => g.pgid === pgid))
    write(
      file,
      all.filter((g) => g.pgid !== pgid),
    );
}

/** `[[dd-]hh:]mm:ss` as ms. */
function elapsedMs(etime: string): number {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = (rest ?? "").split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return ((Number(days) * 24 + h) * 60 + m) * 60_000 + s * 1000;
}

/** ps by its own path, never looked up on PATH. */
const PS = existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";

type Row = { pid: number; pgid: number; started: number };

function processes(): Promise<Row[]> {
  return new Promise((resolve) => {
    execFile(PS, ["-A", "-o", "pid=,pgid=,etime="], (err, out) => {
      if (err) return resolve([]);
      const now = Date.now();
      resolve(
        out
          .split("\n")
          .map((l) => l.trim().split(/\s+/))
          .filter((c) => c.length === 3)
          .map(([pid, pgid, etime]) => ({
            pid: Number(pid),
            pgid: Number(pgid),
            started: now - elapsedMs(etime!),
          })),
      );
    });
  });
}

/**
 * Whether a recorded group is still the one ion started: its leader (the server ion started, whose pid is the
 * group's id) is there and started when ion recorded it. Without its leader, the id may be another group's.
 */
function stillOurs(g: Group, members: Row[]): boolean {
  const leader = members.find((m) => m.pid === g.pgid);
  return !!leader && Math.abs(leader.started - g.started) <= SLACK_MS;
}

/**
 * At ion's start, before any run: stops every recorded group an earlier daemon left running (what's still alive
 * and still the group it started), then clears the record.
 */
export async function sweepGroups(file: string): Promise<void> {
  const groups = read(file);
  if (!groups.length) return;
  const all = await processes();
  for (const g of groups) {
    const members = all.filter((p) => p.pgid === g.pgid);
    if (members.length && stillOurs(g, members))
      try {
        process.kill(-g.pgid, "SIGKILL");
        console.warn(`mcp: stopped ${g.command}, left running by an earlier ion`);
      } catch {
        // Gone meanwhile.
      }
  }
  write(file, []);
}
