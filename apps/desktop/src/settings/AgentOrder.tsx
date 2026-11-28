import { Avatar, GripVertical } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { type DragEvent, type KeyboardEvent, useState } from "react";
import { More } from "./More.js";

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
function useAgentOrder(ids: string[], onOrder: (ids: string[]) => void) {
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

/**
 * Under More (the user, 2026-11-24): "Prefer in this order", a drag list of your agents (empty: Automatic decides;
 * once set, Automatic follows it), with Automatic to go back. Plan 21 Task 4: the page's More (it also shows each
 * agent's switches); an order you set shows without it.
 */
export function PreferOrder(p: {
  agents: HarnessInfo[];
  prefer: string[];
  onOrder: (ids: string[]) => void;
  more: boolean;
  onMore: (open: boolean) => void;
}) {
  const order = useAgentOrder(
    p.agents.map((h) => h.id),
    p.onOrder,
  );
  return (
    <div>
      <More open={p.more} onOpen={p.onMore} />
      {(p.more || p.prefer.length > 0) && (
        <div className="group">
          <div className="srow">
            <div className="g">
              Prefer in this order
              {!p.prefer.length && <div className="s">Automatic decides</div>}
            </div>
            {p.prefer.length > 0 && (
              <button className="btn" type="button" onClick={() => p.onOrder([])}>
                Automatic
              </button>
            )}
          </div>
          {p.agents.map((h, i) => (
            <div key={h.id} className="hrow ord" {...order.rowProps(i)}>
              {order.grip(i, h.label)}
              <Avatar harness={h.id} />
              <div>{h.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
