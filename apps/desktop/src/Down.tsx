import { Button } from "@ion/design-system";

/** Shown while the daemon isn't reachable. The app keeps trying on its own; the button just tries now. */
export function Down({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="down">
      <h1>ion isn't running</h1>
      <p>
        Start it with: <code>ion daemon start</code>
      </p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}
