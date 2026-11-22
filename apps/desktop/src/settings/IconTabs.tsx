import type { LucideIcon } from "@ion/design-system";

/** A page's tabs, each an icon named on hover (Tools, Memory). */
export function IconTabs<T extends string>(p: {
  label: string;
  tabs: [T, string, LucideIcon][];
  tab: T;
  onPick: (t: T) => void;
}) {
  return (
    <span className="seg sm" role="group" aria-label={p.label}>
      {p.tabs.map(([id, name, Icon]) => (
        <button
          key={id}
          type="button"
          className={p.tab === id ? "on" : ""}
          title={name}
          aria-label={name}
          onClick={() => p.onPick(id)}
        >
          <Icon />
        </button>
      ))}
    </span>
  );
}
