// Copies the design lab's app-window CSS into src/lab.css, verbatim. Run after changing the lab:
//   node packages/design-system/scripts/copy-lab.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../..");
const lines = readFileSync(join(root, "docs/design/ion-design-lab.html"), "utf8").split("\n");

// Line ranges in the lab (1-based, inclusive) that style the app window, with what they hold.
const RANGES = [
  [31, 35, "general (buttons, focus, icons, spinner)"],
  [40, 41, "brand wordmark"],
  [47, 47, "window"],
  [48, 164, "window, rail, chats sidebar, chat, empty state, tools"],
  [165, 202, "ions: panel, ion chat, bubbles, thread links, quick replies"],
  [209, 264, "settings: nav, groups, rows, switches, ion page, agent and colour pickers"],
  [267, 283, "ions: new-ion card, notes"],
  [293, 293, "keys (kbd)"],
  [305, 305, "empty lists"],
  [310, 330, "chips, project picker"],
  [331, 360, "activity: its row, upcoming and recent runs, pause all"],
  [361, 378, "project menu"],
  [396, 397, "form fields"],
  [400, 400, "field labels"],
  [404, 407, "segmented control"],
  [411, 411, "disabled button"],
  [456, 463, "ions: ion chief tile"],
  [478, 484, "ions: route card"],
  [503, 515, "ions: scalable panel rows"],
  [516, 516, "count badge"],
  [517, 520, "ions: star"],
  [521, 522, "starred project"],
  [530, 548, "ions: needs pinned atop ion chief"],
  [549, 560, "pins, await (hidden), project menu search"],
  [567, 568, "notification icons; segmented control, small"],
  [571, 636, "media: code blocks"],
  [685, 699, "panel: in this chat (.inchat), its label (.lh2), media rows (.mrow); tasks"],
  [722, 733, "ions: needs strip, collapsed"],
  [770, 840, "brain picker; work"],
  [841, 860, "ions: suggestion cards"],
  [870, 870, "settings: effort bars in a value"],
  [899, 900, "settings: ion's model slots"],
  [905, 905, "settings: model separator"],
  [911, 937, "settings: tools rows, agents' status, stacked rows; Tools tabs, events and their hooks, menus"],
  [1006, 1006, "activity: rows"],
  [1069, 1086, "ions: project ion rows, a thread open beside its ion's chat; routines' instructions"],
  [1092, 1097, "the frame: the top strip, each screen inside it; the sidebar hidden"],
  [1098, 1104, "queued messages above the message box"],
  [1105, 1109, "settings: chats at once, times, a shortcut's keys"],
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
