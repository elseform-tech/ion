import type { IonClient } from "@ion/client/browser";
import { Bell, Blocks, Keyboard, Orbit, Plug, SlidersHorizontal } from "@ion/design-system";
import { useState } from "react";
import type { ToolsAt } from "../goto.js";
import { Agents } from "./Agents.js";
import { useSettingsData } from "./data.js";
import { General } from "./General.js";
import { IonPage } from "./IonPage.js";
import { IonsList } from "./IonsList.js";
import { Notifications } from "./Notifications.js";
import { Shortcuts } from "./Shortcuts.js";
import { Tools } from "./Tools.js";

type Tab = "general" | "agents" | "ions" | "tools" | "notifications" | "shortcuts";
type Page = { kind: Tab } | { kind: "ion"; ionId: string };
type Props = { client: IonClient; onOpenIon: (ionId: string) => void; toolsAt?: ToolsAt | null };

/**
 * The lab's Settings: General (chats at once), Agents (who's ready, the model ion thinks with), Ions (each ion's setup
 * and rules), Tools (connections, hooks, skills), Notifications and Shortcuts. `toolsAt`: opened from a chat's link to
 * a row in Tools.
 */
export function Settings({ client, onOpenIon, toolsAt }: Props) {
  const data = useSettingsData(client);
  const [page, setPage] = useState<Page>({ kind: toolsAt ? "tools" : "agents" });
  const tab = (kind: Tab, label: string, Icon: typeof Plug) => {
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
        {tab("general", "General", SlidersHorizontal)}
        {tab("agents", "Agents", Plug)}
        {tab("ions", "Ions", Orbit)}
        {tab("tools", "Tools", Blocks)}
        {tab("notifications", "Notifications", Bell)}
        {tab("shortcuts", "Shortcuts", Keyboard)}
      </nav>
      <div className="sbody">
        <div className="spage">
          {data.settings?.problem && <div className="perr">{data.settings.problem}</div>}
          {page.kind === "general" && <General client={client} data={data} />}
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
          {page.kind === "tools" && <Tools client={client} data={data} at={toolsAt ?? null} />}
          {page.kind === "notifications" && <Notifications client={client} data={data} />}
          {page.kind === "shortcuts" && <Shortcuts />}
        </div>
      </div>
    </>
  );
}
