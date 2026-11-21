/** An on/off switch, named for what it turns on. */
export function Switch(p: { label: string; on: boolean; onPick: (on: boolean) => void; title?: string }) {
  const { label, on, onPick } = p;
  return (
    <button
      type="button"
      className={`sw${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      {...(p.title ? { title: p.title } : {})}
      onClick={() => onPick(!on)}
    />
  );
}
