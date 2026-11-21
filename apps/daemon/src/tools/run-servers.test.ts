import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { describe, expect, it, vi } from "vitest";
import { KEYCHAIN_LOCKED, KeychainError, keyAccount, memorySecrets } from "../secrets/index.js";
import { createTools } from "./index.js";
import { serversFor } from "./run-servers.js";

// The user, 2026-11-20: "adding new mcp required us to follow industry standard, meaning we have to consider mcp
// that might require oauth, api-key or some kind of login". Each chat's run gets the servers you turned on, filled
// in, with a fresh token for a remote one you signed in to; one it can't have is left out and said plainly.

type Status = "signed in" | "sign in again" | "sign in" | "can't reach" | null;

function setup(servers: Record<string, unknown>, o: { on?: string[]; status?: Record<string, Status> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ion-run-servers-"));
  const configFile = join(home, "config.toml");
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers }));
  const secrets = memorySecrets();
  const tools = createTools({ configFile, secrets });
  const tokens: Record<string, string | null> = {};
  const oauth = {
    status: vi.fn(async (id: string) => o.status?.[id] ?? null),
    freshToken: vi.fn(async (id: string) => tokens[id] ?? null),
  };
  const turnOn = async (...names: string[]) => {
    const all = tools.read().servers;
    const mcpOn = await Promise.all(
      names.map(async (n) => `${n}@${await tools.consent(all.find((s) => s.name === n)!)}`),
    );
    saveUserConfig(configFile, { ...DEFAULT_CONFIG, tools: { ...DEFAULT_CONFIG.tools, mcpOn } });
  };
  const get = serversFor({ tools, oauth, configFile });
  return { secrets, tools, tokens, oauth, turnOn, configFile, get };
}

const both = { label: "Fake", takes: { http: true } };

describe("serversFor", () => {
  it("gives the servers you turned on, with their keys filled in; new or changed ones stay off", async () => {
    const s = setup({
      docs: { command: "docs-mcp", args: ["--key", "${DOCS_KEY}"], env: { TOKEN: "${DOCS_KEY}" } },
      never: { command: "never-mcp" },
      changed: { command: "changed-mcp" },
    });
    await s.secrets.set(keyAccount("docs", "DOCS_KEY"), "k-123");
    await s.turnOn("docs", "changed");
    writeFileSync(
      join(s.configFile, "..", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: { command: "docs-mcp", args: ["--key", "${DOCS_KEY}"], env: { TOKEN: "${DOCS_KEY}" } },
          never: { command: "never-mcp" },
          changed: { command: "changed-mcp", args: ["--now-something-else"] },
        },
      }),
    );
    expect(await s.get(both)).toMatchObject({
      specs: [
        {
          name: "docs",
          transport: "stdio",
          command: "docs-mcp",
          args: ["--key", "k-123"],
          env: { TOKEN: "k-123" },
        },
      ],
      skipped: [],
    });
  });

  it("gives a remote server you signed in to a fresh token, and its own headers to one with a key", async () => {
    const s = setup(
      {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        keyed: { type: "http", url: "https://api.example.com/mcp", headers: { "X-Api-Key": "${EX_KEY}" } },
      },
      { status: { linear: "signed in" } },
    );
    await s.secrets.set(keyAccount("keyed", "EX_KEY"), "ex-1");
    s.tokens.linear = "tok-fresh";
    await s.turnOn("linear", "keyed");
    expect((await s.get(both)).specs).toEqual([
      {
        name: "linear",
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer tok-fresh" },
      },
      {
        name: "keyed",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "X-Api-Key": "ex-1" },
      },
    ]);
    // A server with its own key isn't asked about a sign-in.
    expect(s.oauth.status).not.toHaveBeenCalledWith("keyed", expect.anything());
  });

  // Review Focus 1: a token that can't be refreshed, a server never signed in to, or a missing key never fails the
  // run: the chat runs without that server, and says why in plain words.
  it("leaves out a server that needs a sign-in, a key, or can't be reached, and says why", async () => {
    const s = setup(
      {
        github: { type: "http", url: "https://api.githubcopilot.com/mcp" },
        notion: { type: "http", url: "https://mcp.notion.com/mcp" },
        sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
        stripe: { command: "stripe-mcp", env: { STRIPE_KEY: "${STRIPE_KEY}" } },
      },
      { status: { github: "sign in", notion: "sign in again", sentry: "signed in" } },
    );
    // sentry: signed in, but its token couldn't be refreshed (its sign-in can't be reached).
    await s.turnOn("github", "notion", "sentry", "stripe");
    expect(await s.get(both)).toMatchObject({
      specs: [],
      skipped: [
        { id: "github", text: "github isn't signed in, so this chat runs without it." },
        { id: "notion", text: "notion isn't signed in, so this chat runs without it." },
        { id: "sentry", text: "sentry can't be reached, so this chat runs without it." },
        { id: "stripe", text: "stripe needs a key, so this chat runs without it." },
      ],
    });
  });

  it("leaves out a server the agent can't take, and says so", async () => {
    const s = setup({
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
      docs: { command: "docs-mcp" },
    });
    await s.turnOn("linear", "docs");
    // The user, 2026-11-20 (ion as gateway, "In Plan 18 now"): a local server reaches the agent at ion's URL too,
    // so an agent without http takes neither.
    expect(await s.get({ label: "Grok Build", takes: { http: false } })).toMatchObject({
      specs: [],
      skipped: [
        { id: "linear", text: "Grok Build can't use linear, so this chat runs without it." },
        { id: "docs", text: "Grok Build can't use docs, so this chat runs without it." },
      ],
    });
  });

  // Task review, 2026-11-20: a locked or refused keychain read as "needs a key", which sends you to add one.
  it("says plainly when it can't read your keychain", async () => {
    const s = setup({ stripe: { command: "stripe-mcp", env: { STRIPE_KEY: "${STRIPE_TEST_KEY_T3}" } } });
    await s.turnOn("stripe");
    s.secrets.get = async () => {
      throw new KeychainError(KEYCHAIN_LOCKED);
    };
    expect((await s.get(both)).skipped).toEqual([
      { id: "stripe", text: "ion can't read your keychain for stripe, so this chat runs without it." },
    ]);
  });

  // Task review, 2026-11-20: any header stopped OAuth; only one holding a key (a `${NAME}`, or Authorization) does.
  it("signs in a remote server whose headers hold no key, keeping its headers", async () => {
    const s = setup(
      {
        linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Accept: "application/json" } },
        typed: {
          type: "http",
          url: "https://x.example.com/mcp",
          headers: { Authorization: "Bearer typed-key" },
        },
      },
      { status: { linear: "signed in", typed: "sign in" } },
    );
    s.tokens.linear = "tok-fresh";
    await s.turnOn("linear", "typed");
    expect((await s.get(both)).specs).toEqual([
      {
        name: "linear",
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Accept: "application/json", Authorization: "Bearer tok-fresh" },
      },
      {
        name: "typed",
        transport: "http",
        url: "https://x.example.com/mcp",
        headers: { Authorization: "Bearer typed-key" },
      },
    ]);
  });

  // Task review, 2026-11-20: the run redacts these from everything it stores.
  it("lists the run's keys and tokens, for the run to keep out of its history", async () => {
    const s = setup(
      {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        docs: { command: "docs-mcp", args: ["--key=${DOCS_KEY}"], env: { MODE: "production-x" } },
      },
      { status: { linear: "signed in" } },
    );
    await s.secrets.set(keyAccount("docs", "DOCS_KEY"), "k-1234567");
    s.tokens.linear = "tok-fresh-1";
    await s.turnOn("linear", "docs");
    expect((await s.get(both)).secrets).toEqual(
      expect.arrayContaining(["Bearer tok-fresh-1", "tok-fresh-1", "k-1234567", "production-x"]),
    );
  });
});
