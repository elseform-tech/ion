import type { IonClient } from "@ion/client/browser";
import { Bell, Blocks, Keyboard, NotebookText, Orbit, Plug, SlidersHorizontal } from "@ion/design-system";
import { useState } from "react";
import type { SettingsAt, ToolsAt } from "../goto.js";
import { Agents } from "./Agents.js";
import { useSettingsData } from "./data.js";
import { General } from "./General.js";
import { IonPage } from "./IonPage.js";
import { IonsList } from "./IonsList.js";
import { Memory } from "./Memory.js";
import { Notifications } from "./Notifications.js";
import { Shortcuts } from "./Shortcuts.js";
import { Tools } from "./Tools.js";

type Tab = "general" | "agents" | "ions" | "memory" | "tools" | "notifications" | "shortcuts";
type Page = { kind: Tab } | { kind: "ion"; ionId: string };
type Props = { client: IonClient; onOpenIon: (ionId: string) => void; at?: SettingsAt | null };

/** The row in Tools a link pointed to, if it did. */
const toolsAtOf = (at: SettingsAt | null): ToolsAt | null => (at?.kind === "todos" ? null : at);

/** The page Settings opens on: where a link pointed (your to-dos, a row in Tools), else Agents. */
function firstPage(at: SettingsAt | null): Tab {
  if (!at) return "agents";
  return at.kind === "todos" ? "memory" : "tools";
}

const TABS: [Tab, string, typeof Plug][] = [
  ["general", "General", SlidersHorizontal],
  ["agents", "Agents", Plug],
  ["ions", "Ions", Orbit],
  ["memory", "Memory", NotebookText],
  ["tools", "Tools", Blocks],
  ["notifications", "Notifications", Bell],
  ["shortcuts", "Shortcuts", Keyboard],
];

/** Settings' pages, each named beside its icon (an ion's page is under Ions). */
function Nav({ page, onPick }: { page: Page; onPick: (t: Tab) => void }) {
  return (
    <nav className="snav" aria-label="Settings">
      <b>Settings</b>
      {TABS.map(([kind, label, Icon]) => (
        <button
          key={kind}
          type="button"
          className={page.kind === kind || (kind === "ions" && page.kind === "ion") ? "on" : ""}
          onClick={() => onPick(kind)}
        >
          <Icon />
          {label}
        </button>
      ))}
    </nav>
  );
}

/**
 * The lab's Settings: General (chats at once), Agents (who's ready, the model ion thinks with), Ions (each ion's setup
 * and rules), Memory (ion's memory files and your to-dos), Tools (connections, hooks, skills), Notifications and
 * Shortcuts. `at`: opened from a link to a row in Tools, or to your to-dos.
 */
export function Settings({ client, onOpenIon, at }: Props) {
  const data = useSettingsData(client);
  const [page, setPage] = useState<Page>({ kind: firstPage(at ?? null) });
  return (
    <>
      <Nav page={page} onPick={(kind) => setPage({ kind })} />
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
          {page.kind === "memory" && <Memory client={client} data={data} at={at ?? null} />}
          {page.kind === "tools" && <Tools client={client} data={data} at={toolsAtOf(at ?? null)} />}
          {page.kind === "notifications" && <Notifications client={client} data={data} />}
          {page.kind === "shortcuts" && <Shortcuts />}
        </div>
      </div>
    </>
  );
}
