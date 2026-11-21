import { closeSync, fstatSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { afterEach, describe, expect, it } from "vitest";
import { memorySecrets } from "../secrets/index.js";
import { agentHome, GH } from "../tools/import-testing.js";
import { startServer } from "./server.js";

/** A file's change time and text, read through one open file (no check-then-read). */
function statAndText(f: string): [number, string] {
  const fd = openSync(f, "r");
  try {
    return [fstatSync(fd).mtimeMs, readFileSync(fd, "utf8")];
  } finally {
    closeSync(fd);
  }
}

// The user, 2026-11-21: "Only ion's, plus Import": servers come in from each agent's own config, off, with keys left
// out; "yes, add both prompts to Task 9": the first time, how many servers each agent has; later, what's new in one.

let srv: Awaited<ReturnType<typeof startServer>>;
let home: string;
let project: string;
const clients: IonClient[] = [];

async function start(servers: Record<string, unknown> = {}) {
  ({ home, project } = agentHome());
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  writeFileSync(join(home, "config.toml"), `[[projects]]\nid = "shop"\npath = "${project}"\n`);
  srv = await startServer({
    dataDir: join(home, "data"),
    configFile: join(home, "config.toml"),
    port: 0,
    secrets: memorySecrets(),
    home,
  });
  const you = await connect({ port: srv.port, token: srv.token });
  clients.push(you);
  return you;
}

const mcpJson = () =>
  JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")).mcpServers as Record<string, unknown>;

/** Every file of the agents' own (name, size, time changed, contents). */
function agentFiles(): string {
  const files = [
    ".claude.json",
    ".codex/config.toml",
    ".config/opencode/opencode.jsonc",
    ".grok/config.toml",
    "shop/.mcp.json",
  ].map((f) => join(home, f));
  return JSON.stringify(files.map((f) => [f, ...statAndText(f)]));
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await srv.close();
});

describe("Import", () => {
  it("imported servers start off and carry no literal secret", async () => {
    const you = await start();
    const r = await you.call("tools.import", { agent: "claude-code" });
    expect(r.imported.map((i) => i.name)).toEqual(["github", "notes", "shopdb"]);
    expect(r.imported.every((i) => !i.on)).toBe(true);
    expect(r.imported[0]?.origin).toMatchObject({ by: "you", source: "Imported from Claude Code" });
    expect(mcpJson().github).toEqual({
      command: "gh-mcp",
      args: ["serve"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG: "info" },
    });
    expect(readFileSync(join(home, "mcp.json"), "utf8")).not.toContain(GH);
    const info = await you.call("tools.list", {});
    expect(info.mcp.find((s) => s.id === "github")).toMatchObject({
      on: false,
      needs: "key",
      origin: { source: "Imported from Claude Code" },
    });
    const data = readdirSync(join(home, "data"), { recursive: true, encoding: "utf8" });
    for (const f of data.map((x) => join(home, "data", x)).filter((x) => statSync(x).isFile()))
      expect(readFileSync(f, "utf8")).not.toContain(GH);
  });

  it("Import never edits an agent's files", async () => {
    const you = await start();
    const before = agentFiles();
    await you.call("tools.importable", {});
    await you.call("tools.import", {});
    await you.call("tools.dismissImport", {});
    expect(agentFiles()).toBe(before);
  });

  it("a server already in mcp.json isn't listed", async () => {
    const you = await start({ GitHub: { command: "mine" } });
    const info = await you.call("tools.importable", {});
    expect(info.servers.map((s) => s.name)).not.toContain("github");
    expect(info.servers.find((s) => s.name === "linear")).toMatchObject({ from: "Codex", transport: "http" });
    await you.call("tools.import", { names: ["linear"] });
    expect((await you.call("tools.importable", {})).servers.map((s) => s.name)).not.toContain("linear");
  });

  it("the first time, Tools says how many servers each agent has, with Import", async () => {
    const you = await start();
    const { prompts } = await you.call("tools.importable", {});
    expect(prompts).toEqual([
      { agent: "claude-code", from: "Claude Code", names: ["github", "notes", "shopdb"], first: true },
      { agent: "codex", from: "Codex", names: ["linear", "fs"], first: true },
      { agent: "opencode", from: "opencode", names: ["everything"], first: true },
      { agent: "grok-build", from: "Grok Build", names: ["search"], first: true },
    ]);
  });

  it("a dismissed prompt stays hidden until something new appears", async () => {
    const you = await start();
    const after = await you.call("tools.dismissImport", { agent: "codex" });
    expect(after.prompts.map((p) => p.agent)).not.toContain("codex");
    expect((await you.call("tools.importable", {})).prompts.map((p) => p.agent)).not.toContain("codex");
    // Still listed for Import beside the config file.
    expect(after.servers.map((s) => s.name)).toContain("linear");
  });

  it("a server added to an agent's config later shows as New in that agent", async () => {
    const you = await start();
    await you.call("tools.dismissImport", {});
    expect((await you.call("tools.importable", {})).prompts).toEqual([]);
    const toml = join(home, ".codex", "config.toml");
    writeFileSync(
      toml,
      `${readFileSync(toml, "utf8")}\n[mcp_servers.sentry]\nurl = "https://mcp.sentry.dev/mcp"\n`,
    );
    const info = await you.call("tools.importable", {});
    expect(info.prompts).toEqual([{ agent: "codex", from: "Codex", names: ["sentry"], first: false }]);
    expect(info.servers.find((s) => s.name === "sentry")?.new).toBe(true);
    expect(info.servers.find((s) => s.name === "linear")?.new).toBeUndefined();
  });

  // Security review, 2026-11-21: servers in a project's own files were written by the repo, not you, yet came in as
  // "Imported from Claude Code". They're never in Import all or the prompts; only by name, and say which file.
  it("a server in a repo's .mcp.json isn't in Import all or the prompts", async () => {
    const you = await start();
    const info = await you.call("tools.importable", {});
    expect(info.servers.find((s) => s.name === "repotool")).toMatchObject({
      repo: { project: "shop", file: ".mcp.json" },
      line: "repo-mcp --serve",
    });
    expect(info.prompts.flatMap((p) => p.names)).not.toContain("repotool");
    const all = await you.call("tools.import", {});
    expect(all.imported.map((i) => i.name)).not.toContain("repotool");
    const mine = await you.call("tools.import", { agent: "claude-code" });
    expect(mine.imported.map((i) => i.name)).not.toContain("repotool");
    expect(mcpJson().repotool).toBeUndefined();
  });

  it("its source names the repo file", async () => {
    const you = await start();
    // Task review, 2026-11-21: its name alone doesn't bring it in; its project's file must be named too.
    const named = await you.call("tools.import", { names: ["repotool"] });
    expect(named.imported).toEqual([]);
    expect(mcpJson().repotool).toBeUndefined();
    const r = await you.call("tools.import", { names: ["repotool"], repo: "shop:.mcp.json" });
    expect(r.imported[0]).toMatchObject({ name: "repotool", origin: { source: "From shop's .mcp.json" } });
    const info = await you.call("tools.list", {});
    expect(info.mcp.find((s) => s.id === "repotool")?.origin?.source).toBe("From shop's .mcp.json");
  });

  // Task review, 2026-11-21: Claude Code's sources came first, so a repo's .mcp.json "linear" hid your Codex linear and
  // came in under its name. Your own servers come first, and a repo's server with one of their names is left out.
  it("a repo's server never hides one of yours with the same name", async () => {
    const you = await start();
    const info = await you.call("tools.importable", {});
    expect(info.servers.filter((s) => s.name === "linear")).toEqual([
      expect.objectContaining({ agent: "codex", from: "Codex" }),
    ]);
    expect(info.servers.find((s) => s.name === "linear")?.repo).toBeUndefined();
    await you.call("tools.import", { names: ["linear"] });
    expect(mcpJson().linear).toMatchObject({ url: "https://mcp.linear.app/mcp" });
  });

  // Task 9's rule: Import reads your other agents' configs, which a chat shouldn't see.
  it("a chat's agent can't import", async () => {
    await start();
    const key = srv.grants.create({ kind: "run", projectId: "p", chatId: "c1", runId: "r1" }, "cli");
    const a = await connect({ port: srv.port, runKey: key });
    clients.push(a);
    for (const cmd of ["tools.importable", "tools.import", "tools.dismissImport"] as const)
      await expect(a.call(cmd, {})).rejects.toThrow("Only you can import");
    expect(mcpJson()).toEqual({});
  });
});
