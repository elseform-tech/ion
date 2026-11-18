import { useEffect, useRef } from "react";
import { type Bot, botFor, hash, type Tokens, tracePath } from "./bots.js";

/*
  Drawing and motion, ported from the design lab (drawEyes, targetPose, easePose, drawBot, frame: lines
  2417-2470 and 3447-3460). One animation loop draws every avatar on screen; with reduced motion they hold still.
*/

export type BotState = "idle" | "working" | "waiting" | "done";
type Pose = { lx: number; ly: number; turn: number; open: number; happy: number; h: number };
type View = { cv: HTMLCanvasElement; bot: Bot; seed: number; state: BotState; pose?: Pose; w: number };

const TAU = Math.PI * 2;
const views = new Set<View>();
const reduce = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function tokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string, d: string) => cs.getPropertyValue(`--${k}`).trim() || d;
  return {
    win: v("win", "#131417"),
    ink: v("ink", "#ECEDF0"),
    muted: v("muted", "#9497A1"),
    accent: v("accent", "#7D93FF"),
  };
}

/** Where each state looks: r1 and r2 are this moment's random values, ph a steady phase. */
const POSES: Record<BotState, (p: Pose, r1: number, r2: number, ph: number) => void> = {
  idle: (p, r1, r2) => {
    p.lx = (r1 - 0.5) * 0.36;
    p.ly = (r2 - 0.5) * 0.2;
    const side = r2 > 0.5 ? 1 : -1;
    p.turn = r1 > 0.8 ? side * 0.75 : 0;
    if (r1 < 0.1) p.happy = 1;
  },
  working: (p, _r1, _r2, ph) => {
    p.lx = -0.16 + ((ph * 0.6) % 1) * 0.32;
    p.ly = 0.16;
    p.h = 0.92;
  },
  waiting: (p, _r1, _r2, ph) => {
    p.lx = Math.sin(ph * 0.8) > 0 ? 0.2 : -0.2;
    p.ly = -0.1;
  },
  done: (p) => {
    p.happy = 1;
  },
};

function targetPose(v: View, t: number): Pose {
  const sd = v.seed;
  const pose: Pose = { lx: 0, ly: 0, turn: 0, open: 1, happy: 0, h: 1 };
  const seg = Math.floor((t + sd * 3) / 1.6);
  POSES[v.state](pose, hash(seg + sd * 31), hash(seg * 1.7 + sd * 17), t + sd);
  const bp = ((t + sd * 2.3) * 0.95) % 3.3;
  if (bp < 0.16 && !pose.happy) pose.open = Math.max(0.14, Math.abs(bp - 0.08) / 0.08);
  return pose;
}

function easePose(v: View, t: number, dt: number): Pose {
  const tp = targetPose(v, t);
  v.pose ??= { ...tp };
  const k = reduce() ? 1 : 1 - Math.exp(-dt * 14);
  for (const key of Object.keys(tp) as (keyof Pose)[])
    v.pose[key] = key === "open" ? tp.open : v.pose[key] + (tp[key] - v.pose[key]) * k;
  return v.pose;
}

function pill(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const r = Math.min(w, h) / 2;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + r, -h / 2);
  ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
  ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
  ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
  ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
  ctx.closePath();
  ctx.fill();
}

function drawEyes(ctx: CanvasRenderingContext2D, pose: Pose, eye: string): void {
  const EX = 0.31;
  const EW = 0.25;
  const cx = pose.lx + pose.turn * 0.12;
  ctx.fillStyle = eye;
  ctx.strokeStyle = eye;
  if (pose.happy > 0.5) {
    ctx.lineWidth = 0.2;
    ctx.lineCap = "round";
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx + s * EX, pose.ly + 0.1, 0.16, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
    }
    return;
  }
  for (const s of [-1, 1]) {
    const far = pose.turn * s > 0 ? 0 : Math.abs(pose.turn);
    const w = EW * (1 - far * 0.15);
    const h = Math.max(EW * 0.9, 0.55 * pose.h * (1 - far * 0.55)) * pose.open;
    ctx.save();
    ctx.translate(cx + s * EX * (1 - Math.abs(pose.turn) * 0.25), pose.ly);
    pill(ctx, w, Math.max(h, w * 0.35));
    ctx.restore();
  }
}

/** The lab's decor: marks drawn inside the shape. */
function decor(ctx: CanvasRenderingContext2D, d: Bot["decor"], t: Tokens): void {
  ctx.strokeStyle = t.win;
  ctx.fillStyle = t.win;
  if (d === "grok") {
    ctx.lineWidth = 0.14;
    ctx.beginPath();
    ctx.moveTo(-0.3, 1.1);
    ctx.lineTo(1.1, -0.3);
    ctx.stroke();
  } else if (d === "codex") {
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 0.07;
    for (let k = 0; k < 3; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI) / 3);
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.66, 0.3, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  } else if (d === "opencode") {
    ctx.globalAlpha = 0.16;
    ctx.fillRect(-0.5, -0.5, 1, 1);
  } else if (d === "cursor") {
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.moveTo(0, -1);
    ctx.lineTo(0.87, -0.5);
    ctx.lineTo(0, 0);
    ctx.lineTo(-0.87, -0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function fillOf(ctx: CanvasRenderingContext2D, b: Bot, t: Tokens): string | CanvasGradient {
  if (typeof b.color === "function") return b.color(t);
  if (typeof b.color === "string") return b.color;
  const g = ctx.createLinearGradient(-1, -1, 1, 1);
  b.color.gradient.forEach((c, i, all) => g.addColorStop(i / (all.length - 1), c));
  return g;
}

function draw(ctx: CanvasRenderingContext2D, v: View, size: number, time: { t: number; dt: number }): void {
  const tk = tokens();
  const R = size * 0.4;
  const dy = reduce() || v.state !== "idle" ? 0 : Math.sin((time.t + v.seed) * 1.5) * R * 0.025;
  const pose = easePose(v, time.t, time.dt);
  ctx.save();
  ctx.translate(size / 2, size / 2 + dy);
  ctx.rotate(((v.bot.tilt ?? 0) * Math.PI) / 180);
  ctx.scale(R, R);
  const p = new Path2D();
  tracePath(v.bot.shape, p);
  ctx.fillStyle = fillOf(ctx, v.bot, tk);
  ctx.fill(p);
  if (v.bot.decor) {
    ctx.save();
    ctx.clip(p);
    decor(ctx, v.bot.decor, tk);
    ctx.restore();
  }
  const [ex, ey] = v.bot.eo ?? [0, 0];
  ctx.translate(ex, ey);
  ctx.scale(v.bot.es ?? 1, v.bot.es ?? 1);
  const eye = v.bot.eye;
  drawEyes(ctx, pose, typeof eye === "function" ? eye(tk) : (eye ?? tk.win));
  ctx.restore();
}

let running = false;
let last = 0;
const t0 = typeof performance === "object" ? performance.now() : 0;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = reduce() ? 0.5 : (now - t0) / 1000;
  for (const v of views) {
    const ctx = v.cv.getContext("2d");
    const w = v.cv.getBoundingClientRect().width;
    if (!ctx || !w) continue;
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    if (Math.abs(w - v.w) > 0.5) {
      v.w = w;
      v.cv.width = v.cv.height = Math.round(w * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, w);
    draw(ctx, v, w, { t, dt });
  }
  running = views.size > 0 && !reduce();
  if (running) requestAnimationFrame(frame);
}

/** A harness's avatar, as the lab draws it (class "av": the lab's sizes apply). */
export function Avatar({
  harness,
  seed = 0.4,
  state = "idle",
}: {
  harness: string;
  seed?: number;
  state?: BotState;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || typeof Path2D === "undefined") return;
    const v: View = { cv, bot: botFor(harness), seed, state, w: 0 };
    views.add(v);
    if (!running) requestAnimationFrame(frame);
    return () => void views.delete(v);
  }, [harness, seed, state]);
  return <canvas ref={ref} className="av" aria-hidden="true" />;
}
