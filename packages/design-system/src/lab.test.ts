import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const lab = readFileSync(join(here, "lab.css"), "utf8");
const page = readFileSync(join(here, "../../../docs/design/ion-design-lab.html"), "utf8");

// Plan 08: the app's look is the design lab's, copied, not redrawn.
describe("lab.css", () => {
  it("holds the lab's rules for every part of the app window", () => {
    const selectors = [
      ".win{",
      ".rail{",
      ".rb{",
      ".side{",
      ".shead{",
      ".proj{",
      ".grp{",
      ".gl{",
      ".r{",
      ".r .tt{",
      ".r .tm{",
      ".spin{",
      ".chat{",
      ".head{",
      ".split{",
      ".convo{",
      ".msgs{",
      ".u{",
      ".a{",
      ".foot{",
      ".await{",
      ".cbox{",
      ".cbox.big{",
      ".pill{",
      ".send{",
      ".tools{",
      ".ttabs{",
      ".fh{",
      ".ln{",
      ".tree{",
      ".empty{",
      ".work{",
      ".wh{",
      ".ws{",
      ".bpop{",
      ".bp-row{",
      ".cblock{",
      ".ch{",
      ".pmenu{",
    ];
    for (const sel of selectors) expect(lab.includes(sel), sel).toBe(true);
  });

  it("copies each rule exactly as the lab has it", () => {
    const copied = lab.slice(0, lab.indexOf("/* app: not in the lab */"));
    // A whole rule on one line: starts like a selector, holds a "{", ends with "}".
    const rules = copied
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => /^[.@a-z]/.test(l) && l.includes("{") && l.endsWith("}"));
    expect(rules.length).toBeGreaterThan(100);
    for (const r of rules) expect(page.includes(r.trim()), r).toBe(true);
  });

  it("only changes what makes the lab's picture a real window", () => {
    const own = lab.slice(lab.indexOf("/* app: not in the lab */"));
    expect(own).toMatch(
      /\.win\{min-width:0;width:100vw;height:100vh;border-radius:0;border:0;box-shadow:none\}/,
    );
  });

  // Tour, 2026-11-21: the Agents chip ("Also loads its own") made its row taller than the others.
  it("keeps an Agents row the same height with a chip in it", () => {
    expect(lab).toMatch(/\.hrow \.chip\{[^}]*padding:0 8px;line-height:18px/);
    // And a Tools row's chip ("From Claude Code" in Import's preview).
    expect(lab).toMatch(/\.trow \.tname\+\.chip\{[^}]*padding:0 8px;line-height:18px/);
  });

  // Tour, 2026-11-21: each Tools row sized its own actions, so the agents' faces sat at a different place per row.
  it("lines up the agents' faces on every Tools row", () => {
    expect(lab).toMatch(/\.trow \.acts2\{[^}]*justify-content:flex-end;min-width:150px/);
  });

  // The user, 2026-11-21 (Plan 19): Settings → Memory, between Ions and Tools, drawn in the lab first (renderMemory).
  it("holds the lab's Memory page: whose, rows, a file, its history, to-dos, and ion chief's count", () => {
    for (const sel of [
      ".mscope{",
      ".trow .mby{",
      ".mhead{",
      ".mtext{",
      ".srow .when{",
      ".mfold{",
      ".head .todos{",
      // Task review, 2026-11-22: the switch's icon, named on hover.
      ".msee{",
    ])
      expect(lab.includes(sel), sel).toBe(true);
    expect(page).toContain("function renderMemory(){");
    const nav = page.slice(
      page.indexOf('<nav class="snav">'),
      page.indexOf("</nav>", page.indexOf('<nav class="snav">')),
    );
    expect(nav.indexOf('data-snav="ions"')).toBeLessThan(nav.indexOf('data-snav="memory"'));
    expect(nav.indexOf('data-snav="memory"')).toBeLessThan(nav.indexOf('data-snav="tools"'));
  });
});
