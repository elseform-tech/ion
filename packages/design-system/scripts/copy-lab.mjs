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
  [209, 265, "settings: nav, groups, rows, switches, ion page, agent and colour pickers; a bad button"],
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
  [571, 639, "media: code blocks"],
  [688, 702, "panel: in this chat (.inchat), its label (.lh2), media rows (.mrow); tasks"],
  [725, 736, "ions: needs strip, collapsed"],
  [773, 843, "brain picker; work"],
  [844, 863, "ions: suggestion cards"],
  [873, 873, "settings: effort bars in a value"],
  [902, 903, "settings: ion's model slots"],
  [908, 908, "settings: model separator"],
  [914, 940, "settings: tools rows, agents' status, stacked rows; Tools tabs, events and their hooks, menus"],
  [1009, 1009, "activity: rows"],
  [1072, 1089, "ions: project ion rows, a thread open beside its ion's chat; routines' instructions"],
  [1095, 1100, "the frame: the top strip, each screen inside it; the sidebar hidden"],
  [1101, 1107, "queued messages above the message box"],
  [1108, 1112, "settings: chats at once, times, a shortcut's keys"],
  [1113, 1119, "the message box's / and @ menu, picks as chips; a server's tools"],
  [1120, 1126, "settings: Memory (whose, search, rows, a file, history, to-dos); ion chief's open to-dos"],
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
