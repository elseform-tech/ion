import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { GroupTransport, MAX_LINE } from "./group-transport.js";

// Task review, 2026-11-21: a server writing without newlines grew ion's buffer past its limit (RSS 80 MB → 2.3 GB),
// stalled the event loop and took ~10 s to stop; a line split across chunks must still parse; what a server wrote
// just before it exited must still be read.

const node = (script: string, groups?: string) =>
  new GroupTransport({
    groups,
    command: process.execPath,
    args: ["-e", script],
    env: { PATH: process.env.PATH ?? "" },
    cwd: mkdtempSync(join(tmpdir(), "ion-transport-")),
  });

const heard = (t: GroupTransport) => {
  const got: JSONRPCMessage[] = [];
  t.onmessage = (m) => got.push(m);
  return got;
};
const closed = (t: GroupTransport) => new Promise<void>((r) => (t.onclose = r));

describe("ion's stdio transport to a local server", () => {
  it("stops a server that writes 100 MB without a newline within 3 s, its buffer never over the cap", async () => {
    const t = node(
      "const c = 'x'.repeat(1 << 20); let n = 0; (function w() { while (n < 100 && process.stdout.write(c)) n++; if (n++ < 100) process.stdout.once('drain', w); })(); setInterval(() => {}, 1000);",
    );
    const end = closed(t);
    const at = Date.now();
    await t.start();
    await end;
    expect(Date.now() - at).toBeLessThan(3000);
    expect(t.tooMuch).toBe(true);
    expect(t.peak).toBeLessThanOrEqual(MAX_LINE);
  }, 10_000);

  it("parses a line split across chunks", async () => {
    const t = node(
      `process.stdout.write('{"jsonrpc":"2.0",'); setTimeout(() => process.stdout.write('"method":"notifications/x"}\\n{"jsonrpc":"2.0","method":"notifications/y"}\\n'), 200); setInterval(() => {}, 1000);`,
    );
    const got = heard(t);
    await t.start();
    await expect.poll(() => got.length).toBe(2);
    expect(got.map((m) => (m as { method: string }).method)).toEqual(["notifications/x", "notifications/y"]);
    await t.close();
  });

  it("reads what a server wrote just before it exited", async () => {
    // Written straight into the pipe, then gone: it's still in the pipe when ion hears the exit.
    const t = node(
      `for (let i = 0; i < 20; i++) require("fs").writeSync(1, JSON.stringify({ jsonrpc: "2.0", method: "notifications/n" + i, params: { pad: "y".repeat(2000) } }) + "\\n"); process.exit(0);`,
    );
    const got = heard(t);
    const end = closed(t);
    await t.start();
    await end;
    expect(got).toHaveLength(20);
  });

  // Security review, 2026-11-21: an overflowing server was only SIGKILLed once, best effort: no error said why, the
  // stop skipped close()'s bookkeeping, and a signal could go to a group after its process had exited.
  it("stops an overflowing server the normal way: says why, closes once, forgets its group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-transport-groups-"));
    const groups = join(dir, "mcp-groups.json");
    const t = node(
      "const c = 'x'.repeat(1 << 20); let n = 0; (function w() { while (n < 40 && process.stdout.write(c)) n++; if (n++ < 40) process.stdout.once('drain', w); })(); setInterval(() => {}, 1000);",
      groups,
    );
    const errors: string[] = [];
    t.onerror = (e) => errors.push(e.message);
    let closes = 0;
    const end = new Promise<void>((r) => {
      t.onclose = () => {
        closes++;
        r();
      };
    });
    await t.start();
    await end;
    await new Promise((r) => setTimeout(r, 300));
    expect(t.tooMuch).toBe(true);
    expect(errors).toContain("server sent too much");
    expect(closes).toBe(1);
    expect(existsSync(groups) ? readFileSync(groups, "utf8") : "[]").not.toMatch(/"pgid":\s*[1-9]/);
  }, 15_000);

  it("sends no signal for an overflow once the server has exited", async () => {
    const t = node("process.exit(0)");
    const end = closed(t);
    await t.start();
    await end;
    // The exit event not yet heard, but the process is gone.
    (t as unknown as { exited: boolean; stopping: boolean }).exited = false;
    const kill = vi.spyOn(process, "kill");
    try {
      (t as unknown as { read(c: Buffer): void }).read(Buffer.alloc(MAX_LINE + 1, 120));
      await new Promise((r) => setTimeout(r, 100));
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("refuses a line over the cap before joining it, even when its newline is in the same chunk", async () => {
    const t = node("setInterval(() => {}, 1000);");
    const got = heard(t);
    const errors: string[] = [];
    t.onerror = (e) => errors.push(e.message);
    await t.start();
    const concat = vi.spyOn(Buffer, "concat");
    try {
      const big = Buffer.alloc(20 * 1024 * 1024, 120);
      big[big.length - 1] = 10;
      (t as unknown as { read(c: Buffer): void }).read(big);
      const joined = Math.max(
        0,
        ...concat.mock.calls.map(([parts]) => (parts as Buffer[]).reduce((n, b) => n + b.length, 0)),
      );
      expect(joined).toBeLessThanOrEqual(MAX_LINE);
    } finally {
      concat.mockRestore();
    }
    expect(t.tooMuch).toBe(true);
    expect(got).toHaveLength(0);
    expect(errors).toContain("server sent too much");
    await t.close();
  });
});
