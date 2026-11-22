import type { IonClient } from "@ion/client/browser";
import { FolderOpen, ListTodo, type LucideIcon, MessagesSquare, NotebookText } from "@ion/design-system";
import type { IonInfo, MemoryInfo } from "@ion/schema";
import { useState } from "react";
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
import { OpenPath } from "./OpenPath.js";
import { Switch } from "./Switch.js";

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
  const all = [["you", "You"], ...p.data.projects.map((x) => [x.id, x.name ?? x.id])] as const;
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
 * Dream and what it tidied, then your files or a project's (You, then each project), searched by words; a row opens
 * its text.
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
  return (
    <>
      <DreamRow client={p.client} data={p.data} run={p.run} />
      <Tidied tidied={p.mem.tidied} client={p.client} run={p.run} />
      <Scopes scope={scope} data={p.data} onPick={setScope} />
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
