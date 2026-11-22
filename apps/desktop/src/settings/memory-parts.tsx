import {
  Bookmark,
  Circle,
  CircleCheck,
  Heart,
  Lightbulb,
  type LucideIcon,
  Trash2,
  User,
} from "@ion/design-system";
import type { MemoryInfo, MemoryType } from "@ion/schema";
import { TYPE_NAME } from "./memory-data.js";

const ICON: Record<MemoryType, LucideIcon> = {
  preference: Heart,
  fact: Lightbulb,
  person: User,
  todo: Circle,
  reference: Bookmark,
};

/** A file's type as its icon, named on hover (a done to-do shows its check). */
export function TypeIcon({ m }: { m: Pick<MemoryInfo, "type" | "status"> }) {
  const Icon = m.type === "todo" && m.status === "done" ? CircleCheck : ICON[m.type];
  return (
    <span className="ti" title={TYPE_NAME[m.type]}>
      <Icon />
    </span>
  );
}

/** An icon button named on hover. */
export function IconButton(p: { name: string; icon: LucideIcon; onClick: () => void; on?: boolean }) {
  const Icon = p.icon;
  return (
    <button
      className={`ib${p.on ? " on" : ""}`}
      type="button"
      title={p.name}
      aria-label={p.name}
      {...(p.on !== undefined ? { "aria-pressed": p.on } : {})}
      onClick={p.onClick}
    >
      <Icon />
    </button>
  );
}

/** Forget asks first, in a line where it was asked (never a dialog). */
export function ForgetAsk(p: { name: string; onForget: () => void; onCancel: () => void }) {
  return (
    <div className="srow ask">
      <div className="g">{`Forget “${p.name}”?`}</div>
      <button className="btn" type="button" onClick={p.onCancel}>
        Cancel
      </button>
      <button className="btn bad" type="button" onClick={p.onForget}>
        Forget
      </button>
    </div>
  );
}

/** The Forget button that opens the ask. */
export const ForgetButton = ({ onClick }: { onClick: () => void }) => (
  <IconButton name="Forget" icon={Trash2} onClick={onClick} />
);

/** An empty list, said in one quiet line. */
export const Nothing = ({ text }: { text: string }) => (
  <div className="group">
    <div className="srow">
      <div className="g s">{text}</div>
    </div>
  </div>
);
