import { commandParts, programsOf, runsInput } from "./scripts.js";
import { unshell } from "./paths.js";

/** A run's key and its chat marker. */
const RUN_VAR = /^ION_(RUN_KEY|CHAT)$/;
/** Setting one (`ION_RUN_KEY=…`, alone, after `export`, or before a command). */
const SETS = /^ION_(RUN_KEY|CHAT)=/;
/** Words that mention a run's variable: a script that names one at all is refused (it can't be read like a shell). */
export const NAMES_RUN_VAR = /\bION_(RUN_KEY|CHAT)\b/;

/** env's options that take the next word (a folder, a PATH); `-S` splits its string into more of env's words. */
const ENV_TAKES = new Set(["-C", "--chdir", "-P"]);

/** drops: unsets a run's variable, or clears the whole environment (the key goes with it). */
type Does = "drops" | "takes" | "other";

/** What one of env's own options does: drops a run's variable (or all of them), takes the next word, or neither. */
function envOption(w: string, next: string | undefined): Does {
  // Clearing the environment drops the run's key with it (security review, 2026-11-21): a drop, not a guess.
  if (w === "-" || w === "-i" || w === "--ignore-environment") return "drops";
  if (ENV_TAKES.has(w)) return "takes";
  // `--split-string=<words>`: its first word is one of env's own (the shell's quotes are gone by now); `-S` and the
  // rest of its words follow as env's own.
  if (w.startsWith("--split-string=")) return envOption(w.slice(15), next);
  return unsetOption(w, next);
}

/** env's unsetting options (`-u NAME`, `--unset=NAME`, `-uNAME`, flags together): drops a run's variable, or not. */
function unsetOption(w: string, next: string | undefined): Does {
  if (w === "-u" || w === "--unset") return RUN_VAR.test(next ?? "") ? "drops" : "takes";
  if (w.startsWith("--unset=")) return RUN_VAR.test(w.slice(8)) ? "drops" : "other";
  // Short flags together (`-iv`, `-uION_CHAT`).
  if (!/^-[a-zA-Z]+$/.test(w)) return "other";
  if (w.includes("u") && RUN_VAR.test(w.slice(w.indexOf("u") + 1))) return "drops";
  return w.slice(1).includes("i") ? "drops" : "other";
}

/** env's own options before its command: whether they unset a run's variable or clear the environment. */
function envDrops(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    // Its command: what follows is that command's own.
    if (!w.startsWith("-") && !/^\w+=/.test(w)) return false;
    const does = w.startsWith("-") ? envOption(w, args[i + 1]) : "other";
    if (does === "drops") return true;
    if (does === "takes") i++;
  }
  return false;
}

/** Builtins that unset, overwrite or change a variable they name (`export -n`, `declare +x`, `read`, `printf -v`). */
function namesToChange(name: string, args: string[]): boolean {
  const named = args.some((a) => RUN_VAR.test(a));
  if (name === "unset" || name === "declare" || name === "typeset" || name === "read") return named;
  if (name === "export") return args.includes("-n") && named;
  if (name === "printf") return args.some((a, i) => a === "-v" && RUN_VAR.test(args[i + 1] ?? ""));
  return false;
}

/** A launcher that clears the environment before `ion` runs: `exec -c`, `sudo` without -E, `su`. */
function clearsBeforeIon(name: string, args: string[]): boolean {
  const ion = args.some((a) => a.split("/").pop() === "ion");
  if (!ion) return false;
  if (name === "exec") return args.some((a) => /^-[a-z]+$/.test(a) && a.includes("c"));
  if (name === "sudo") return !args.some((a) => a === "-E" || a.startsWith("--preserve-env"));
  return name === "su";
}

/** drops: drops or overrides a run's key or chat marker (env clearing all of it too). clears: a launcher before ion clears it. */
type Change = "drops" | "clears" | null;

/** One simple command's words: does it drop or override a run's key or chat marker, or clear the environment? */
function changeIn(words: string[]): Change {
  if (words.some((w) => SETS.test(w))) return "drops";
  let found: Change = null;
  // env's own options run up to its command (envDrops stops there); a builtin's names to the end of its command.
  for (const p of programsOf(words)) {
    const args = words.slice(p.at + 1);
    if (namesToChange(p.name, args) || (p.name === "env" && envDrops(args))) return "drops";
    if (clearsBeforeIon(p.name, args)) found = "clears";
  }
  return found;
}

/**
 * What a command does to a run's key or chat marker: drops or overrides one by name (`unset`, `ION_RUN_KEY=…`, `env
 * -u ION_CHAT`, `env -i`: refused), or a launcher before `ion` clears the environment (`sudo`, `exec -c`, `su`: a guess;
 * the user, 2026-11-21). Never a mere mention, nor env's ordinary use (Task review, 2026-11-21).
 */
export function runKeyChange(text: string): Change {
  const all = commandParts(text).map(changeIn);
  if (all.includes("drops")) return "drops";
  return all.includes("clears") ? "clears" : null;
}

/** Drops, overrides or clears away a run's key or chat marker. */
export const dropsRunKey = (text: string): boolean => runKeyChange(text) !== null;

const decodes = (stage: string) =>
  commandParts(stage).some((words) =>
    programsOf(words).some(
      (p) =>
        p.name === "base64" &&
        words.slice(p.at + 1).some((w) => w === "--decode" || (/^-[a-zA-Z]+$/.test(w) && /[dD]/.test(w))),
    ),
  );

/**
 * base64's decoded output run: fed through a pipe to a shell, an interpreter or xargs, or a substitution (whose text
 * is a command or a path). Decoding to a file or the screen is fine (Task review, 2026-11-21).
 */
export function runsDecoded(text: string): boolean {
  const t = unshell(text);
  const substituted = t
    .split(/\$\(|`/)
    .slice(1)
    .some((part) => decodes(part.split(/[)`]/)[0]!));
  if (substituted) return true;
  return t.split(/&&|\|\||;|\n/).some((pipeline) => {
    const stages = pipeline.split("|");
    const from = stages.findIndex(decodes);
    return (
      from >= 0 &&
      stages.slice(from + 1).some((s) => programsOf(s.trim().split(/\s+/)).some((p) => runsInput(p.name)))
    );
  });
}

/** ion's own folder by its variable: whatever it holds is ion's. */
export const namesIonHome = (text: string): boolean => /\$\{?ION_HOME\b/.test(text);
