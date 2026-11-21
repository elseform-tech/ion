import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { loadUserConfig } from "@ion/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeychainError,
  keyAccount,
  memorySecrets,
  NO_KEYCHAIN,
  oauthAccount,
  type Secrets,
  systemSecrets,
} from "../secrets/index.js";
import { createTools } from "../tools/index.js";
import { startServer } from "./server.js";

/** Every file under `dir`, as text. */
const allText = (dir: string): string =>
  readdirSync(dir, { withFileTypes: true })
    .map((d) => (d.isDirectory() ? allText(join(dir, d.name)) : readFileSync(join(dir, d.name), "latin1")))
    .join("\n");

const noNetwork = {
  dns: () => Promise.reject(new Error("no network in tests")),
  send: () => Promise.reject(new Error("no network in tests")),
};

let home: string;
let srv: Awaited<ReturnType<typeof startServer>>;
let client: IonClient;

async function start(secrets: Secrets, servers: unknown = {}) {
  home = mkdtempSync(join(tmpdir(), "ion-home-"));
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  srv = await startServer({
    dataDir: join(home, "data"),
    configFile: join(home, "config.toml"),
    port: 0,
    secrets,
    // No network in tests: a remote server turned on is asked whether it needs a sign-in.
    net: noNetwork,
  });
  client = await connect({ port: srv.port, token: srv.token });
}

afterEach(async () => {
  client.close();
  await srv.close();
  vi.restoreAllMocks();
});

const SERVERS = {
  github: {
    command: "npx",
    args: ["gh-mcp", "--token=lit3ral"],
    env: { GITHUB_TOKEN: "${GH_KEY}", MODE: "lit3ral" },
  },
  linear: { url: "https://user:lit3ral@mcp.linear.app/mcp?key=lit3ral", headers: { "X-Api-Key": "lit3ral" } },
  ion: { command: "x" },
};

// Plan 18 (the user, 2026-11-20: "it is better to import custom mcp through a config file rather than on app, but
// there should be a way to access the config file"; "adding new mcp required us to follow industry standard").
describe("tools", () => {
  it("lists servers from mcp.json with names, never values, and where the file is", async () => {
    await start(memorySecrets(), SERVERS);
    const info = await client.call("tools.list", {});
    expect(info.mcpFile).toBe(join(home, "mcp.json"));
    expect(info.mcpProblem).toBeUndefined();
    expect(info.leftOut).toEqual([{ name: "ion", why: "ion is ion's own server" }]);
    expect(info.mcp).toEqual([
      {
        ...{ id: "github", name: "github", on: false, new: true, auth: "apiKey", transport: "stdio" },
        ...{
          command: "npx",
          args: ["gh-mcp", "--token=…"],
          keyEnv: "GITHUB_TOKEN",
          env: ["GITHUB_TOKEN", "MODE"],
        },
        ...{ keys: ["GH_KEY"], signedIn: false, needs: "key", missing: ["GH_KEY"] },
      },
      {
        ...{ id: "linear", name: "linear", on: false, new: true, auth: "apiKey", transport: "http" },
        ...{
          url: "mcp.linear.app",
          keys: [],
          keyHeader: "X-Api-Key",
          headers: ["X-Api-Key"],
          signedIn: true,
        },
      },
    ]);
    expect(JSON.stringify(info)).not.toContain("lit3ral");
    expect(info.support["claude-code"]).toEqual({ http: true, stdio: true, skills: true });
  });

  it("shows a broken file plainly and keeps the last good list", async () => {
    await start(memorySecrets(), { a: { command: "x" } });
    await client.call("tools.list", {});
    writeFileSync(join(home, "mcp.json"), '{ "mcpServers": { "a": { "command": "x" } ');
    const info = await client.call("tools.list", {});
    expect(info.mcp.map((m) => m.id)).toEqual(["a"]);
    expect(info.mcpProblem).toMatch(/^mcp\.json: .+/);
  });

  // The user, 2026-11-20: a new server starts off until you turn it on.
  it("a new server starts off; turning it on sticks, in ion's config, never in mcp.json", async () => {
    await start(memorySecrets(), { a: { command: "x" } });
    const before = readFileSync(join(home, "mcp.json"), "utf8");
    expect((await client.call("tools.list", {})).mcp[0]).toMatchObject({ on: false, new: true });
    const on = await client.call("tools.setOn", { kind: "mcp", id: "a", on: true });
    expect(on.mcp[0]?.on).toBe(true);
    expect(on.mcp[0]?.new).toBeUndefined();
    expect(loadUserConfig(join(home, "config.toml")).config.tools.mcpOn).toEqual([
      expect.stringMatching(/^a@[0-9a-f]{32}$/),
    ]);
    expect(readFileSync(join(home, "mcp.json"), "utf8")).toBe(before);
    expect((await client.call("tools.list", {})).mcp[0]?.on).toBe(true);
    expect((await client.call("tools.setOn", { kind: "mcp", id: "a", on: false })).mcp[0]?.on).toBe(false);
    expect(loadUserConfig(join(home, "config.toml")).config.tools.mcpOn).toEqual([]);
    await expect(client.call("tools.setOn", { kind: "mcp", id: "nope", on: true })).rejects.toThrow(
      "Unknown connection: nope",
    );
  });

  // The user, 2026-11-20: a new server starts off until you turn it on — and one that now runs something else too.
  it("changing a server's command, or where it connects, turns it off again", async () => {
    await start(memorySecrets(), { a: { command: "x" }, r: { url: "https://a.example/mcp" } });
    await client.call("tools.setOn", { kind: "mcp", id: "a", on: true });
    await client.call("tools.setOn", { kind: "mcp", id: "r", on: true });
    writeFileSync(
      join(home, "mcp.json"),
      JSON.stringify({
        mcpServers: { a: { command: "x", args: ["--evil"] }, r: { url: "https://a.example/other" } },
      }),
    );
    let info = await client.call("tools.list", {});
    expect(info.mcp[0]).toMatchObject({ id: "a", on: false, changed: true });
    // The URL as written counts whole (Task review, 2026-11-20).
    expect(info.mcp[1]).toMatchObject({ id: "r", on: false, changed: true });
    writeFileSync(
      join(home, "mcp.json"),
      JSON.stringify({ mcpServers: { r: { url: "https://b.example/mcp" } } }),
    );
    info = await client.call("tools.list", {});
    expect(info.mcp[0]).toMatchObject({ id: "r", on: false, changed: true });
  });

  // Task review, 2026-11-20: consent is for everything it runs with: an env variable (NODE_OPTIONS) or a header
  // added to a server you turned on turns it off; so does a new path on its URL.
  it("adding env, a header or another URL to a server you turned on turns it off", async () => {
    await start(memorySecrets(), { a: { command: "x" }, r: { url: "https://a.example/mcp" } });
    await client.call("tools.setOn", { kind: "mcp", id: "a", on: true });
    await client.call("tools.setOn", { kind: "mcp", id: "r", on: true });
    const servers = {
      a: { command: "x", env: { NODE_OPTIONS: "--require /tmp/evil.js" } },
      r: { url: "https://a.example/mcp", headers: { "X-Forward": "evil" } },
    };
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    const info = await client.call("tools.list", {});
    expect(info.mcp.map((m) => [m.id, m.on, m.changed])).toEqual([
      ["a", false, true],
      ["r", false, true],
    ]);
  });

  // Task review, 2026-11-21: anything that can write config.toml could write a consent record for a server.
  it("a hand-written consent entry for a new server doesn't turn it on; one turned on in the app survives a restart", async () => {
    const secrets = memorySecrets();
    await start(secrets, { a: { command: "x" }, b: { command: "y" } });
    const unkeyed = createHash("sha256")
      .update(JSON.stringify(["x", [], {}]))
      .digest("hex")
      .slice(0, 12);
    writeFileSync(join(home, "config.toml"), `[tools]\nmcpOn = ["a@${unkeyed}"]\n`);
    expect((await client.call("tools.list", {})).mcp[0]).toMatchObject({ id: "a", on: false });
    await client.call("tools.setOn", { kind: "mcp", id: "b", on: true });
    client.close();
    await srv.close();
    srv = await startServer({
      dataDir: join(home, "data"),
      configFile: join(home, "config.toml"),
      port: 0,
      secrets,
    });
    client = await connect({ port: srv.port, token: srv.token });
    expect((await client.call("tools.list", {})).mcp.map((m) => [m.id, m.on])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  // Task review, 2026-11-20: the app showed only the missing ${NAME}s; it shows each one a server uses.
  it("names every key a server uses", async () => {
    await start(memorySecrets(), { a: { command: "x", env: { A: "${A_KEY}", B: "${B_KEY:-x}" } } });
    expect((await client.call("tools.list", {})).mcp[0]).toMatchObject({
      keys: ["A_KEY", "B_KEY"],
      missing: ["A_KEY"],
    });
  });

  // Task review, 2026-11-20: a key typed into an mcp.json others can read.
  it("says when others on this computer can read mcp.json with a key in it", async () => {
    await start(memorySecrets(), { a: { command: "x", env: { TOKEN: "typed-in" } } });
    chmodSync(join(home, "mcp.json"), 0o644);
    const info = await client.call("tools.list", {});
    expect(info.mcpProblem).toBe("mcp.json can be read by other users on this computer");
  });

  // Task review, 2026-11-20: a locked keychain read as "Add key".
  it("a keychain that can't be read isn't a missing key", async () => {
    const locked: Secrets = {
      get: async () => {
        throw new KeychainError("Your keychain is locked");
      },
      set: async () => {
        throw new KeychainError("Your keychain is locked");
      },
      remove: async () => {},
    };
    await start(locked, { a: { command: "x", env: { A: "${A_KEY}" } } });
    const info = await client.call("tools.list", {});
    expect(info.keychainProblem).toBe("Your keychain is locked");
    expect(info.mcp[0]).toMatchObject({ signedIn: false, keys: ["A_KEY"] });
    expect(info.mcp[0]?.needs).toBeUndefined();
  });

  // Task review, 2026-11-21: turning a server off must drop its consent mark (a mark left behind could be reused).
  it("a server turned off loses its consent mark", async () => {
    await start(memorySecrets(), { a: { command: "x" } });
    await client.call("tools.setOn", { kind: "mcp", id: "a", on: true });
    const was = loadUserConfig(join(home, "config.toml")).config.tools.mcpOn;
    await client.call("tools.setOn", { kind: "mcp", id: "a", on: false });
    expect(loadUserConfig(join(home, "config.toml")).config.tools.mcpOn).toEqual([]);
    expect(was).toHaveLength(1);
  });

  // Task review, 2026-11-21: with a server turned on, a locked keychain broke Tools (its consent couldn't be checked)
  // and turning one on showed the keychain's raw error.
  it("a locked keychain with a server turned on still shows Tools, the server off, and says so plainly", async () => {
    const locked: Secrets = {
      get: async () => {
        throw new KeychainError("Your keychain is locked");
      },
      set: async () => {
        throw new KeychainError("Your keychain is locked");
      },
      remove: async () => {},
    };
    await start(locked, { a: { command: "x" }, b: { command: "y" } });
    writeFileSync(join(home, "config.toml"), `[tools]\nmcpOn = ["a@0123456789abcdef0123456789abcdef"]\n`);
    const info = await client.call("tools.list", {});
    expect(info.mcp.map((m) => [m.id, m.on])).toEqual([
      ["a", false],
      ["b", false],
    ]);
    expect(info.keychainProblem).toBe("ion can't read your keychain");
    await expect(client.call("tools.setOn", { kind: "mcp", id: "b", on: true })).rejects.toThrow(
      /^ion can't read your keychain$/,
    );
  });

  // Security review, 2026-11-20: ${ION_…} are ion's own; no key for one is kept.
  it("refuses a key for a name starting with ION_", async () => {
    await start(memorySecrets(), { a: { command: "x", env: { T: "${ION_TOKEN}" } } });
    await expect(client.call("tools.setKey", { id: "a", name: "ION_TOKEN", key: "k" })).rejects.toThrow(
      "ION_ names are ion's own",
    );
  });

  // Review Focus 2: a pasted key appears nowhere it shouldn't.
  it("a pasted key goes to the keychain, never to config.toml or the log", async () => {
    const secrets = memorySecrets();
    await start(secrets, SERVERS);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const info = await client.call("tools.setKey", {
      id: "github",
      name: "GH_KEY",
      key: "  sk-pasted-123  ",
    });
    expect(info.mcp[0]).toMatchObject({ id: "github", signedIn: true });
    expect(info.mcp[0]?.needs).toBeUndefined();
    expect(secrets.all().get(keyAccount("github", "GH_KEY"))).toBe("sk-pasted-123");
    await expect(
      client.call("tools.setKey", { id: "github", name: "NOT_USED", key: "sk-pasted-123" }),
    ).rejects.toThrow("github doesn't use ${NOT_USED}");
    await expect(
      client.call("tools.setKey", { id: "github", name: "GH_KEY", key: "sk-pasted\n123" }),
    ).rejects.toThrow(/^(?!.*sk-pasted).*$/);
    await client.call("tools.list", {});
    await srv.close();
    // Restarted: the event log is written through and read whole below.
    srv = await startServer({
      dataDir: join(home, "data"),
      configFile: join(home, "config.toml"),
      port: 0,
      secrets,
    });
    expect(allText(home)).not.toContain("sk-pasted");
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("sk-pasted");
  });

  // Task review, 2026-11-21 (automated review): keys were kept by name, so a key you gave one server went to every
  // server that names the same ${NAME}. A key belongs to its server; an old by-name item is ignored.
  it("a key belongs to its server, and an old by-name key is ignored", async () => {
    const secrets = memorySecrets();
    await secrets.set("key:SHARED_KEY", "old-shared-1");
    await start(secrets, {
      a: { command: "a-mcp", env: { T: "${SHARED_KEY}" } },
      b: { command: "b-mcp", env: { T: "${SHARED_KEY}" } },
    });
    const needs = (i: { mcp: { id: string; needs?: string }[] }) => i.mcp.map((m) => [m.id, m.needs]);
    expect(needs(await client.call("tools.list", {}))).toEqual([
      ["a", "key"],
      ["b", "key"],
    ]);
    const info = await client.call("tools.setKey", { id: "a", name: "SHARED_KEY", key: "a-key-123" });
    expect(needs(info)).toEqual([
      ["a", undefined],
      ["b", "key"],
    ]);
    expect(secrets.all().get("key:a:SHARED_KEY")).toBe("a-key-123");
    await expect(client.call("tools.setKey", { id: "nope", name: "SHARED_KEY", key: "k" })).rejects.toThrow(
      "Unknown connection: nope",
    );
  });

  it("no keychain: signing in is refused plainly", async () => {
    await start(systemSecrets({ platform: "win32" }), SERVERS);
    await expect(client.call("tools.setKey", { id: "github", name: "GH_KEY", key: "k" })).rejects.toThrow(
      NO_KEYCHAIN,
    );
  });

  it("a server removed from the file loses its sign-in", async () => {
    const secrets = memorySecrets();
    await start(secrets, { linear: { url: "https://mcp.linear.app/mcp" }, b: { command: "x" } });
    await client.call("tools.list", {});
    const account = oauthAccount("linear", "https://mcp.linear.app/mcp");
    await secrets.set(account, "tok");
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { b: { command: "x" } } }));
    await client.call("tools.list", {});
    await vi.waitFor(async () => expect(await secrets.get(account)).toBeNull());
  });

  // Security review, 2026-11-20: the map that dropped a moved server's token lived in memory, so a URL changed
  // while ion was stopped kept the old token. A token is bound to its origin: a new host finds none.
  it("a server moved to another host while ion was stopped finds no token", async () => {
    const secrets = memorySecrets();
    await start(secrets, { linear: { url: "https://a.example/mcp" } });
    const tools = createTools({ configFile: join(home, "config.toml"), secrets });
    const [a] = tools.read().servers;
    await secrets.set(await tools.tokenAccount(a!), "tok");
    await srv.close();
    writeFileSync(
      join(home, "mcp.json"),
      JSON.stringify({ mcpServers: { linear: { url: "https://b.example/mcp" } } }),
    );
    const after = createTools({ configFile: join(home, "config.toml"), secrets });
    const [b] = after.read().servers;
    expect(await secrets.get(await after.tokenAccount(b!))).toBeNull();
    srv = await startServer({
      dataDir: join(home, "data"),
      configFile: join(home, "config.toml"),
      port: 0,
      secrets,
    });
  });
});
