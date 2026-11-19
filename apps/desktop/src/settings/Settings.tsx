import type { IonClient } from "@ion/client/browser";
import { Orbit, Plug } from "@ion/design-system";
import { useState } from "react";
import { Agents } from "./Agents.js";
import { useSettingsData } from "./data.js";
import { IonPage } from "./IonPage.js";
import { IonsList } from "./IonsList.js";

type Page = { kind: "agents" } | { kind: "ions" } | { kind: "ion"; ionId: string };

/** The lab's Settings: Agents (who's ready, the model ion thinks with) and Ions (each ion's setup and rules). */
export function Settings({ client, onOpenIon }: { client: IonClient; onOpenIon: (ionId: string) => void }) {
  const data = useSettingsData(client);
  const [page, setPage] = useState<Page>({ kind: "agents" });
  const tab = (kind: "agents" | "ions", label: string, Icon: typeof Plug) => {
    const on = page.kind === kind || (kind === "ions" && page.kind === "ion");
    return (
      <button type="button" className={on ? "on" : ""} onClick={() => setPage({ kind })}>
        <Icon />
        {label}
      </button>
    );
  };
  return (
    <>
      <nav className="snav" aria-label="Settings">
        <b>Settings</b>
        {tab("agents", "Agents", Plug)}
        {tab("ions", "Ions", Orbit)}
      </nav>
      <div className="sbody">
        <div className="spage">
          {page.kind === "agents" && <Agents client={client} data={data} />}
          {page.kind === "ions" && (
            <IonsList data={data} onOpen={(ionId) => setPage({ kind: "ion", ionId })} />
          )}
          {page.kind === "ion" && (
            <IonPage
              client={client}
              data={data}
              ionId={page.ionId}
              onBack={() => setPage({ kind: "ions" })}
              onOpenChat={() => onOpenIon(page.ionId)}
              onAgents={() => setPage({ kind: "agents" })}
            />
          )}
        </div>
      </div>
    </>
  );
}
