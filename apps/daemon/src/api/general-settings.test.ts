import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "./server.js";

const repo = (name: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "ion-repo-")), name);
  mkdirSync(p, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: p });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
  return p;
};

// The user, 2026-11-19: "also build the settings as well… like the general if needed, tools, notifications,
// shortcuts…". General and notification settings live in your config and are read and written through the daemon.
describe("General and notification settings", () => {
  let home: string;
  let file: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: IonClient;

  beforeEach(async () => {
    process.env.ION_ALLOW_FAKE = "1";
    home = mkdtempSync(join(tmpdir(), "ion-home-"));
    file = join(home, "config.toml");
    srv = await startServer({ dataDir: join(home, "data"), configFile: file, port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
  });
  afterEach(async () => {
    client.close();
    await srv.close();
  });

  it("saves each General setting and reads it back", async () => {
    const first = await client.call("settings.get", {});
    expect(first).toMatchObject({
      access: "auto",
      maxRuns: "auto",
      notifications: {
        briefing: { on: true, at: "08:30" },
        quiet: { on: true, from: "22:00", to: "08:00" },
      },
    });
    await client.call("settings.set", {
      patch: {
        access: "full",
        maxRuns: 3,
        notifications: { briefing: { on: false, at: "07:15" }, quiet: { to: "06:00" } },
      },
    });
    const got = await client.call("settings.get", {});
    expect(got).toMatchObject({
      access: "full",
      maxRuns: 3,
      notifications: {
        briefing: { on: false, at: "07:15" },
        quiet: { on: true, from: "22:00", to: "06:00" },
      },
    });
    const toml = readFileSync(file, "utf8");
    expect(toml).toContain("max_runs = 3");
  });

  it("refuses a bad time or count and leaves the file alone", async () => {
    await client.call("settings.set", { patch: { maxRuns: 2 } });
    const before = readFileSync(file, "utf8");
    const set = (patch: object) => client.call("settings.set", { patch: patch as never });
    await expect(set({ notifications: { briefing: { at: "25:00" } } })).rejects.toThrow(
      "Use a time like 08:30",
    );
    await expect(set({ notifications: { quiet: { from: "8:30" } } })).rejects.toThrow(
      "Use a time like 08:30",
    );
    await expect(set({ maxRuns: 0 })).rejects.toThrow("Between 1 and 32 chats");
    await expect(set({ maxRuns: 33 })).rejects.toThrow("Between 1 and 32 chats");
    await expect(set({ maxRuns: 2.5 })).rejects.toThrow("Between 1 and 32 chats");
    await expect(set({ access: "none" })).rejects.toThrow("Pick auto or full");
    // A good field in the same patch is not saved when another is bad.
    await expect(set({ access: "full", maxRuns: 0 })).rejects.toThrow("Between 1 and 32 chats");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps unknown keys on save", async () => {
    writeFileSync(file, 'future = "x"\n\n[notifications]\nsound = "ping"\n\n[resources]\nextra = 1\n');
    await client.call("settings.set", {
      patch: { notifications: { briefing: { at: "09:00" } } },
    });
    const toml = readFileSync(file, "utf8");
    expect(toml).toContain('future = "x"');
    expect(toml).toContain('sound = "ping"');
    expect(toml).toContain("extra = 1");
    expect(toml).toContain('at = "09:00"');
  });

  it("a removed project's level goes with it", async () => {
    const added = await client.call("projects.add", { path: repo("app") });
    const id = (added as { id?: string }).id ?? "app";
    expect((await client.call("settings.get", {})).notifications.projects[id]).toBe("needs");
    await client.call("settings.set", { patch: { notifications: { projects: { [id]: "muted" } } } });
    expect((await client.call("settings.get", {})).notifications.projects[id]).toBe("muted");
    await expect(
      client.call("settings.set", { patch: { notifications: { projects: { nope: "all" } } } }),
    ).rejects.toThrow("Unknown project: nope");
    await expect(
      client.call("settings.set", { patch: { notifications: { projects: { [id]: "loud" as never } } } }),
    ).rejects.toThrow("Pick all, needs, digest or muted");
    await client.call("project.remove", { projectId: id });
    expect((await client.call("settings.get", {})).notifications.projects).not.toHaveProperty(id);
    expect(readFileSync(file, "utf8")).not.toContain("muted");
  });

  // Task review, 2026-11-20: a bad hand-edited setting once emptied the whole config; now the daemon starts, keeps
  // your projects and logs one warning.
  it("starts with a bad hand-edited setting, keeps the projects and logs a warning", async () => {
    await client.call("projects.add", { path: repo("app") });
    await srv.close();
    writeFileSync(file, readFileSync(file, "utf8").replace('max_runs = "auto"', "max_runs = 40"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    srv = await startServer({ dataDir: join(home, "data"), configFile: file, port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
    expect(warn.mock.calls.flat().join(" ")).toContain("max_runs");
    warn.mockRestore();
    expect((await client.call("projects.list", {})).length).toBeGreaterThan(0);
    expect((await client.call("settings.get", {})).maxRuns).toBe("auto");
  });
});
