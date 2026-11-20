import { ApiCallError } from "@ion/client/browser";
import { useCallback, useState } from "react";

/** Why a call failed: the daemon's own words, else a plain line. */
export const why = (e: unknown) => (e instanceof ApiCallError ? e.message : "Something went wrong");

export type Run = <T>(call: Promise<T>, then?: (r: T) => void) => void;

/** A control's last failed call, shown by it until a call works again (or it's cleared): [why, run a call, clear]. */
export function useCallError(): [string | null, Run, () => void] {
  const [error, setError] = useState<string | null>(null);
  const run: Run = useCallback(
    (call, then) =>
      void call.then(
        (r) => {
          setError(null);
          then?.(r);
        },
        (e: unknown) => setError(why(e)),
      ),
    [],
  );
  const clear = useCallback(() => setError(null), []);
  return [error, run, clear];
}
