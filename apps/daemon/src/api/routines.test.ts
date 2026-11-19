import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { loadUserConfig, saveUserConfig } from "@ion/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "./server.js";

const repo = (name: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "ion-repo-")), name);
  mkdirSync(p, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: p });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
  return p;
};

const until = async (f: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

// Plan 10: routines, kept in your config, run by the daemon; Activity shows what's next and what ran.
describe("routines and activity", () => {
  let home: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: IonClient;

  beforeEach(async () => {
    process.env.ION_ALLOW_FAKE = "1";
    home = mkdtempSync(join(tmpdir(), "ion-home-"));
    srv = await startServer({ dataDir: join(home, "data"), configFile: join(home, "config.toml"), port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
    await client.call("projects.add", { path: repo("app") });
    // The project's ion runs its threads on the fake agent.
    const cf = join(home, "config.toml");
    const { config } = loadUserConfig(cf);
    saveUserConfig(cf, { ...config, projects: config.projects.map((p) => ({ ...p, harness: "fake" })) });
  });
  afterEach(async () => {
    client.close();
    await srv.close();
  });

  const add = () =>
    client.call("routine.add", { projectId: "app", name: "Morning check", when: "daily 9:00", text: "edit" });

  it("adds one to the project's ion, and refuses a bad one", async () => {
    expect(await add()).toEqual({
      id: "morning-check",
      name: "Morning check",
      when: "daily 09:00",
      text: "edit",
      on: true,
    });
    expect((await client.call("projects.list", {}))[0]?.routines).toHaveLength(1);
    await expect(
      client.call("routine.add", { projectId: "app", name: "x", when: "soon", text: "y" }),
    ).rejects.toThrow("Pick when it runs");
    await expect(
      client.call("routine.add", {
        projectId: "app",
        name: "x",
        when: "daily 9:00",
        text: "y",
        effort: "huge" as never,
      }),
    ).rejects.toThrow("Pick low, medium, high or max");
  });

  it("lists what's next in activity; off, skipped, paused and removed", async () => {
    await add();
    const up = async () => (await client.call("activity.list", {})).upcoming[0];
    expect(await up()).toMatchObject({ routineId: "morning-check", ion: "app", on: true, skipped: false });
    await client.call("routine.update", { projectId: "app", routineId: "morning-check", skip: true });
    expect(await up()).toMatchObject({ skipped: true });
    await client.call("routine.update", { projectId: "app", routineId: "morning-check", skip: false });
    expect(await up()).toMatchObject({ skipped: false });
    await client.call("routine.update", { projectId: "app", routineId: "morning-check", on: false });
    expect(await up()).toMatchObject({ on: false, next: null });
    await client.call("routines.pause", { paused: true });
    expect((await client.call("activity.list", {})).paused).toBe(true);
    await client.call("routine.remove", { projectId: "app", routineId: "morning-check" });
    expect((await client.call("activity.list", {})).upcoming).toEqual([]);
    await expect(
      client.call("routine.remove", { projectId: "app", routineId: "morning-check" }),
    ).rejects.toThrow("Unknown routine: morning-check");
  });

  it("runs one now: a thread titled by its name, shown in today's activity", async () => {
    await add();
    const { chatId } = await client.call("routine.run", { projectId: "app", routineId: "morning-check" });
    const chat = (await client.call("chats.list", {})).find((c) => c.chatId === chatId);
    expect(chat).toMatchObject({ title: "Morning check", by: "ion", projectId: "app" });
    await until(async () => (await client.call("activity.list", {})).today.length > 0, 5000);
    const [run] = (await client.call("activity.list", {})).today;
    expect(run).toMatchObject({ chatId, title: "Morning check", ion: "app", routine: "Morning check" });
  });
});
