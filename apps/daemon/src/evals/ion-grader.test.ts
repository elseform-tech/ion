import { describe, expect, it } from "vitest";
import { BRIEF_LABELS } from "./ion-brief-labels.js";
import {
  AGREEMENT_MIN,
  agreementOf,
  briefVerdict,
  type Grade,
  graderPrompt,
  parseGrade,
} from "./ion-grader.js";
import { projectOf } from "./ion-seeds.js";

// Plan 23 Task 2 (2026-11-28): the brief grader, with no model. Its scores only count once it agrees with the hand
// labels, so the agreement itself must be computed right; each test was watched failing before ion-grader.ts existed.

const grade = (score: number, invented: string[] = []): Grade => ({
  request: Math.min(2, score),
  constraints: score > 2 ? 1 : 0,
  check: score > 3 ? 1 : 0,
  invented,
  score,
});

describe("brief grader", () => {
  it("computes the grader's agreement against the labels: a score within one, and the same call on invention", () => {
    const labels = BRIEF_LABELS.slice(0, 4);
    const exact = labels.map((l) => grade(l.score, l.invented ? ["x"] : []));
    expect(agreementOf(labels, exact)).toMatchObject({ agreed: 4, of: 4, pct: 1, misses: [] });
    const far = (n: number) => (n > 2 ? n - 2 : n + 2);
    const off = labels.map((l, i) => (i === 0 ? grade(far(l.score)) : exact[i]!));
    const r = agreementOf(labels, off);
    expect(r).toMatchObject({ agreed: 3, of: 4, pct: 0.75 });
    expect(r.misses).toEqual([labels[0]!.id]);
    // Invention called the other way is a miss, whatever the score.
    const other = (l: (typeof labels)[number]) => grade(l.score, l.invented ? [] : ["made up"]);
    const flipped = labels.map((l, i) => (i === 1 ? other(l) : exact[i]!));
    expect(agreementOf(labels, flipped).misses).toEqual([labels[1]!.id]);
    // No grade (no answer, no JSON) is a miss, never a pass.
    expect(agreementOf(labels, [null, ...exact.slice(1)]).agreed).toBe(3);
    expect(AGREEMENT_MIN).toBeCloseTo(0.85);
  });

  it("has about 20 labels, good and bad, long and short, with invention among them", () => {
    expect(BRIEF_LABELS.length).toBeGreaterThanOrEqual(18);
    expect(new Set(BRIEF_LABELS.map((l) => l.id)).size).toBe(BRIEF_LABELS.length);
    const long = (l: (typeof BRIEF_LABELS)[number]) => l.brief.length > 400;
    expect(BRIEF_LABELS.filter((l) => l.score >= 4 && long(l)).length).toBeGreaterThanOrEqual(2);
    expect(BRIEF_LABELS.filter((l) => l.score <= 2 && long(l)).length).toBeGreaterThanOrEqual(2);
    expect(BRIEF_LABELS.filter((l) => l.score >= 4 && !long(l)).length).toBeGreaterThanOrEqual(2);
    expect(BRIEF_LABELS.filter((l) => l.score <= 2 && !long(l)).length).toBeGreaterThanOrEqual(2);
    expect(BRIEF_LABELS.filter((l) => l.invented).length).toBeGreaterThanOrEqual(4);
    for (const l of BRIEF_LABELS) expect(projectOf(l.projectId), l.id).toBeDefined();
  });

  it("reads only a whole JSON grade, and works the score out itself", () => {
    expect(parseGrade('{"request":2,"constraints":1,"check":0,"invented":[]}')).toEqual({
      request: 2,
      constraints: 1,
      check: 0,
      invented: [],
      score: 4,
    });
    expect(
      parseGrade('```json\n{"request":1,"constraints":0,"check":1,"invented":["a path"]}\n```')?.score,
    ).toBe(2);
    expect(parseGrade('{"request":3,"constraints":1,"check":1,"invented":[]}')).toBeNull();
    expect(parseGrade("Score: 5")).toBeNull();
  });

  it("puts the request, the brief and the project's files in data blocks, and never rewards length", () => {
    const l = BRIEF_LABELS[0]!;
    const p = graderPrompt({ request: l.request, brief: l.brief, projectId: l.projectId });
    expect(p).toContain(l.brief);
    expect(p).toContain(l.request);
    expect(p).toMatch(/README\.md/);
    expect(p).toMatch(/Length earns nothing/);
    expect(p.match(/<ion-data id=/g)?.length).toBe(3);
  });

  it("fails a case's briefs on any invention, an average under 4, or a brief not graded", () => {
    expect(briefVerdict([grade(5), grade(4)])).toBe("");
    expect(briefVerdict([grade(5), grade(2)])).toMatch(/3\.5/);
    expect(briefVerdict([grade(5, ["a reviewer named Mei"])])).toMatch(/invented/);
    expect(briefVerdict([grade(5), null])).toMatch(/not graded/);
    expect(briefVerdict([])).toMatch(/no brief/);
  });
});
