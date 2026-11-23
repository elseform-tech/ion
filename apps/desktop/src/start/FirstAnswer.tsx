import type { IonClient } from "@ion/client/browser";
import { Brain } from "@ion/design-system";
import { useEffect, useState } from "react";
import { openMemory } from "../goto.js";

/**
 * After your first answer, one quiet line on what ion now remembers, linking to Settings → Memory (Plan 21; the audit,
 * 2026-11-23: nothing told a beginner that ion remembers). Nothing more.
 */
export function FirstAnswer({ client }: { client: IonClient }) {
  const [notes, setNotes] = useState<number | null>(null);
  useEffect(() => {
    void client.call("memory.list", {}).then(
      (list) => setNotes(Array.isArray(list) ? list.length : 0),
      () => setNotes(0),
    );
  }, [client]);
  if (notes === null) return null;
  const noun = notes === 1 ? "note" : "notes";
  return (
    <div className="quiet">
      <Brain />
      {notes ? `ion now remembers ${notes} ${noun}` : "ion keeps notes as you work"}
      <button type="button" className="lnk" onClick={openMemory}>
        Memory
      </button>
    </div>
  );
}
