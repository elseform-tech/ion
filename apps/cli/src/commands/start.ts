import type { Command } from "commander";
import { ionPaths } from "@ion/config";
import type { AgentStep, StartStatus } from "@ion/schema";
import { reach } from "../daemon-control.js";
import { NOT_RUNNING, type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

/** Steps 2 and 3, the same as the app's first run. */
const LATER = [
  "2. Pick a folder: ion projects add <folder>",
  '3. Ask: ion ask "What does this project do?" -p <project>',
];

/** One agent's row: ready, or the command that gets it there. */
function agentLine(a: AgentStep): string {
  if (a.state === "ready" || a.state === "checking") return `   ${a.label} · ${a.state}`;
  const what = a.state === "install" ? "install" : "sign in";
  const fix = a.command ? `${what}: ${clean(a.command)}` : what;
  return `   ${a.label} · ${fix}`;
}

/** The first steps (Plan 21), as commands: your agents, pick a folder, ask. */
function firstSteps(s: StartStatus): string {
  return ["Start here:", "1. Your agents:", ...s.agents.map(agentLine), ...LATER].join("\n");
}

/**
 * Bare `ion` (Plan 21: it printed 18 commands and exited 1): with nothing set up, the first steps as commands; ion
 * not running, how to start it first; else its help.
 */
export function startCommand(program: Command, out: () => Out) {
  // A root action would drop `ion help <command>`, and call `ion nope` too many arguments: both as before.
  program.helpCommand(true).allowExcessArguments(true);
  program.action(async () => {
    const [word] = program.args;
    if (word) program.error(`error: unknown command '${word}'`);
    const up = await reach(ionPaths().dataDir);
    if (!up) {
      print(out(), [NOT_RUNNING, "Then:", "1. Your agents: ion harnesses", ...LATER].join("\n"), {
        running: false,
      });
      return;
    }
    const s = await up.client.call("start.status", {}).finally(() => up.client.close());
    if (s.firstRun) return print(out(), firstSteps(s), s);
    program.outputHelp();
  });
}
