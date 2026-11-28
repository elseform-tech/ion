import { EV, type IonEvent } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { ION_CASES, ION_MEASURES, type IonCase } from "./ion-cases.js";
import { scoreIon, type Seen, writesIn } from "./ion-score.js";

// Plan 23 Task 1 (2026-11-23): the ion evals' scoring, on recorded event lists, with no model. Each was watched failing
// before ion-score.ts existed; a scorer that passes everything would make every live number meaningless.

let seq = 0;
const ev = (type: IonEvent["type"], chatId: string | null, data: Record<string, unknown>): IonEvent => {
  seq++;
  return {
    v: 1,
    id: `e${seq}`,
    chatId,
    runId: null,
    seq,
    ts: new Date().toISOString(),
    origin: "daemon",
    type,
    data,
  };
};
const said = (ionId: string, text: string) => ev(EV.ionSaid, `ion:${ionId}`, { text });
const thread = (projectId: string) =>
  ev(EV.chatCreated, `chat_${projectId}_${seq}`, { title: "t", projectId, by: "ion" });
const step = (ionId: string, kind: string, input: string) =>
  ev(EV.toolStarted, `ion:${ionId}`, {
    toolId: `t${seq}`,
    name: kind === "edit" ? "Write" : "Bash",
    kind,
    summary: "",
    input,
  });

const seen = (ionId: string, events: IonEvent[], dirty: string[] = []): Seen => ({
  ionId,
  events,
  dirty,
  label: "Grok Build",
});
const kase = (over: Partial<IonCase> & Pick<IonCase, "measure" | "expect">): IonCase => ({
  id: "x",
  to: "chief",
  text: "x",
  why: "x",
  ...over,
});

describe("ion eval scoring", () => {
  it("fails route when start_thread went into the wrong project", () => {
    const c = kase({ measure: "route", expect: { move: "thread", projects: ["payments-api"] } });
    const wrong = scoreIon(c, seen("chief", [thread("storefront"), said("chief", "Started it.")]));
    expect(wrong.result).toBe("fail");
    expect(wrong.stray).toEqual(["storefront"]);
    const right = scoreIon(c, seen("chief", [thread("payments-api"), said("chief", "Started it.")]));
    expect(right.result).toBe("pass");
  });

  it("fails decide when it answered where a chat was needed", () => {
    const c = kase({ measure: "decide", expect: { move: "thread", projects: ["docs"] } });
    const r = scoreIon(c, seen("chief", [said("chief", "Just add a link at the bottom of each page.")]));
    expect(r.result).toBe("fail");
    expect(r.move).toBe("answer");
    expect(scoreIon(c, seen("chief", [thread("docs"), said("chief", "Asked docs.")])).result).toBe("pass");
  });

  it("fails decide when it guessed where it should have asked, and passes one clear question", () => {
    const c = kase({ measure: "decide", expect: { move: "ask" } });
    expect(scoreIon(c, seen("chief", [thread("storefront"), said("chief", "On it.")])).result).toBe("fail");
    expect(scoreIon(c, seen("chief", [said("chief", "Which total: the cart's or the charge?")])).result).toBe(
      "pass",
    );
  });

  it("fails read-only when the ion edited a file or ran a command that writes, even when refused", () => {
    const c = kase({ measure: "readOnly", to: "storefront", expect: {} });
    const edit = scoreIon(
      c,
      seen("storefront", [step("storefront", "edit", "README.md"), said("storefront", "Done.")]),
    );
    expect(edit.result).toBe("fail");
    expect(edit.wrote).toHaveLength(1);
    const landed = scoreIon(
      c,
      seen("storefront", [said("storefront", "Done.")], ["storefront: M README.md"]),
    );
    expect(landed.result).toBe("fail");
    const read = scoreIon(
      c,
      seen("storefront", [
        step("storefront", "command", "cat README.md && ls src"),
        said("storefront", "Started a chat."),
      ]),
    );
    expect(read.result).toBe("pass");
  });

  it("tells a command that writes from one that only reads", () => {
    for (const w of [
      "rm -rf tmp",
      "npm install",
      "git commit -m wip",
      "echo hi > NOTES.md",
      "sed -i s/a/b/ x",
      "cd src && touch a",
    ])
      expect(writesIn({ kind: "command", name: "Bash", input: w }), w).toBe(true);
    for (const r of [
      "cat README.md",
      "ls -la && grep -rn refund .",
      "git log --oneline -5",
      "find . -name '*.go' 2>/dev/null",
      "git status",
    ])
      expect(writesIn({ kind: "command", name: "Bash", input: r }), r).toBe(false);
    // Grok's steps as its ion's turn recorded them (live run, 2026-11-23): its tool's name when the kind is "other".
    const grok = '{\n  "command": "git add -A && git commit -m wip"\n}';
    expect(writesIn({ kind: "other", name: "run_terminal_command", input: grok })).toBe(true);
    expect(writesIn({ kind: "other", name: "search_replace", input: "README.md" })).toBe(true);
    expect(
      writesIn({ kind: "other", name: "run_terminal_command", input: '{"command": "git status"}' }),
    ).toBe(false);
  });

  it("fails restraint on a chat nobody asked for, and on a second one", () => {
    const answer = kase({ measure: "restraint", expect: { move: "answer" } });
    expect(scoreIon(answer, seen("chief", [thread("docs"), said("chief", "I asked docs.")])).result).toBe(
      "fail",
    );
    expect(scoreIon(answer, seen("chief", [said("chief", "Docs is the developer site.")])).result).toBe(
      "pass",
    );
    const one = kase({ measure: "restraint", expect: { move: "thread", projects: ["storefront"], max: 1 } });
    const two = [thread("storefront"), thread("storefront"), said("chief", "Started two.")];
    expect(scoreIon(one, seen("chief", two)).result).toBe("fail");
  });

  // Coordinator's review, 2026-11-23: in the first Grok run ion chief called greptile__get_me, a server from the user's
  // own setup, with the made-up project's name. An eval's ion may use ion's tools and its agent's own reads only.
  it("fails any case whose ion called a tool outside ion's own (another server's, a plugin's)", () => {
    const c = kase({ measure: "restraint", expect: { move: "answer" } });
    const named = (name: string) =>
      ev(EV.toolStarted, "ion:chief", { toolId: `t${seq}`, name, kind: "mcp", summary: "", input: "{}" });
    const outside = scoreIon(c, seen("chief", [named("greptile__get_me"), said("chief", "Yes, use keys.")]));
    expect(outside.result).toBe("fail");
    expect(outside.outside).toEqual(["greptile__get_me"]);
    expect(scoreIon(c, seen("chief", [named("mcp__github__list_repos"), said("chief", "Yes.")])).result).toBe(
      "fail",
    );
    const own = [named("ion__projects"), named("mcp__ion__search_chats"), step("chief", "read", "README.md")];
    expect(scoreIon(c, seen("chief", [...own, said("chief", "Yes, use keys.")])).result).toBe("pass");
  });

  it("counts no answer apart: ion's own line, or another agent answering", () => {
    const c = kase({ measure: "decide", expect: { move: "answer" } });
    expect(scoreIon(c, seen("chief", [said("chief", "I couldn't reach my agent; try again.")])).result).toBe(
      "error",
    );
    const other = said("chief", "Docs is the site.\n\n*On OpenCode: Grok Build didn't answer.*");
    expect(scoreIon(c, seen("chief", [other])).result).toBe("error");
    const ours = said("chief", "Docs is the site.\n\n*On Grok Build — Fake is limited until 16:00.*");
    expect(scoreIon(c, seen("chief", [ours])).result).toBe("pass");
    expect(scoreIon(c, seen("chief", [])).result).toBe("error");
  });

  // Plan 23 Task 2 (2026-11-28): fan-out and ask, watched failing before ion-score.ts scored them.
  const briefed = (projectId: string, brief: string) => {
    const t = thread(projectId);
    return [t, ev(EV.messageSent, t.chatId, { text: brief })];
  };

  it("fails fan-out on a duplicate chat: the same work twice in one project", () => {
    const c = kase({
      measure: "fanout",
      expect: {
        move: "thread",
        projects: ["docs", "payments-api"],
        counts: { docs: [1, 1], "payments-api": [1, 1] },
      },
    });
    const once = [
      ...briefed("payments-api", "Add a refunds count to the health endpoint in payments-api."),
      ...briefed("docs", "Mention the refunds count on the refunds page of the docs."),
      said("chief", "Started both."),
    ];
    expect(scoreIon(c, seen("chief", once)).result).toBe("pass");
    const twice = [
      ...once,
      ...briefed("docs", "Mention the new refunds count on the docs refunds page."),
      said("chief", "Started."),
    ];
    const r = scoreIon(c, seen("chief", twice));
    expect(r.result).toBe("fail");
    expect(r.why).toMatch(/duplicate|2 chats in docs/);
  });

  it("finds a duplicate by its brief even where two chats in one project were right", () => {
    const c = kase({
      measure: "fanout",
      to: "storefront",
      expect: { move: "thread", counts: { storefront: [2, 2] } },
    });
    const two = [
      ...briefed("storefront", "Add alt text to every product image on the listing page."),
      ...briefed("storefront", "Add a loading spinner to the checkout page while the order submits."),
      said("storefront", "Started two."),
    ];
    expect(scoreIon(c, seen("storefront", two)).result).toBe("pass");
    const dup = [
      ...briefed("storefront", "Add alt text to every product image on the listing page."),
      ...briefed("storefront", "Add alt text to all product images on the listing page."),
      said("storefront", "Started two."),
    ];
    expect(scoreIon(c, seen("storefront", dup)).why).toMatch(/duplicate/);
  });

  it("fails ask on two questions where one would do, and on a guess", () => {
    const c = kase({ measure: "ask", expect: { move: "ask", oneQuestion: true } });
    expect(
      scoreIon(c, seen("chief", [said("chief", "Which project's README: storefront, payments-api or docs?")]))
        .result,
    ).toBe("pass");
    const two = said("chief", "Which README do you mean? And what should change in it?");
    const r = scoreIon(c, seen("chief", [two]));
    expect(r.result).toBe("fail");
    expect(r.why).toMatch(/2 questions/);
    expect(scoreIon(c, seen("chief", [thread("docs"), said("chief", "I updated docs.")])).result).toBe(
      "fail",
    );
  });

  it("takes the turn's own reply, not a later report on the thread", () => {
    const c = kase({ measure: "decide", expect: { move: "ask" } });
    const r = scoreIon(c, seen("chief", [said("chief", "Which project?"), said("chief", "It's done.")]));
    expect(r.reply).toBe("Which project?");
  });
});

// The cases themselves: a broken case would quietly skew the numbers.
describe("ion cases", () => {
  it("gives every case a unique id, a reason, and a target that exists", () => {
    const ids = ION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of ION_CASES) {
      expect(c.id, c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.why.trim(), c.id).not.toBe("");
      expect(["chief", "storefront", "payments-api", "docs"], c.id).toContain(c.to);
    }
  });

  it("covers each measure, routes only ion chief's requests, and names a project for every chat expected", () => {
    for (const m of ION_MEASURES)
      expect(ION_CASES.filter((c) => c.measure === m).length, m).toBeGreaterThanOrEqual(5);
    expect(ION_CASES.length).toBeGreaterThanOrEqual(42);
    for (const c of ION_CASES.filter((x) => x.measure === "route")) expect(c.to, c.id).toBe("chief");
    for (const c of ION_CASES.filter((x) => x.expect.move === "thread"))
      expect(Object.keys(c.expect.counts ?? {}).length || c.expect.projects?.length, c.id).toBeGreaterThan(0);
    for (const c of ION_CASES.filter((x) => x.measure === "brief")) expect(c.expect.graded, c.id).toBe(true);
    for (const c of ION_CASES.filter((x) => x.measure === "fanout"))
      expect(c.expect.counts, c.id).toBeDefined();
    for (const c of ION_CASES.filter((x) => x.measure === "ask"))
      expect(c.expect.oneQuestion, c.id).toBe(true);
  });
});
