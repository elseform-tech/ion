import type { IonClient } from "@ion/client/browser";
import { ChevronDown, ChevronUp } from "@ion/design-system";
import { useState } from "react";
import type { SettingsAt, ToolsAt } from "../goto.js";
import { Agents } from "./Agents.js";
import { useSettingsData } from "./data.js";
import { General } from "./General.js";
import { IonPage } from "./IonPage.js";
import { IonsList } from "./IonsList.js";
import { Memory } from "./Memory.js";
import { Notifications } from "./Notifications.js";
import { SETTINGS_PAGES, type SettingsPage } from "./pages.js";
import { Shortcuts } from "./Shortcuts.js";
import { Tools } from "./Tools.js";
import { useUsedPages } from "./used.js";

type Tab = SettingsPage;
type Page = { kind: Tab } | { kind: "ion"; ionId: string };
type Props = { client: IonClient; onOpenIon: (ionId: string) => void; at?: SettingsAt | null };

/** The row in Tools a link pointed to, if it did. */
const toolsAtOf = (at: SettingsAt | null): ToolsAt | null => (at && "name" in at ? at : null);

/** The page Settings opens on: where a link pointed (a page, your to-dos, a row in Tools), else Agents. */
function firstPage(at: SettingsAt | null): Tab {
  if (!at) return "agents";
  if ("page" in at) return at.page;
  return "name" in at ? "tools" : "memory";
}

/** Whether a link asked for the page's More open (a setting tucked there, from Search). */
const moreOf = (at: SettingsAt | null): boolean => !!at && "page" in at && at.more === true;

/** The page a sidebar button stands for (an ion's page is under Ions). */
const tabOf = (page: Page): Tab => (page.kind === "ion" ? "ions" : page.kind);

/**
 * Settings' pages, each named beside its icon: General, Agents and Memory, then any page you've used, then More with
 * the rest (Plan 21 Task 4). More starts open when you're on one of its pages, and stays as you leave it.
 */
function Nav({ page, used, onPick }: { page: Page; used: Set<Tab>; onPick: (t: Tab) => void }) {
  const hidden = SETTINGS_PAGES.filter((p) => p.tucked && !used.has(p.id));
  const [more, setMore] = useState(() => hidden.some((p) => p.id === tabOf(page)));
  const button = ({ id, label, icon: Icon }: (typeof SETTINGS_PAGES)[number]) => (
    <button key={id} type="button" className={tabOf(page) === id ? "on" : ""} onClick={() => onPick(id)}>
      <Icon />
      {label}
    </button>
  );
  return (
    <nav className="snav" aria-label="Settings">
      <b>Settings</b>
      {SETTINGS_PAGES.filter((p) => !hidden.includes(p)).map(button)}
      {hidden.length > 0 && (
        <button
          type="button"
          className="smore"
          aria-label="More settings"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          {more ? <ChevronUp /> : <ChevronDown />}
          More
        </button>
      )}
      {hidden.filter((p) => more || p.id === tabOf(page)).map(button)}
    </nav>
  );
}

/**
 * The lab's Settings: General (chats at once), Agents (who's ready, the model ion thinks with), Memory (ion's memory
 * files and your to-dos); under More until used, Ions (each ion's setup and rules), Tools (connections, hooks, skills),
 * Notifications and Shortcuts. `at`: opened from a link to a row in Tools, to your to-dos, or to a page (Search).
 */
export function Settings({ client, onOpenIon, at: link }: Props) {
  const at = link ?? null;
  const more = moreOf(at);
  const data = useSettingsData(client);
  const used = useUsedPages(client, data);
  const [page, setPage] = useState<Page>({ kind: firstPage(at) });
  return (
    <>
      <Nav page={page} used={used} onPick={(kind) => setPage({ kind })} />
      <div className="sbody">
        <div className="spage">
          {data.settings?.problem && <div className="perr">{data.settings.problem}</div>}
          {page.kind === "general" && <General client={client} data={data} />}
          {page.kind === "agents" && <Agents client={client} data={data} more={more} />}
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
          {page.kind === "memory" && <Memory client={client} data={data} at={at} more={more} />}
          {page.kind === "tools" && <Tools client={client} data={data} at={toolsAtOf(at)} />}
          {page.kind === "notifications" && <Notifications client={client} data={data} />}
          {page.kind === "shortcuts" && <Shortcuts />}
        </div>
      </div>
    </>
  );
}
