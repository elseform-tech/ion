import type { ApprovalRequest } from "@ion/adapter-kit";
import { commandParts, programsOf } from "./scripts.js";
import { commandText, unshell } from "./paths.js";

/** ion's own MCP variables (a run's keys and tokens in Claude Code's environment), named in a command. */
const ION_VARS = /\$\{?ION_MCP_/;
const ENVIRON = /\/proc\/[^\s]*\/environ\b/;

/** One program and the words after it (up to the next program): does it print an environment? */
function prints(name: string, args: string[], last: boolean): boolean {
  switch (name) {
    case "env":
      // env running a command (`env FOO=1 npm test`) is fine; on its own it prints everything.
      return last;
    case "printenv":
      return args.length === 0 || args.some((a) => a.startsWith("ION_"));
    case "export":
      return args.length === 0 || args.includes("-p");
    case "set":
      return args.length === 0;
    case "declare":
    case "typeset":
      return args.length === 0 || args.some((a) => /^-\w*[xp]/.test(a));
    case "ps":
      // BSD style `ps e`/`ps eww`, or `-E` (macOS): each process's environment.
      return args.some((a) => (a.startsWith("-") ? /^-\w*E/.test(a) : /^\w+$/.test(a) && a.includes("e")));
    default:
      return false;
  }
}

/**
 * A command that prints environments, where a run's MCP keys and tokens are: `env`/`printenv` alone, `export -p`,
 * `set` alone, `declare -x`, `ps e`/`ps eww`/`ps -E`, `/proc/<pid>/environ`, or one naming `$ION_MCP_*`.
 */
export function printsEnvironment(req: ApprovalRequest): boolean {
  const command = commandText(req);
  if (!command) return false;
  if (ION_VARS.test(command) || ENVIRON.test(unshell(command))) return true;
  return commandParts(command).some((words) => {
    const progs = programsOf(words);
    return progs.some((p, i) => {
      const end = progs[i + 1]?.at ?? words.length;
      return prints(p.name, words.slice(p.at + 1, end), i === progs.length - 1);
    });
  });
}
