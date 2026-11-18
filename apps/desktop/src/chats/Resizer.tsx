import { type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";

type Props = {
  /** The CSS variable on the page that holds the width, e.g. "--side-w". */
  name: string;
  label: string;
  initial: number;
  min: number;
  max: number;
  /** Which edge of its box the handle sits on: "right" grows to the right (the sidebar), "left" to the left. */
  edge: "left" | "right";
};

const STEP = 16;
const root = () => document.documentElement.style;

/** A thin handle on a box's edge: drag it (or use the arrow keys) to make the box wider or narrower. */
export function Resizer({ name, label, initial, min, max, edge }: Props) {
  const width = useRef(initial);
  const set = (w: number) => {
    width.current = Math.round(Math.min(max, Math.max(min, w)));
    root().setProperty(name, `${width.current}px`);
  };
  useEffect(() => {
    if (!root().getPropertyValue(name)) root().setProperty(name, `${initial}px`);
    width.current = Number.parseInt(root().getPropertyValue(name), 10) || initial;
  }, [name, initial]);
  const sign = edge === "right" ? 1 : -1;
  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    const from = e.clientX;
    const start = width.current;
    const move = (m: globalThis.MouseEvent) => set(start + sign * (m.clientX - from));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.body.classList.add("resizing");
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const d = { ArrowRight: STEP, ArrowLeft: -STEP }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    set(width.current + sign * d);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no element of its own; it's a separator
    <div
      className={`rz rz-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width.current}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    />
  );
}
