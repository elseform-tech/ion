import type { IonClient } from "@ion/client/browser";
import { Wrench } from "@ion/design-system";
import type { ServerTools } from "@ion/schema";
import { useEffect, useState } from "react";
import { useCallError } from "../callError.js";
import { Switch } from "./Switch.js";
import { ToolRow } from "./tools-parts.js";

/**
 * A server's tools under its row (the user, 2026-11-21), each with "Ions can use": on as the server labels it (read-only
 * and not destructive) until you switch it; one that changed is off for ions until you look.
 */
export function ServerToolsList({ client, id }: { client: IonClient; id: string }) {
  const [got, setGot] = useState<ServerTools | null>(null);
  const [reads, setReads] = useState(0);
  const [error, run] = useCallError();
  // Read when it opens, and again after each switch.
  useEffect(() => {
    let live = true;
    client.call("tools.serverTools", { id }).then(
      (t) => live && setGot(t),
      () => live && setGot({ tools: [], problem: "ion couldn't list them" }),
    );
    return () => {
      live = false;
    };
  }, [client, id, reads]);
  if (!got) return <div className="stools s">…</div>;
  if (got.problem) return <div className="stools s">{got.problem}</div>;
  return (
    <div className="stools">
      {got.tools.map((t) => (
        <ToolRow
          key={t.name}
          icon={Wrench}
          name={t.name}
          chip={t.changed ? "Changed" : null}
          line={<span title={t.description}>{t.description}</span>}
          end={
            <Switch
              label={`Ions can use ${t.name}`}
              title="Ions can use"
              on={t.ions}
              onPick={(on) =>
                run(client.call("tools.setIonUse", { id, tool: t.name, on }), () => setReads((n) => n + 1))
              }
            />
          }
        />
      ))}
      {error && <div className="perr">{error}</div>}
    </div>
  );
}
