import type { IonClient } from "@ion/client/browser";
import { GripVertical } from "@ion/design-system";
import type { HarnessInfo, OnLimit } from "@ion/schema";
import { type DragEvent, type KeyboardEvent, useState } from "react";
import { Row } from "./IonPage.js";
import { Switch } from "./Switch.js";

/** The agents in your order (the ones it doesn't name after, as listed). */
export function inOrder(agents: HarnessInfo[], order: string[] | undefined): HarnessInfo[] {
  const at = (id: string) => {
    const i = order?.indexOf(id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...agents].sort((a, b) => at(a.id) - at(b.id));
}

/** `ids` with the one at `from` moved to `to`. */
const moved = (ids: string[], from: number, to: number): string[] => {
  const next = [...ids];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id!);
  return next;
};

/**
 * Your agent order as a drag list (the user, 2026-11-22): each row's grip drags it to another row, or moves it a
 * step with ↑ and ↓. `rowProps(i)` goes on row i (where a drag lands); `grip(i, label)` is its handle.
 */
export function useAgentOrder(ids: string[], onOrder: (ids: string[]) => void) {
  const [dragging, setDragging] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length || to === from) return;
    onOrder(moved(ids, from, to));
  };
  const rowProps = (i: number) => ({
    onDragOver: (e: DragEvent) => dragging !== null && e.preventDefault(),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (dragging !== null) move(dragging, i);
      setDragging(null);
    },
  });
  const grip = (i: number, label: string) => (
    <button
      type="button"
      className="ib grip"
      draggable
      aria-label={`Move ${label}`}
      title="Drag to reorder"
      onDragStart={(e: DragEvent) => {
        e.dataTransfer?.setData("text/plain", ids[i]!);
        setDragging(i);
      }}
      onDragEnd={() => setDragging(null)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          move(i, i + (e.key === "ArrowUp" ? -1 : 1));
        }
      }}
    >
      <GripVertical />
    </button>
  );
  return { rowProps, grip };
}

const ON_LIMIT: [OnLimit, string][] = [
  ["ask", "Ask"],
  ["continue", "Continue on the next agent"],
  ["wait", "Wait"],
];

/** What ion does when a chat's agent hits its limit, and Pick by usage (off at first). */
export function PickingAgents(p: {
  client: IonClient;
  onLimit: OnLimit;
  byUsage: boolean;
  run: (call: Promise<unknown>) => void;
}) {
  const set = (patch: { onLimit?: OnLimit; byUsage?: boolean }) =>
    p.run(p.client.call("settings.set", { patch }));
  return (
    <div className="group">
      <div className="srow">
        <div className="g">When an agent hits its limit</div>
        <span className="seg sm" role="group" aria-label="When an agent hits its limit">
          {ON_LIMIT.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={p.onLimit === id ? "on" : ""}
              onClick={() => set({ onLimit: id })}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <Row label="Pick by usage">
        <Switch label="Pick by usage" on={p.byUsage} onPick={(on) => set({ byUsage: on })} />
      </Row>
    </div>
  );
}
