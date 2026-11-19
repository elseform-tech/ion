/*
  Avatars, ported from the design lab (docs/design/ion-design-lab.html, lines 2386-2475): each harness has its
  shape and colour, with two eyes that blink and look around. The shape follows the harness only.
*/

const TAU = Math.PI * 2;

/** The path calls a shape uses: a Path2D in the app, a recorder in tests. */
export type PathSink = {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void;
  quadraticCurveTo(a: number, b: number, c: number, d: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  closePath(): void;
};

export type Shape = "circle" | "spark" | "hexflower" | "gem" | "cube" | "block";

/** Colours the bot reads from the page's tokens. */
export type Tokens = { win: string; ink: string; muted: string; accent: string };
type Paint = string | ((t: Tokens) => string);

export type Bot = {
  shape: Shape;
  /** Fill colour; a gradient is named by its stops. */
  color: Paint | { gradient: string[] };
  eye?: Paint;
  /** Eye offset and scale, the shape's tilt in degrees. */
  eo?: [number, number];
  es?: number;
  tilt?: number;
  /** Extra marks drawn inside the shape (the lab's decor). */
  decor?: "grok" | "codex" | "cursor" | "opencode";
  /** A ring around the body with coloured dots moving along it (ion chief; the rail's glyph). */
  orbit?: { tilt: number; speed: number; colors: Paint[]; stroke?: Paint };
  /** Drawn as an outline in this colour (eyes too), not filled: the rail's transparent glyph. */
  hollow?: (t: Tokens) => string;
};

const ink = { color: (t: Tokens) => t.ink, eye: (t: Tokens) => t.win };

/** The lab's library, keyed by ion's harness ids. A harness the lab doesn't draw is a plain orb. */
const LIB: Record<string, Bot> = {
  "claude-code": { shape: "spark", color: "#D97757", es: 0.88, tilt: -3 },
  codex: { shape: "hexflower", ...ink, tilt: 2, decor: "codex" },
  "grok-build": { shape: "circle", ...ink, eo: [-0.13, -0.13], es: 0.86, decor: "grok" },
  gemini: { shape: "gem", color: { gradient: ["#4285F4", "#9B72CB", "#D96570"] }, es: 0.7 },
  cursor: { shape: "cube", ...ink, eo: [0, 0.12], es: 0.78, decor: "cursor" },
  // Not in the lab: from opencode's logo, a square block with a square inside (the user, 2026-11-18).
  opencode: { shape: "block", ...ink, es: 0.8, decor: "opencode" },
};
const ORB: Bot = { shape: "circle", color: (t) => t.muted, eye: (t) => t.win };

export const botFor = (harness: string): Bot => LIB[harness] ?? ORB;

/** ion chief: the lab's ink circle with its orbit. */
const CHIEF: Bot = {
  shape: "circle",
  ...ink,
  orbit: { tilt: -0.42, speed: 1.1, colors: ["#D97757", "#4285F4", "#5BC67A"] },
};

/** The lab's rail glyph for Ions: a transparent orbit avatar, muted; ink with an accent dot when Ions is open. */
export function railGlyph(on: boolean): Bot {
  const ring = (t: Tokens) => (on ? t.ink : t.muted);
  return {
    shape: "circle",
    color: (t) => t.win,
    hollow: ring,
    orbit: { tilt: -0.42, speed: 1.2, colors: [(t) => (on ? t.accent : t.muted)], stroke: ring },
  };
}

/**
 * An ion's avatar (the lab's `hybrid`): a project's ion is its harness's shape, decor and eyes in the project's
 * colour; an unknown or no harness is a circle; ion chief is the ink circle with its orbit.
 */
export function ionBot(ion: { harness: string | null; color: string | null } | "chief"): Bot {
  if (ion === "chief") return CHIEF;
  const base = ion.harness ? (LIB[ion.harness] ?? ORB) : ORB;
  return { ...base, color: ion.color ?? base.color, eye: (t) => t.win };
}

function polar(p: PathSink, f: (th: number) => number, n = 240): void {
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * TAU;
    const r = f(th);
    const x = Math.cos(th) * r;
    const y = Math.sin(th) * r;
    if (i) p.lineTo(x, y);
    else p.moveTo(x, y);
  }
  p.closePath();
}

const ngon = (th: number, n: number, rot = 0) => {
  const a = TAU / n;
  const u = (((th - rot) % a) + a) % a;
  return Math.cos(Math.PI / n) / Math.cos(u - Math.PI / n);
};

/** A square of half-side `h` with corners of radius `r`, as one closed path. */
function roundedSquare(p: PathSink, h: number, r: number): void {
  p.moveTo(-h + r, -h);
  p.lineTo(h - r, -h);
  p.quadraticCurveTo(h, -h, h, -h + r);
  p.lineTo(h, h - r);
  p.quadraticCurveTo(h, h, h - r, h);
  p.lineTo(-h + r, h);
  p.quadraticCurveTo(-h, h, -h, h - r);
  p.lineTo(-h, -h + r);
  p.quadraticCurveTo(-h, -h, -h + r, -h);
  p.closePath();
}

/** Traces a shape on a unit scale (radius about 1), as the lab's shapePath. */
export function tracePath(s: Shape, p: PathSink): void {
  switch (s) {
    case "circle":
      p.arc(0, 0, 1, 0, TAU);
      return;
    case "spark":
      return polar(p, (th) => 0.72 + 0.3 * (0.5 + 0.5 * Math.cos(11 * th + 0.4)) ** 3);
    case "hexflower":
      return polar(p, (th) => 0.9 + 0.07 * Math.cos(6 * th));
    case "gem": {
      const c = 0.5;
      p.moveTo(0, -1.12);
      p.quadraticCurveTo(c, -c, 1.12, 0);
      p.quadraticCurveTo(c, c, 0, 1.12);
      p.quadraticCurveTo(-c, c, -1.12, 0);
      p.quadraticCurveTo(-c, -c, 0, -1.12);
      p.closePath();
      return;
    }
    case "cube":
      return polar(p, (th) => 0.82 * ngon(th, 6, -Math.PI / 2) + 0.18);
    case "block":
      return roundedSquare(p, 0.86, 0.22);
  }
}

/** A deterministic 0–1 value from a number (the lab's hash). */
export function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
