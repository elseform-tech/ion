import type { ApprovalRequest } from "@ion/adapter-kit";
import { commandText, type RuleCtx, strings, unshell, withoutText } from "./paths.js";
import { readScript, scriptsIn } from "./scripts.js";

/**
 * The keychain, where ion keeps your keys and tokens (Plan 18). Read by its verbs, not by how the program is
 * started: any word that is `security` or `secret-tool` (any folder) counts as a call, and is refused unless it is
 * plainly harmless. A word that only contains it (`fix(security):`) is not one.
 */
const KEYCHAIN_CLI = new Set(["security", "secret-tool"]);
/** security's commands that never reveal or change a key: listing, help, certificates. Everything else is refused. */
const HARMLESS = [
  "help",
  "error",
  "find-identity",
  "find-certificate",
  "verify-cert",
  "show-keychain-info",
  "list-keychains",
  "default-keychain",
];
/** Every security command (macOS), to tell a shortened one from a word that isn't one. */
const SECURITY_VERBS = [
  ...HARMLESS,
  "list-smartcards",
  "login-keychain",
  "create-keychain",
  "delete-keychain",
  "lock-keychain",
  "unlock-keychain",
  "set-keychain-settings",
  "set-keychain-password",
  "dump-keychain",
  "create-keypair",
  "add-generic-password",
  "add-internet-password",
  "add-certificates",
  "find-generic-password",
  "find-internet-password",
  "find-key",
  "delete-generic-password",
  "delete-internet-password",
  "delete-certificate",
  "delete-identity",
  "set-generic-password-partition-list",
  "set-internet-password-partition-list",
  "set-key-partition-list",
  "set-identity-preference",
  "get-identity-preference",
  "create-db",
  "export",
  "import",
  "cms",
  "install-mds",
  "add-trusted-cert",
  "remove-trusted-cert",
  "dump-trust-settings",
  "user-trust-settings-enable",
  "trust-settings-export",
  "trust-settings-import",
  "authorize",
  "authorizationdb",
  "execute-with-privileges",
  "leaks",
  "smartcards",
  "export-smartcard",
  "requirement-evaluate",
  "translocate-create",
  "translocate-policy-check",
  "translocate-status-check",
  "translocate-original-path",
];
/** Verbs no other program uses: named anywhere something runs (a script field, a Python script), they're the keychain. */
const OWN_VERBS = new Set([
  "find-generic-password",
  "find-internet-password",
  "add-generic-password",
  "add-internet-password",
  "delete-generic-password",
  "delete-internet-password",
  "dump-keychain",
  "unlock-keychain",
  "export-keychain",
  "set-keychain-settings",
]);
const SECRET_TOOL_VERBS = new Set(["lookup", "store", "clear", "search"]);

const tokensOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\w./-]+/)
    .filter(Boolean);

/** A keychain-only verb, or `secret-tool <verb>`, in any text. */
function namesKeychain(text: string): boolean {
  const t = tokensOf(text);
  return t.some(
    (w, i) => OWN_VERBS.has(w) || (w.endsWith("secret-tool") && SECRET_TOOL_VERBS.has(t[i + 1] ?? "")),
  );
}

/**
 * What a word after `security` asks for: "harmless" (an allowed command, or a prefix of exactly one and of no other),
 * "keys" (any other command, or a prefix that could be one), or "none" (not a command: security would refuse it).
 */
function verbKind(t: string | undefined): "harmless" | "keys" | "none" {
  if (t === undefined) return "none";
  const matches = SECURITY_VERBS.filter((v) => v.startsWith(t));
  if (matches.length === 0) return "none";
  return matches.length === 1 && HARMLESS.includes(matches[0]!) ? "harmless" : "keys";
}

const isCli = (t: string) => KEYCHAIN_CLI.has(t.split("/").pop() ?? "");

/**
 * One call of the CLI, fail closed: secret-tool, `-i`, a feed (`<`, a pipe, `-a` before it), no verb, a verb built
 * from an expansion, or any verb that isn't (a prefix of) exactly one harmless command is the keychain (security
 * review, 2026-11-21: it stays a refusal, never a guess).
 */
function callTouches(words: string[], at: number, text: string): boolean {
  if (words[at]!.split("/").pop() === "secret-tool") return true;
  const after = words.slice(at + 1);
  if (after.includes("-i") || /[<|]/.test(text) || words.slice(0, at).includes("-a")) return true;
  const verb = after.find((t) => !t.startsWith("-"));
  return verb === undefined || /[${}]/.test(verb) || verbKind(verb) !== "harmless";
}

const OPENERS = new Set(["<", ">", "(", "{", "!"]);
const CLOSERS = new Set([")", "}"]);
/** A word without the grouping marks at its ends: `{`, `(security`, `!(x`, `dump-keychain)`. */
function stripGrouping(word: string): string {
  let a = 0;
  let b = word.length;
  while (a < b && OPENERS.has(word[a]!)) a++;
  while (b > a && CLOSERS.has(word[b - 1]!)) b--;
  return word.slice(a, b);
}

/**
 * Shell text that uses the keychain: a keychain-only verb anywhere, or every word that is the CLI's name, wherever it
 * stands (after `do`, `then`, `time`, `doas`, any launcher), that callTouches. Fail closed: `echo security` is refused too.
 */
function runsKeychain(command: string): boolean {
  const text = unshell(command).toLowerCase();
  if (namesKeychain(text)) return true;
  // Split at separators and substitutions (`$(`, `<(`, `>(`); grouping marks are stripped from each word's ends, but
  // parens inside words stay: `fix(security)` isn't a call.
  const parts = text
    .split(/[;|&\n`]|[$<>]\(/)
    .map((p) => p.split(/\s+/).map(stripGrouping).filter(Boolean))
    .filter((w) => w.length > 0);
  return parts.some((words) => words.some((w, at) => isCli(w) && callTouches(words, at, text)));
}

/**
 * Another interpreter's script (Python, JS…): a keychain-only verb, or the CLI's name followed directly by `-i` or
 * a verb (`os.system('security -i < cmds')`); a variable named security is fine.
 */
function interpreterUsesKeychain(text: string): boolean {
  if (namesKeychain(text)) return true;
  const t = tokensOf(text);
  return t.some((w, i) => isCli(w) && (t[i + 1] === "-i" || verbKind(t[i + 1]) === "keys"));
}

/** A script the command runs, read from the worktree or the run's skills plugin: a shell script by rule, others by interpreterUsesKeychain. */
function scriptUsesKeychain(s: { file: string; shell: boolean }, c: RuleCtx): boolean {
  const text = readScript(s.file, c);
  if (text === null) return false;
  return s.shell ? runsKeychain(text) : interpreterUsesKeychain(text);
}

/** Where something runs (a command, a script it runs, a script field), not a file's text being written. */
export function touchesKeychain(req: ApprovalRequest, c: RuleCtx): boolean {
  const command = commandText(req);
  const others = Object.entries(withoutText(req).input).filter(([k]) => k !== "command");
  if ([...strings(Object.fromEntries(others))].some((v) => namesKeychain(unshell(v)))) return true;
  if (runsKeychain(command)) return true;
  return scriptsIn(command).some((s) => !s.unsure && scriptUsesKeychain(s, c));
}
