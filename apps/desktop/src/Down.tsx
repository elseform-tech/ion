import { Button } from "@ion/design-system";

/**
 * Shown while the daemon isn't reachable. The app keeps trying on its own; the button just tries now. While the app
 * starts ion itself (Plan 21), it says so instead. `packaged`: a release build, which doesn't include ion yet (Plan 21
 * final review): it says so, and how to get ion.
 */
export function Down(p: { onRetry: () => void; starting?: boolean; packaged?: boolean }) {
  const { onRetry, starting = false } = p;
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
      {p.packaged ? (
        <p>
          This app doesn't include ion yet. Get ion from its repo: <code>pnpm install && pnpm build</code>,
          then <code>ion daemon start</code>
        </p>
      ) : (
        <p>
          Start it with: <code>ion daemon start</code>
        </p>
      )}
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}
