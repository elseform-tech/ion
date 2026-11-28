import { isTest, repoPath } from "./paths.js";

/** Tests (also .test.tsx) only use the words to check them. */
const isTestFile = (p) => isTest(p) || /\.test\.tsx$/.test(p);

/**
 * Renames waiting for the user's OK (Plan 21 Task 3): "ion chief" → "ion", and "Dream" (the user's own word) → "Tidy
 * memory". To put one back, delete its line here (and its words on the screens).
 */
export const PENDING = [
  // --- awaiting the user's OK: begin ---
  { word: /\bion chief\b/i, use: "ion" },
  { word: /\bdream(s|ed|ing)?\b/i, use: "tidy (memory)" },
  // --- awaiting the user's OK: end ---
];

/**
 * Words retired from the screens (Plan 21 Task 3, the word table in AGENTS.md): ion's own invented words, and two
 * words for one thing. Each with the word that replaces it.
 */
export const RETIRED = [
  { word: /\bthreads?\b/i, use: "chat (a chat an ion started)" },
  { word: /\bharness(es)?\b/i, use: "agent" },
  ...PENDING,
  { word: /\blearned from errors\b/i, use: "No usage info" },
  { word: /\bopen needs\b/i, use: "open questions" },
];

/** The screens' code: the desktop app and the CLI's output. */
const SCREENS = /^apps\/(desktop|cli)\/src\//;

/**
 * The daemon's words that reach you (Plan 21 Task 4): in ions, ion's MCP server, its API and memory, the errors it
 * gives you (UserError), the reason it refuses a call, and its warnings. What it tells agents (tool descriptions, an
 * ion's instructions) names their parameters ("harness", "start_thread") and isn't checked.
 */
const DAEMON_COPY = /^apps\/daemon\/src\/(ions|mcp|api|memory)\//;

/**
 * Allowed in the daemon's words: a name in backticks (a tool's parameter, a command: "pass `harness`"), which is code,
 * not a word for you.
 */
const ALLOW = [/`[^`]*`/g];
const allowed = (text) => ALLOW.reduce((t, a) => t.replace(a, ""), text);

/** Is `node` (a string) an argument of `new UserError(…)` or `console.warn(…)`, or a refusal's `reason`? */
function daemonCopy(node) {
  let n = node;
  // A template's or a concatenation's parts belong to it.
  while (n.parent && (n.parent.type === "TemplateLiteral" || n.parent.type === "BinaryExpression"))
    n = n.parent;
  const p = n.parent;
  if (!p) return false;
  if (p.type === "NewExpression" && p.callee.type === "Identifier" && p.callee.name === "UserError")
    return true;
  if (p.type === "CallExpression" && p.callee.type === "MemberExpression") {
    const { object, property } = p.callee;
    return object.type === "Identifier" && object.name === "console" && property.name === "warn";
  }
  return p.type === "Property" && p.value === n && p.key.type === "Identifier" && p.key.name === "reason";
}

/**
 * Copy, not a code identifier: it has a space, or starts with a capital ("Hide thread", not "threads.list"). A flag's
 * own spelling ("--harness <id>", an old word kept hidden) is an identifier.
 */
const isCopy = (s) => !/^--?[a-z]/.test(s.trim()) && (/\s/.test(s.trim()) || /^[A-Z]/.test(s.trim()));

/** Attributes that never show (a class name, a test id, a key). */
const HIDDEN_ATTRS = new Set(["className", "key", "data-testid", "id", "htmlFor", "role", "type"]);

function hiddenContext(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration") return true;
  if (parent.type === "TSLiteralType" || parent.type === "TSExternalModuleReference") return true;
  if (parent.type === "Property" && parent.key === node) return true;
  if (parent.type === "JSXAttribute") return HIDDEN_ATTRS.has(parent.name.name);
  return false;
}

/** No retired word on a screen: the desktop's strings and JSX text, the CLI's, and the daemon's words to you. */
export default {
  meta: {
    type: "problem",
    messages: { retired: '"{{found}}" is retired from the screens: say {{use}} (AGENTS.md, Words).' },
    schema: [],
  },
  create(ctx) {
    const p = repoPath(ctx.filename);
    const daemon = DAEMON_COPY.test(p);
    if ((!SCREENS.test(p) && !daemon) || isTestFile(p)) return {};
    const check = (node, text, always) => {
      if (typeof text !== "string" || (!always && !isCopy(text)) || hiddenContext(node)) return;
      if (daemon && !daemonCopy(node)) return;
      const words = daemon ? allowed(text) : text;
      for (const r of RETIRED) {
        const m = words.match(r.word);
        if (m) ctx.report({ node, messageId: "retired", data: { found: m[0], use: r.use } });
      }
    };
    return {
      Literal: (node) => check(node, node.value, false),
      // A template reads as its text with each value as a number ("${n} runs" → "1 runs").
      TemplateLiteral: (node) => check(node, node.quasis.map((q) => q.value.cooked).join("1"), false),
      JSXText: (node) => check(node, node.value, true),
    };
  },
};
