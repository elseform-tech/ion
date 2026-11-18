/** The small ring the spec shows beside running chats. */
export function Spinner({ label = "Running" }: { label?: string }) {
  return <span className="ion-spinner" role="status" aria-label={label} />;
}
