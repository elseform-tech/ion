import { describe, expect, it } from "vitest";
import { loginPromptOf, runLogout, startLogin } from "./login.js";

/** A stand-in login: Node printing what a real agent's login prints, then exiting with `code` after `ms`. */
const script = (out: string, code = 0, ms = 50) => [
  "-e",
  `process.stdout.write(${JSON.stringify(out)}); setTimeout(() => process.exit(${code}), ${ms});`,
];

describe("an agent's own login", () => {
  // The user, 2026-11-23: a login that gives a URL shows it (Claude Code 2.1: OSC 8 link; Grok 1.0.92: device page
  // and code; Codex 0.153: a local server first, then the page).
  it("a login that gives a URL shows it", () => {
    const claude =
      "Opening browser to sign in…\nIf the browser didn't open, visit:\n\u001b]8;;https://claude.ai/oauth/authorize?x=1\u001b\\https://claude.ai/oauth/authorize?x=1\u001b]8;;\u001b\\\nPaste code here if prompted > ";
    expect(loginPromptOf(claude)).toEqual({ url: "https://claude.ai/oauth/authorize?x=1", code: null });
    const grok =
      "To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=AB12-CD34\n\nConfirm this code in your browser:\n\n  AB12-CD34\n\n\u001b[90mOnly continue with a code you requested.\u001b[0m\n";
    expect(loginPromptOf(grok)).toEqual({
      url: "https://accounts.x.ai/oauth2/device?user_code=AB12-CD34",
      code: "AB12-CD34",
    });
    const codex =
      "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&state=s\n";
    expect(loginPromptOf(codex).url).toBe(
      "https://auth.openai.com/oauth/authorize?response_type=code&state=s",
    );
  });

  it("starts the login, shows its page and code, and says when it ends signed in", async () => {
    const run = startLogin(
      process.execPath,
      script("Open https://example.test/device\n\n  WXYZ-1234\n", 0, 100),
      {
        signal: new AbortController().signal,
      },
    );
    expect(await run.prompt).toEqual({ url: "https://example.test/device", code: "WXYZ-1234" });
    expect(await run.done).toBe(true);
  });

  it("a login that fails or is stopped doesn't end signed in", async () => {
    expect(
      await startLogin(process.execPath, script("no\n", 1), { signal: new AbortController().signal }).done,
    ).toBe(false);
    const stop = new AbortController();
    const run = startLogin(process.execPath, script("https://example.test/a\n", 0, 60_000), {
      signal: stop.signal,
    });
    await run.prompt;
    stop.abort();
    expect(await run.done).toBe(false);
  });

  // The user, 2026-11-23: nothing secret is kept or shown. Only the page and the code leave a login's output.
  it("nothing secret is kept or shown", async () => {
    const out =
      "Signed in as someone@example.com (account 3f2a-99)\naccess_token=sk-live-SECRET\nhttps://example.test/ok\n";
    const run = startLogin(process.execPath, script(out), { signal: new AbortController().signal });
    const shown = JSON.stringify(await run.prompt);
    await run.done;
    expect(shown).not.toMatch(/someone|example\.com|3f2a|SECRET|token/);
    expect(JSON.parse(shown)).toEqual({ url: "https://example.test/ok", code: null });
  });

  it("a logout that fails says so", async () => {
    await expect(runLogout(process.execPath, ["-e", "process.exit(0)"])).resolves.toBeUndefined();
    await expect(runLogout(process.execPath, ["-e", "process.exit(2)"])).rejects.toThrow(
      "Sign-out didn't finish",
    );
  });

  // Review of #35, 2026-11-23: stopping a login stopped only the agent's own process; what it started (a browser
  // helper, a local server) could live on. It runs in its own process group, and the whole group is stopped.
  it("stopping a login ends what it started too", async () => {
    const helper = `require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })`;
    const body = `const c = ${helper}; process.stdout.write("https://example.test/p?pid=" + c.pid + "\\n"); setInterval(() => {}, 1000);`;
    const stop = new AbortController();
    const run = startLogin(process.execPath, ["-e", body], { signal: stop.signal });
    const pid = Number(new URL((await run.prompt).url!).searchParams.get("pid"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    stop.abort();
    expect(await run.done).toBe(false);
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 10_000);
});
