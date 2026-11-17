import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import type { IonEvent } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "./server.js";

const repo = (name: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "ion-repo-")), name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
};

describe("daemon api", () => {
  let home: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: IonClient;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ion-home-"));
    srv = await startServer({ dataDir: join(home, "data"), configFile: join(home, "config.toml"), port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
  });
  afterEach(async () => {
    client.close();
    await srv.close();
  });

  it("closes connections with a wrong token using 4401", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/?token=wrong`);
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(4401);
  });

  it("keeps its data folder private", () => {
    expect(statSync(join(home, "data")).mode & 0o777).toBe(0o700);
  });

  it("reports status", async () => {
    const s = await client.call("status", {});
    expect(s).toMatchObject({ projects: 0, configError: null, pid: process.pid });
  });

  it("adds a project and saves it to the config file", async () => {
    const p = repo("storefront");
    expect(await client.call("projects.add", { path: p })).toEqual({
      id: "storefront",
      path: p,
      starred: false,
    });
    expect(await client.call("projects.list", {})).toHaveLength(1);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(p);
  });

  it("rejects a folder that isn't a git repo", async () => {
    await expect(client.call("projects.add", { path: "/nope" })).rejects.toThrow(
      "Not a git repository: /nope",
    );
  });

  it("answers unknown commands with unknown_command", async () => {
    await expect(client.call("does.not.exist" as never, {} as never)).rejects.toMatchObject({
      code: "unknown_command",
    });
  });

  it("rejects a subscription from an unknown event id and keeps serving", async () => {
    await expect(client.subscribe({ afterId: "01JDNOPE" }, () => {})).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await client.call("status", {})).toMatchObject({ projects: 0 });
  });

  it("pushes events to subscribers, and only later ones after afterId", async () => {
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const first = await client.call("chat.create", { title: "One" });
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({
      type: "chat.created",
      origin: "daemon",
      data: { title: "One", projectId: null },
    });

    await client.call("chat.create", { title: "Two" });
    const later: IonEvent[] = [];
    await client.subscribe({ afterId: first.id }, (e) => later.push(e));
    await until(() => later.length === 1);
    expect(later.map((e) => (e.data as { title: string }).title)).toEqual(["Two"]);
  });
});

async function until(f: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
