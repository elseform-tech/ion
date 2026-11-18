// Copies the design lab's app-window CSS into src/lab.css, verbatim. Run after changing the lab:
//   node packages/design-system/scripts/copy-lab.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../..");
const lines = readFileSync(join(root, "docs/design/ion-design-lab.html"), "utf8").split("\n");

// Line ranges in the lab (1-based, inclusive) that style the app window, with what they hold.
const RANGES = [
  [31, 35, "general (buttons, focus, icons, spinner)"],
  [47, 47, "window"],
  [48, 164, "window, rail, chats sidebar, chat, empty state, tools"],
  [305, 305, "empty lists"],
  [310, 330, "chips, project picker"],
  [361, 378, "project menu"],
  [516, 516, "count badge"],
  [521, 522, "starred project"],
  [549, 560, "pins, await (hidden), project menu search"],
  [571, 636, "media: code blocks"],
  [761, 831, "brain picker; work"],
];

const out = [
  "/*",
  "  The design lab's app window (docs/design/ion-design-lab.html), copied verbatim by scripts/copy-lab.mjs: every",
  "  rule below is the lab's, in the lab's order. Only the block at the end (\"app: not in the lab\") is ion's own.",
  "  Change the lab, then copy again.",
  "*/",
  "",
];
for (const [a, b, what] of RANGES) {
  out.push(`/* lab lines ${a}-${b}: ${what} */`);
  out.push(...lines.slice(a - 1, b).filter((l) => !l.startsWith(".scroller")));
  out.push("");
}
out.push(
  "/* app: not in the lab */",
  "/* The lab draws the app as a picture on a page; the app fills its own window. */",
  ".win{min-width:0;width:100vw;height:100vh;border-radius:0;border:0;box-shadow:none}",
  "/* The window's own red, yellow and green buttons sit in the rail's top strip (Tauri trafficLightPosition). */",
  ".lights:empty{height:11px}",
  "",
);
writeFileSync(join(import.meta.dirname, "../src/lab.css"), out.join("\n"));
