import { describe, expect, it } from "vitest";
import { literalKey } from "./literal.js";
import { namedKey } from "./secretish.js";
import { shownArgs } from "./shown.js";

// Live check, 2026-11-28 (fix-hooks branch): `ion mcp add probe --command node --arg <scratch>/probe.mjs` and a hook
// running a script there were refused with "Put keys in Settings": a folder named from a path
// (`-Users-<name>-Documents-<project>`) and one named by a session id read as keys.
describe("a key typed into a command", () => {
  const scratch =
    "/private/var/folders/x/-Users-someone-Documents-ChatGPT-proj/0f3c2a1e-5b7d-4c9e-8a2f-1d3e5f7a9b0c";

  it("isn't an ordinary path: folders of words and dashes, or named by an id", () => {
    expect(literalKey({ command: "node", args: [`${scratch}/live/probe.mjs`] })).toBeNull();
    expect(literalKey({ run: `sh ${scratch}/live/hook.sh` })).toBeNull();
    expect(
      literalKey({ run: "sh /Users/someone/Projects/My-Big-Project_2026/scripts/check-before-tool.sh" }),
    ).toBeNull();
    expect(
      literalKey({ command: "/opt/homebrew/bin/node", args: ["/srv/Build.Release-Candidate.v2/run.js"] }),
    ).toBeNull();
  });

  it("still catches real-looking keys, alone or in a path, and KEY=value", () => {
    const keys = [
      { args: ["sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z"] },
      { args: ["--header", "ghp_0123456789abcdefABCDEF0123456789abcd"] },
      { run: ["curl -H x ", "xo", "xb-", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"].join("") },
      { args: ["AKIAIOSFODNN7EXAMPLE"] },
      {
        args: [
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ],
      },
      { args: ["/keys/Zx9Qw3Er7Ty1Ui5Op8As2Df6Gh4Jk0Lz/cert.pem"] },
      { run: "API_TOKEN=abc123 ./serve.sh" },
      { env: { API_KEY: "hunter2" } },
      { args: ["--api-key", "/etc/secret.txt"] },
    ];
    for (const k of keys) expect(literalKey(k), JSON.stringify(k)).toBe("Put keys in Settings");
  });
});

describe("what Settings shows of a server's arguments", () => {
  it("shows an ordinary path and still hides a key in one", () => {
    const path = "/private/var/folders/x/-Users-someone-Documents-ChatGPT-proj/live/probe.mjs";
    expect(shownArgs([path])).toEqual([path]);
    expect(
      shownArgs([
        "/keys/Zx9Qw3Er7Ty1Ui5Op8As2Df6Gh4Jk0Lz/cert.pem",
        "sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z",
      ]),
    ).toEqual(["…", "…"]);
  });
});

// Security review, 2026-11-28 (hooks fix, M2) and the automatic scan: sparing name-like path parts let some keys
// through: a UUID key or a word-joined token as a path's last part, glpat-/Stripe live tokens in a part, and a base64 key
// starting with "/" whose parts are short. Only folder parts of an ordinary path are spared; the rest is judged as
// strictly as before.
describe("keys in path-shaped words", () => {
  const uuid = "8f14e45f-ceea-467a-9575-0a1b2c3d4e5f";
  const caught = [
    `/x/${uuid}`,
    `--opt=/x/${uuid}`,
    uuid,
    "/x/glpat-AbcdefGhijklMnopqrSt",
    ["/x/sk_", "live_", "abcdefghijklmnopqrstuvwx"].join(""),
    "/AbCd12+GhIjKl/MnOp34Qr==",
  ];
  for (const v of caught)
    it(`catches ${v}`, () => {
      expect(literalKey({ command: "node", args: [v] }), "literalKey").toBe("Put keys in Settings");
      expect(namedKey("WHERE", v), "couldBeKey").toBe(true);
      expect(shownArgs([v]), "Settings").toEqual([v.startsWith("--opt=") ? "--opt=…" : "…"]);
    });

  it("hides a word-joined secret as a path's last part, and warns of it", () => {
    // Short of the 32 characters literalKey asks of a part, as before; Settings and the warning catch it.
    expect(namedKey("WHERE", "/x/Correct-Horse-Battery9")).toBe(true);
    expect(shownArgs(["/x/Correct-Horse-Battery9"])).toEqual(["…"]);
  });

  it("still lets the original path through", () => {
    const path =
      "/private/var/folders/claude-501/-Users-someone-Documents-ChatGPT-project/0f3c2a1e-5b7d-4c9e-8a2f-1d3e5f7a9b0c/scratchpad/live/probe.mjs";
    expect(literalKey({ command: "node", args: [path] })).toBeNull();
    expect(namedKey("WHERE", path)).toBe(false);
    expect(shownArgs([path])).toEqual([path]);
    expect(
      literalKey({ command: "/Users/someone/.nvm/versions/node/v22.11.0/bin/node", args: [] }),
    ).toBeNull();
  });
});

// Security re-review, 2026-11-28 (N7): a URL's path parts were judged without the prefixes keys use, so
// `--url https://h/x/glpat-<letters>` wasn't refused.
describe("a key in a URL's path", () => {
  it("is caught by its prefix", () => {
    expect(literalKey({ url: "https://h.example.com/x/glpat-AbcdefGhijklMnopqrSt" })).toBe(
      "Put keys in Settings",
    );
    expect(
      literalKey({ url: ["https://h.example.com/hooks/sk_", "live_", "abcdefghijklmnop"].join("") }),
    ).toBe("Put keys in Settings");
    expect(literalKey({ url: "https://h.example.com/mcp/v1" })).toBeNull();
  });
});
