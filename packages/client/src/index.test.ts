import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDaemonInfo } from "./index.js";

const dirWith = (x: unknown) => {
  const d = mkdtempSync(join(tmpdir(), "ion-info-"));
  writeFileSync(join(d, "daemon.json"), JSON.stringify(x));
  return d;
};

describe("readDaemonInfo", () => {
  it("reads a valid file", () => {
    expect(readDaemonInfo(dirWith({ pid: 1, port: 4000, token: "t" }))).toEqual({
      pid: 1,
      port: 4000,
      token: "t",
    });
  });
  it("rejects ports outside 1–65535 and a missing pid", () => {
    expect(readDaemonInfo(dirWith({ pid: 1, port: 0, token: "t" }))).toBeNull();
    expect(readDaemonInfo(dirWith({ pid: 1, port: 70000, token: "t" }))).toBeNull();
    expect(readDaemonInfo(dirWith({ port: 4000, token: "t" }))).toBeNull();
  });
  it("returns null when the file is missing", () => {
    expect(readDaemonInfo(mkdtempSync(join(tmpdir(), "ion-none-")))).toBeNull();
  });
});
