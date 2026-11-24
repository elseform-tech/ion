import { isTest, repoPath } from "./paths.js";

/** Tests (also .test.tsx) only use the words to check them. */
const isTestFile = (p) => isTest(p) || /\.test\.tsx$/.test(p);

/**
 * Words retired from the screens (Plan 21 Task 3, the word table in AGENTS.md): ion's own invented words, and two
 * words for one thing. Each with the word that replaces it.
 */
const RETIRED = [
  { word: /\bthreads?\b/i, use: "chat (a chat an ion started)" },
  { word: /\bharness(es)?\b/i, use: "agent" },
  { word: /\bion chief\b/i, use: "ion" },
  { word: /\bdream(s|ed|ing)?\b/i, use: "tidy (memory)" },
  { word: /\blearned from errors\b/i, use: "No usage info" },
  { word: /\bopen needs\b/i, use: "open questions" },
];

/** The screens' code: the desktop app and the CLI's output. */
const SCREENS = /^apps\/(desktop|cli)\/src\//;

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

/** No retired word on a screen: the desktop's strings and JSX text, and the CLI's. */
export default {
  meta: {
    type: "problem",
    messages: { retired: '"{{found}}" is retired from the screens: say {{use}} (AGENTS.md, Words).' },
    schema: [],
  },
  create(ctx) {
    const p = repoPath(ctx.filename);
    if (!SCREENS.test(p) || isTestFile(p)) return {};
    const check = (node, text, always) => {
      if (typeof text !== "string" || (!always && !isCopy(text)) || hiddenContext(node)) return;
      for (const r of RETIRED) {
        const m = text.match(r.word);
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
