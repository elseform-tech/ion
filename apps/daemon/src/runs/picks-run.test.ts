import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import type { IonEvent } from "@ion/schema";
import { expect, it } from "vitest";
import { NeedsService } from "../needs/index.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { RunManager } from "./manager.js";

process.env.ION_ALLOW_FAKE = "1";

/** A project in a fresh git folder and a run manager whose "/" and "@" come from `picks`. */
function managerFor(picks: object) {
  const home = mkdtempSync(join(tmpdir(), "ion-picks-run-"));
  const repo = join(home, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const git = ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=T"];
  execFileSync("git", [...git, "add", "."]);
  execFileSync("git", [...git, "commit", "-q", "-m", "init"]);
  const configFile = join(home, "config.toml");
  saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
  const db = openDb(":memory:");
  const store = new EventStore(db, allViews);
  const ctx = { configFile, dataDir: join(home, "data"), picks: async () => picks };
  return { store, runs: new RunManager(store, ctx, new NeedsService(store, db), db) };
}

async function endOf(store: EventStore, runId: string): Promise<IonEvent[]> {
  for (let i = 0; i < 300; i++) {
    const events = store.read({ runId });
    if (events.some((e) => e.type === "run.finished")) return events;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

// The user, 2026-11-21: "/" picks a skill and "@" a server; the chat shows the chips, the agent gets them its way
// (the fake agent can't load skills: ion's skill's instructions come as context).
it("a picked skill reaches the run (Claude Code by name; others as context)", async () => {
  const pdf = {
    id: "~/ion/pdf",
    name: "pdf",
    description: "",
    whose: "ion",
    where: "~",
    on: true,
    support: {},
  };
  const bodyOf = (s: { name: string }) => (s.name === "pdf" ? "Fill forms with fill.py." : null);
  const servers = [{ name: "everything", on: true }];
  const { store, runs } = managerFor({
    skills: [{ ...pdf, hash: "h" }],
    bodyOf,
    commands: [],
    servers,
    own: [],
  });
  const args = {
    text: "echo hi",
    projectId: "repo",
    harness: "fake",
    skills: ["pdf", "x"],
    mentions: ["everything"],
  };
  const events = await endOf(store, (await runs.ask(args)).runId);
  expect(events[0]?.data).toEqual({ text: "echo hi", skills: ["pdf"], mentions: ["everything"] });
  const said = JSON.stringify(events.find((e) => e.type === "message.completed")?.data);
  for (const t of [
    "Use the pdf skill. Its instructions:",
    "fill.py",
    "Use the everything connection's tools.",
  ])
    expect(said).toContain(t);
});
