import type { IonClient } from "@ion/client/browser";
import { FolderOpen, ListTodo, type LucideIcon, MessagesSquare, NotebookText } from "@ion/design-system";
import type { IonInfo, MemoryInfo } from "@ion/schema";
import { type ReactNode, useState } from "react";
import { type Run, useCallError } from "../callError.js";
import { relTime } from "../chats/live.js";
import type { SettingsAt } from "../goto.js";
import { CANT_OPEN } from "../opener.js";
import type { SettingsData } from "./data.js";
import { IconTabs } from "./IconTabs.js";
import { type MemoryData, scopeOf, sharable, useMemory, useSearch, whoOf } from "./memory-data.js";
import { DreamRow, Tidied, tidiedByIon } from "./MemoryDream.js";
import { MemoryFile } from "./MemoryFile.js";
import { Nothing, TypeIcon } from "./memory-parts.js";
import { MemoryTodos } from "./MemoryTodos.js";
import { More } from "./More.js";
import { OpenPath } from "./OpenPath.js";
import { Switch } from "./Switch.js";
import { projectName } from "../projectName.js";

type Tab = "all" | "todos";
const TABS: [Tab, string, LucideIcon][] = [
  ["all", "Memory", NotebookText],
  ["todos", "To-dos", ListTodo],
];

type RowProps = { m: MemoryInfo; ions: IonInfo[]; client: IonClient; run: Run; onOpen: () => void };

/**
 * A memory file: its type, name (a chat's preference says Suggested, with Keep), description, who changed it last
 * and when; your own files have Shared with chats. Clicking it opens its text.
 */
function MemoryRow({ m, ions, client, run, onOpen }: RowProps) {
  const share = (on: boolean) =>
    run(client.call("memory.read", { name: m.memoryId }), (f) =>
      run(client.call("memory.write", { path: m.memoryId, see: on ? "chats" : "ions", expect: f.hash })),
    );
  return (
    <div className="trow mrow2" onClick={onOpen}>
      <TypeIcon m={m} />
      <div>
        {/* A click (or Enter) here reaches the row, which opens it: once. */}
        <button type="button" className="tname lnk">
          {m.name}
        </button>
        {m.suggested && <span className="chip">Suggested</span>}
        {tidiedByIon(m) && <span className="chip">Tidied by ion</span>}
        <div className="s">
          {/* A to-do's description is often its name: said once. */}
          {m.description !== m.name && <span className="clamp">{m.description}</span>}
          <span className="mby">{`${whoOf(m, ions)} · ${relTime(m.writtenAt)}`}</span>
        </div>
      </div>
      <span className="hsup" />
      {/* The row opens its text; its own controls don't. */}
      <div className="acts2" onClick={(e) => e.stopPropagation()}>
        {m.suggested && (
          <button
            className="btn"
            type="button"
            onClick={() => run(client.call("memory.keep", { path: m.memoryId }))}
          >
            Keep
          </button>
        )}
        {sharable(m) && (
          // What the switch shares, as an icon named on hover (task review, 2026-11-22).
          <span className="msee" title="Shared with chats">
            <MessagesSquare />
            <Switch label="Shared with chats" on={m.see === "chats"} onPick={share} />
          </span>
        )}
      </div>
    </div>
  );
}

/** You, then each project: whose files the list shows. */
function Scopes(p: { scope: string; data: SettingsData; onPick: (s: string) => void }) {
  const all = [["you", "You"], ...p.data.projects.map((x) => [x.id, projectName(x.id, x.name)])] as const;
  return (
    <div className="mscope" role="group" aria-label="Whose">
      {all.map(([id, name]) => (
        <button
          key={id}
          type="button"
          className={`chip tog${p.scope === id ? " on" : ""}`}
          aria-pressed={p.scope === id}
          onClick={() => p.onPick(id)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/**
 * Off everywhere, the projects you kept on, in one quiet line ("On in Shop, Notes"; review of #34, 2026-11-23).
 */
function StillOn({ data }: { data: SettingsData }) {
  const m = data.settings?.memory;
  if (!m || m.on) return null;
  const on = data.projects.filter((x) => m.projects[x.id]).map((x) => x.name ?? x.id);
  return on.length ? <span className="when">{`On in ${on.join(", ")}`}</span> : null;
}

/**
 * Remember: memory on or off, everywhere (`projectId` absent; yours follow it) or in one project (the user,
 * 2026-11-23). Off, agents and ions get none and nothing new is written; the files stay here.
 */
function RememberRow(p: {
  data: SettingsData;
  client: IonClient;
  run: Run;
  projectId?: string;
  name?: string;
  /** The last line of its group (yours: More). */
  children?: ReactNode;
}) {
  const m = p.data.settings?.memory;
  if (!m) return null;
  const on = p.projectId === undefined ? m.on : (m.projects[p.projectId] ?? m.on);
  const set = (to: boolean) => {
    const memory = p.projectId === undefined ? { on: to } : { projects: { [p.projectId]: to } };
    p.run(p.client.call("settings.set", { patch: { memory } }), () => p.data.reload());
  };
  return (
    <div className="group">
      <div className="srow">
        <div className="g">
          <span className="slot">
            <NotebookText />
            Remember
          </span>
        </div>
        {p.projectId === undefined && <StillOn data={p.data} />}
        <Switch label={p.name ? `Remember ${p.name}` : "Remember"} on={on} onPick={set} />
      </div>
      {p.children}
    </div>
  );
}

/** Remember; Tidy memory under its More until it's on or has tidied once (Plan 21 Task 4); what it tidied. */
function RememberAndTidy(p: Pick<ListProps, "mem" | "data" | "client" | "run">) {
  const [more, setMore] = useState(false);
  const tidyUsed = (p.data.settings?.dream?.mode ?? "off") !== "off" || !!p.mem.tidied;
  return (
    <>
      <RememberRow data={p.data} client={p.client} run={p.run}>
        {!tidyUsed && <More open={more} onOpen={setMore} />}
      </RememberRow>
      {(more || tidyUsed) && <DreamRow client={p.client} data={p.data} run={p.run} />}
      <Tidied tidied={p.mem.tidied} client={p.client} run={p.run} />
    </>
  );
}

/**
 * Remember, then Tidy memory and what it tidied (under More until used), then your files or a project's (You, then
 * each project), searched by words; a row opens its text.
 */
type Filter = { scope: string; q: string };
type ListProps = {
  mem: MemoryData;
  data: SettingsData;
  client: IonClient;
  run: Run;
  onOpen: (path: string) => void;
  /** Whose and which words (kept while a file is open, so Back returns to them). */
  filter: Filter;
  setFilter: (f: Filter) => void;
};

function MemoryList(p: ListProps) {
  const { scope, q } = p.filter;
  const setScope = (s: string) => p.setFilter({ ...p.filter, scope: s });
  const setQ = (w: string) => p.setFilter({ ...p.filter, q: w });
  const found = useSearch(p.client, q, scope, p.mem.files);
  const shown = (found ?? p.mem.files).filter((m) => scopeOf(m) === scope);
  const project = p.data.projects.find((x) => x.id === scope);
  return (
    <>
      <RememberAndTidy mem={p.mem} data={p.data} client={p.client} run={p.run} />
      <Scopes scope={scope} data={p.data} onPick={setScope} />
      {project && (
        <RememberRow
          data={p.data}
          client={p.client}
          run={p.run}
          projectId={project.id}
          name={project.name ?? project.id}
        />
      )}
      <input
        className="fin msearch"
        type="search"
        placeholder="Search"
        aria-label="Search memory"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {shown.length ? (
        <div className="group">
          {shown.map((m) => (
            <MemoryRow
              key={m.memoryId}
              m={m}
              ions={p.data.ions}
              client={p.client}
              run={p.run}
              onOpen={() => p.onOpen(m.memoryId)}
            />
          ))}
        </div>
      ) : (
        <Nothing text={found ? "Nothing found" : "No memory"} />
      )}
    </>
  );
}

/** A call that failed, then each file that can't be read: one plain line each. */
const Lines = ({ lines }: { lines: string[] }) =>
  lines.map((line) => (
    <div className="perr" key={line}>
      {line}
    </div>
  ));

/**
 * Settings → Memory, as the lab's renderMemory: ion's memory files, yours and each project's, with search; a row opens
 * its text (Open, History, Forget). To-dos: yours and every project's. `at`: opened at the to-dos (ion chief's count).
 */
export function Memory({
  client,
  data,
  at,
}: {
  client: IonClient;
  data: SettingsData;
  at?: SettingsAt | null;
}) {
  const mem = useMemory(client);
  const [tab, setTab] = useState<Tab>(at?.kind === "todos" ? "todos" : "all");
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>({ scope: "you", q: "" });
  const [cantOpen, setCantOpen] = useState(false);
  const [error, run] = useCallError();
  if (open)
    return (
      <MemoryFile
        client={client}
        path={open}
        folder={mem.folder?.path ?? null}
        ions={data.ions}
        onBack={() => setOpen(null)}
      />
    );
  return (
    <div>
      <div className="tabs2">
        <IconTabs label="Memory" tabs={TABS} tab={tab} onPick={setTab} />
        {mem.folder && (
          <OpenPath path={mem.folder.path} name="Open memory folder" icon={FolderOpen} onFail={setCantOpen} />
        )}
      </div>
      <Lines lines={[...(error || cantOpen ? [error ?? CANT_OPEN] : []), ...(mem.folder?.problems ?? [])]} />
      {tab === "todos" ? (
        <MemoryTodos files={mem.files} projects={data.projects} client={client} run={run} />
      ) : (
        <MemoryList
          mem={mem}
          data={data}
          client={client}
          run={run}
          onOpen={setOpen}
          filter={filter}
          setFilter={setFilter}
        />
      )}
    </div>
  );
}
