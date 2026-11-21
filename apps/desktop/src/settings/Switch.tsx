/** An on/off switch, named for what it turns on. */
export function Switch({ label, on, onPick }: { label: string; on: boolean; onPick: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`sw${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onPick(!on)}
    />
  );
}
