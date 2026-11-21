import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Keys and tokens, in the OS keychain under service "ion" (never in config, the log or a process's arguments).
 * Accounts: `key:<NAME>` for a key you gave for `${NAME}` in mcp.json, `mcp:<server>:<origin hash>:oauth` for a
 * server's tokens.
 */
export type Secrets = {
  /** Null: no such item. Throws a KeychainError when the keychain can't be read (none, locked). */
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
};

export const NO_KEYCHAIN = "ion can't store keys on this computer";
export const KEYCHAIN_LOCKED = "Your keychain is locked";
/** What ion says when it can't check or keep what you turned on (its consent key is behind the keychain). */
export const CANT_READ_KEYCHAIN = "ion can't read your keychain";
const NOT_KEPT = "ion couldn't keep the key in the keychain";
const UNREADABLE = "ion couldn't read the keychain";
const TOO_LONG = "That key is too long for the keychain";
const MAC_LINE = 4095;

/** The keychain itself can't be used (none, locked, unreadable): not the same as a key that isn't there. */
export class KeychainError extends Error {}
const SERVICE = "ion";
const ACCOUNT = /^[\w.:-]{1,120}$/;

export const keyAccount = (server: string, name: string): string => `key:${server}:${name}`;
/** Where a server's tokens are kept: bound to the origin they're sent to, so they never follow it elsewhere. */
export function oauthAccount(server: string, url: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // Not a URL: bound to the text as it is.
  }
  return `mcp:${server}:${createHash("sha256").update(origin).digest("hex").slice(0, 12)}:oauth`;
}

/** Runs a keychain CLI: its exit code, stdout and stderr. Rejects with code ENOENT when it isn't installed. */
export type Run = (
  cmd: string,
  args: string[],
  input?: string,
) => Promise<{ code: number; out: string; err: string }>;

const TIMEOUT_MS = 10_000;

/** Starts the CLI; what it's given on stdin (a secret) never shows in `ps`. Its stderr is read, never logged. */
const runCli: Run = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], timeout: TIMEOUT_MS });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    p.stdin.on("error", () => {});
    p.stdin.end(input ?? "");
  });

const isMissing = (e: unknown) => (e as { code?: unknown }).code === "ENOENT";

function checked(account: string): string {
  if (!ACCOUNT.test(account)) throw new Error("That key name can't be used");
  return account;
}

type Result = { code: number; out: string; err: string };

/** The commands each keychain takes; `store` gets the secret on stdin. `found`/`stored` read the result. */
type Cli = {
  cmd: string;
  /** The value, null when there's no such item; throws a KeychainError when the keychain can't be used. */
  found(r: Result): string | null;
  /** Throws a KeychainError when it wasn't kept. */
  stored(r: Result): void;
  store(account: string, value: string): { args: string[]; input: string };
  find(account: string): string[];
  clear(account: string): string[];
};

// macOS: `security -i` reads its command from stdin, so the value (hex, -X) never appears in its arguments.
// security's exit code is the low byte of the error: 44 no such item, 36 locked (interaction not allowed).
const MAC: Cli = {
  cmd: "security",
  found: (r) => {
    if (r.code === 0) return r.out.replace(/\r?\n$/, "");
    if (r.code === 44) return null;
    throw new KeychainError(r.code === 36 ? KEYCHAIN_LOCKED : UNREADABLE);
  },
  stored: (r) => {
    if (r.code !== 0) throw new KeychainError(r.code === 36 ? KEYCHAIN_LOCKED : NOT_KEPT);
  },
  store: (a, v) => {
    const input = `add-generic-password -U -s ${SERVICE} -a "${a}" -X ${Buffer.from(v, "utf8").toString("hex")}\n`;
    // `security -i` cuts a line at 4,095 characters: a longer one would be kept cut short (Task review, 2026-11-20).
    if (input.length > MAC_LINE) throw new KeychainError(TOO_LONG);
    return { args: ["-i"], input };
  },
  find: (a) => ["find-generic-password", "-s", SERVICE, "-a", a, "-w"],
  clear: (a) => ["delete-generic-password", "-s", SERVICE, "-a", a],
};

// Linux (Secret Service): `secret-tool store` reads the secret from stdin.
// secret-tool says nothing and exits 1 when there's no such item; with no Secret Service it says why on stderr.
const LINUX: Cli = {
  cmd: "secret-tool",
  found: (r) => {
    if (r.code === 0) return r.out.replace(/\r?\n$/, "");
    if (!r.err.trim()) return null;
    throw new KeychainError(NO_KEYCHAIN);
  },
  stored: (r) => {
    if (r.code !== 0) throw new KeychainError(r.err.trim() ? NO_KEYCHAIN : NOT_KEPT);
  },
  store: (a, v) => ({
    args: ["store", `--label=${SERVICE} ${a}`, "service", SERVICE, "account", a],
    input: v,
  }),
  find: (a) => ["lookup", "service", SERVICE, "account", a],
  clear: (a) => ["clear", "service", SERVICE, "account", a],
};

const CLIS: Record<string, Cli> = { darwin: MAC, linux: LINUX };

/** The CLI's result; one that isn't installed is "no keychain". */
async function call(run: Run, cmd: string, args: string[], input?: string): Promise<Result> {
  try {
    return await run(cmd, args, input);
  } catch (e) {
    throw new KeychainError(isMissing(e) ? NO_KEYCHAIN : UNREADABLE);
  }
}

/** The computer's keychain; with none (no `security` / `secret-tool`, no Secret Service), it says so. */
export function systemSecrets(o: { platform?: string; run?: Run } = {}): Secrets {
  const cli = CLIS[o.platform ?? process.platform];
  const run = o.run ?? runCli;
  return {
    async get(account) {
      if (!cli) throw new KeychainError(NO_KEYCHAIN);
      return cli.found(await call(run, cli.cmd, cli.find(checked(account))));
    },
    async set(account, value) {
      if (!cli) throw new KeychainError(NO_KEYCHAIN);
      const { args, input } = cli.store(checked(account), value);
      cli.stored(await call(run, cli.cmd, args, input));
    },
    async remove(account) {
      if (!cli) return;
      await call(run, cli.cmd, cli.clear(checked(account))).catch(() => null);
    },
  };
}

/** Kept in memory only: for tests. */
export function memorySecrets(): Secrets & { all(): Map<string, string> } {
  const m = new Map<string, string>();
  return {
    get: async (a) => m.get(a) ?? null,
    set: async (a, v) => void m.set(a, v),
    remove: async (a) => void m.delete(a),
    all: () => m,
  };
}
