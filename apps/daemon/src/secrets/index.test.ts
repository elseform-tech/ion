import { describe, expect, it } from "vitest";
import {
  KEYCHAIN_LOCKED,
  keyAccount,
  memorySecrets,
  NO_KEYCHAIN,
  oauthAccount,
  type Run,
  systemSecrets,
} from "./index.js";

type Call = { cmd: string; args: string[]; input?: string };

/** A keychain CLI that records each call and answers from `answer`. */
function fakeRun(answer: (c: Call) => { code: number; out: string; err?: string }): {
  run: Run;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: Run = async (cmd, args, input) => {
    const call = { cmd, args, ...(input === undefined ? {} : { input }) };
    calls.push(call);
    return { err: "", ...answer(call) };
  };
  return { run, calls };
}

const missing: Run = async () => {
  throw Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
};

// Plan 18 (the user, 2026-11-20: connections that need "oauth, api-key or some kind of login"): keys and tokens live
// in the OS keychain under service "ion", never in ion's config, the log or a process's arguments.
describe("secrets", () => {
  it("names accounts by what they hold", () => {
    expect(keyAccount("github", "GITHUB_TOKEN")).toBe("key:github:GITHUB_TOKEN");
    // Security review, 2026-11-20: a token is bound to where it goes (the URL's origin), so a server renamed or
    // pointed elsewhere while ion was stopped finds no token.
    const a = oauthAccount("linear", "https://mcp.linear.app/mcp");
    expect(a).toMatch(/^mcp:linear:[0-9a-f]{12}:oauth$/);
    expect(oauthAccount("linear", "https://mcp.linear.app/other?x=1")).toBe(a);
    expect(oauthAccount("linear", "https://evil.example/mcp")).not.toBe(a);
  });

  it("keeps them in memory for tests", async () => {
    const s = memorySecrets();
    expect(await s.get("key:A")).toBeNull();
    await s.set("key:A", "v");
    expect(await s.get("key:A")).toBe("v");
    await s.remove("key:A");
    expect(await s.get("key:A")).toBeNull();
  });

  it("on macOS, stores through security's stdin, never its arguments", async () => {
    const { run, calls } = fakeRun((c) => ({ code: 0, out: c.args.includes("-w") ? "s3cret" : "" }));
    const s = systemSecrets({ platform: "darwin", run });
    await s.set("key:A", 's3cret "x"');
    expect(calls[0]!.cmd).toBe("security");
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(JSON.stringify(calls[0]!.args)).not.toContain("s3cret");
    const hex = Buffer.from('s3cret "x"').toString("hex");
    expect(calls[0]!.input).toBe(`add-generic-password -U -s ion -a "key:A" -X ${hex}\n`);
    expect(await s.get("key:A")).toBe("s3cret");
    expect(calls[1]!.args).toEqual(["find-generic-password", "-s", "ion", "-a", "key:A", "-w"]);
    await s.remove("key:A");
    expect(calls[2]!.args).toEqual(["delete-generic-password", "-s", "ion", "-a", "key:A"]);
  });

  it("on macOS, an item that isn't there is null, and removing it is fine", async () => {
    const { run } = fakeRun(() => ({ code: 44, out: "" }));
    const s = systemSecrets({ platform: "darwin", run });
    expect(await s.get("key:A")).toBeNull();
    await expect(s.remove("key:A")).resolves.toBeUndefined();
  });

  it("on Linux, stores through secret-tool's stdin", async () => {
    const { run, calls } = fakeRun(() => ({ code: 0, out: "tok" }));
    const s = systemSecrets({ platform: "linux", run });
    await s.set("mcp:linear:oauth", "tok");
    expect(calls[0]).toEqual({
      cmd: "secret-tool",
      args: ["store", "--label=ion mcp:linear:oauth", "service", "ion", "account", "mcp:linear:oauth"],
      input: "tok",
    });
    expect(await s.get("mcp:linear:oauth")).toBe("tok");
    expect(calls[1]!.args).toEqual(["lookup", "service", "ion", "account", "mcp:linear:oauth"]);
    await s.remove("mcp:linear:oauth");
    expect(calls[2]!.args).toEqual(["clear", "service", "ion", "account", "mcp:linear:oauth"]);
  });

  // Task review, 2026-11-20: no keychain (or a locked one) read as "no such key", so the app asked for a key it
  // couldn't keep. Reading says which.
  it("no keychain: storing is refused plainly, and reading says so", async () => {
    for (const s of [
      systemSecrets({ platform: "linux", run: missing }),
      systemSecrets({ platform: "win32" }),
    ]) {
      await expect(s.set("key:A", "v")).rejects.toThrow(NO_KEYCHAIN);
      await expect(s.get("key:A")).rejects.toThrow(NO_KEYCHAIN);
    }
    expect(NO_KEYCHAIN).toBe("ion can't store keys on this computer");
  });

  it("a failed store says so without the value", async () => {
    const { run } = fakeRun(() => ({ code: 1, out: "boom s3cret" }));
    const err = await systemSecrets({ platform: "darwin", run })
      .set("key:A", "s3cret")
      .catch((e: Error) => e);
    expect(String(err)).toContain("couldn't keep the key");
    expect(String(err)).not.toContain("s3cret");
  });

  it("refuses an account name that isn't plain", async () => {
    const s = systemSecrets({ platform: "darwin", run: fakeRun(() => ({ code: 0, out: "" })).run });
    await expect(s.set('key:A" -X 00', "v")).rejects.toThrow();
  });

  // Task review, 2026-11-20: a locked keychain, or Linux with no Secret Service, must not read as a missing key.
  it("tells a locked keychain or no Secret Service from a key that isn't there", async () => {
    const locked = systemSecrets({ platform: "darwin", run: fakeRun(() => ({ code: 36, out: "" })).run });
    await expect(locked.get("key:A")).rejects.toThrow(KEYCHAIN_LOCKED);
    await expect(locked.set("key:A", "v")).rejects.toThrow(KEYCHAIN_LOCKED);
    const absent = systemSecrets({ platform: "linux", run: fakeRun(() => ({ code: 1, out: "" })).run });
    expect(await absent.get("key:A")).toBeNull();
    const noService = fakeRun(() => ({
      code: 1,
      out: "",
      err: "secret-tool: Cannot autolaunch D-Bus without X11",
    }));
    const linux = systemSecrets({ platform: "linux", run: noService.run });
    await expect(linux.get("key:A")).rejects.toThrow(NO_KEYCHAIN);
    await expect(linux.set("key:A", "v")).rejects.toThrow(NO_KEYCHAIN);
  });
});
