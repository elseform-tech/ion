import { Avatar, ChevronRight } from "@ion/design-system";
import type { IonInfo } from "@ion/schema";
import type { SettingsData } from "./data.js";

/** The agent an ion runs on, by name. */
const agentName = (data: SettingsData, id: string | null) =>
  data.harnesses.find((h) => h.id === id)?.label ?? id ?? "";

function IonLine({ ion, data, onOpen }: { ion: IonInfo; data: SettingsData; onOpen: () => void }) {
  const chief = ion.ionId === "chief";
  const folder = data.projects.find((p) => p.id === ion.ionId)?.path;
  return (
    <button className="irow" type="button" onClick={onOpen}>
      <Avatar ion={chief ? "chief" : { harness: ion.harness, color: ion.color }} />
      <span>
        <span className="tt">{ion.name}</span>
        <span className="s">{chief ? "All projects" : folder}</span>
      </span>
      {!chief && ion.harness ? (
        <span className="h">
          <Avatar harness={ion.harness} />
          {agentName(data, ion.harness)}
        </span>
      ) : (
        <span />
      )}
      <span className="h">{chief ? "All" : ""}</span>
      <ChevronRight />
    </button>
  );
}

/** Settings → Ions: ion chief, then each project's ion; one opens its page. */
export function IonsList({ data, onOpen }: { data: SettingsData; onOpen: (ionId: string) => void }) {
  return (
    <div>
      <h4>Your ions</h4>
      <div className="group">
        {data.ions.map((ion) => (
          <IonLine key={ion.ionId} ion={ion} data={data} onOpen={() => onOpen(ion.ionId)} />
        ))}
      </div>
    </div>
  );
}
