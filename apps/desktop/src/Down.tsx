import { Button } from "@ion/design-system";

/**
 * Shown while the daemon isn't reachable. The app keeps trying on its own; the button just tries now. While the app
 * starts ion itself (Plan 21), it says so instead.
 */
export function Down({ onRetry, starting = false }: { onRetry: () => void; starting?: boolean }) {
  if (starting)
    return (
      <div className="down">
        <h1>
          <i className="spin" /> Starting ion…
        </h1>
      </div>
    );
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
