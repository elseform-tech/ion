import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { FileDiff } from "@ion/schema";
import { Cpu, Eye, File as FileIcon, FolderOpen, FolderTree, GitCompare } from "@ion/design-system";
import { InChat, useArtifacts } from "./Artifacts.js";
import { Preview, Tasks } from "./Preview.js";
import { Fragment, memo, useEffect, useRef, useState } from "react";
import { diffLines, fileMark, treeOf } from "./diffLines.js";
import { Resizer } from "./Resizer.js";

const SETTLE_MS = 500;

/** A chat's changes as read: null until the first read. */
export type Changes = {
  diff: { files: FileDiff[]; omitted?: number } | null;
  error: string | null;
  /** The version they were read for: the preview reads its file again when it moves. */
  version?: number;
};

const fileId = (path: string) => `file-${encodeURIComponent(path)}`;

/** One file in the lab's Changes: its header (path, +added, −removed), then its numbered lines. */
const File = memo(function File({ f }: { f: FileDiff }) {
  return (
    <section id={fileId(f.path)}>
      <div className="fh">
        <span>{f.path}</span>
        <span className="sp" />
        {f.added > 0 && <span className="plus">+{f.added}</span>}
        {f.removed > 0 && <span className="minus">−{f.removed}</span>}
      </div>
      {diffLines(f.patch).map((l, i) => (
        <div key={i} className={`ln ${l.kind}`}>
          <span className="n">{l.n}</span>
          <span className="s">{l.sign}</span>
          <span>{l.text}</span>
        </div>
      ))}
      {f.truncated && <div className="ln h">Too long to show in full</div>}
    </section>
  );
});

const MARK_COLOR: Record<string, string | undefined> = { A: "var(--good)" };

/** The lab's Files tab: the changed files by folder, each with its mark. */
function Tree({ files, onPick }: { files: FileDiff[]; onPick?: (path: string) => void }) {
  const marks = new Map(files.map((f) => [f.path, fileMark(f.patch)]));
  return (
    <div className="tree">
      <div className="lh2">Changed files</div>
      {treeOf(files.map((f) => f.path)).map((g) => (
        <Fragment key={g.folder}>
          {g.folder && (
            <div>
              <FolderOpen />
              {g.folder}
            </div>
          )}
          {g.files.map((name) => {
            const path = g.folder ? `${g.folder}/${name}` : name;
            const mark = marks.get(path)!;
            // A file opens in the preview (when there's a chat to read it from).
            return (
              <button
                type="button"
                key={name}
                className="trow2"
                disabled={!onPick}
                style={g.folder ? { paddingLeft: 26 } : undefined}
                onClick={() => onPick?.(path)}
              >
                <FileIcon />
                {name}
                <span className="x" style={{ color: MARK_COLOR[mark] }}>
                  {mark}
                </span>
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

type Tab = "diff" | "files" | "preview" | "tasks";

/** The lab's .ttabs: Changes and Files; with a chat, also Preview and Tasks (what's running, with PIDs). */
function Tabs({ tab, onTab, live }: { tab: Tab; onTab: (t: Tab) => void; live: boolean }) {
  const one = (t: Tab, title: string, Icon: typeof GitCompare) => (
    <button
      className={`ib${tab === t ? " on" : ""}`}
      type="button"
      role="tab"
      aria-selected={tab === t}
      aria-label={title}
      title={title}
      onClick={() => onTab(t)}
    >
      <Icon />
    </button>
  );
  return (
    <div className="ttabs" role="tablist" aria-label="Panel">
      {one("diff", "Changes", GitCompare)}
      {one("files", "Files", FolderTree)}
      {live && one("preview", "Preview", Eye)}
      {live && one("tasks", "Tasks", Cpu)}
    </div>
  );
}

/** The chat's changes: read when it opens, then again once a burst of edits settles. */
export function useDiff(client: IonClient, chatId: string, version: number): Changes {
  const [diff, setDiff] = useState<{ files: FileDiff[]; omitted?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void client.call("chat.diff", { chatId }).then(
        (r) => {
          if (!live) return;
          setDiff(r);
          setError(null);
        },
        (e: unknown) => live && setError(e instanceof ApiCallError ? e.message : "Couldn't read the changes"),
      );
    // At once when a chat opens; after that, once a burst of edits has settled.
    const opening = shown.current !== chatId;
    shown.current = chatId;
    const timer = opening ? undefined : setTimeout(read, SETTLE_MS);
    if (opening) read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, chatId, version]);
  return { diff, error, version };
}

/**
 * What the chat changed in its worktree (its own branch, new files included). `version` changes whenever the
 * chat does something, and the changes are read again.
 */
/** A file picked in the conversation; `n` counts picks, so each one scrolls (once). */
export type Focus = { path: string; n: number };

/** Shows the Changes tab scrolled to a picked file, once per pick (waiting for the first read if need be). */
function useFocus(focus: Focus | null | undefined, loaded: boolean, setTab: (t: Tab) => void): void {
  const done = useRef(0);
  useEffect(() => {
    if (!focus || !loaded || focus.n === done.current) return;
    done.current = focus.n;
    setTab("diff");
    document.getElementById(fileId(focus.path))?.scrollIntoView?.({ block: "start" });
  }, [focus, loaded, setTab]);
}

type PanelProps = Changes & {
  focus?: Focus | null;
  /** The chat, for the Preview and Tasks tabs. */
  client?: IonClient;
  chatId?: string;
};

type ChatTabsProps = { tab: Tab; client: IonClient; chatId: string; files: FileDiff[]; pick: string | null };

/**
 * The chat's own tabs: a file as it is (the one picked, else the first the chat didn't delete), and what's still
 * running in its worktree.
 */
function ChatTabs(p: ChatTabsProps & { version?: number }) {
  const deleted = (path: string) => p.files.some((f) => f.path === path && fileMark(f.patch) === "D");
  const path = p.pick ?? p.files.find((f) => !deleted(f.path))?.path ?? null;
  if (p.tab === "preview")
    return (
      <Preview
        client={p.client}
        chatId={p.chatId}
        path={path}
        deleted={path !== null && deleted(path)}
        {...(p.version !== undefined ? { version: p.version } : {})}
      />
    );
  if (p.tab === "tasks") return <Tasks client={p.client} chatId={p.chatId} />;
  return null;
}

/** The changes, as a diff or as a tree whose files open in the preview. */
function ChangeTabs(p: {
  tab: Tab;
  files: FileDiff[];
  /** The changes have been read and there's nothing else to show: an empty list then says "No changes". */
  read: boolean;
  onPick: ((path: string) => void) | undefined;
}) {
  const quiet = p.read && (p.tab === "diff" || p.tab === "files");
  if (!p.files.length) return quiet ? <div className="changes-empty">No changes</div> : null;
  if (p.tab === "diff")
    return (
      <div className="code">
        {p.files.map((f) => (
          <File key={f.path} f={f} />
        ))}
      </div>
    );
  if (p.tab === "files") return <Tree files={p.files} {...(p.onPick ? { onPick: p.onPick } : {})} />;
  return null;
}

export function ToolsPanel({ diff, error, focus, client, chatId, version }: PanelProps) {
  const [tab, setTab] = useState<Tab>("diff");
  const [pick, setPick] = useState<string | null>(null);
  useFocus(focus, diff !== null, setTab);
  const omitted = diff?.omitted ?? 0;
  const files = diff?.files ?? [];
  const chat = client && chatId ? { client, chatId } : null;
  // What the chat made that isn't among its changes (screenshots, builds), kept while you're on other tabs.
  const made = useArtifacts(client, chatId, tab === "files", files);
  const inChat = tab === "files" && made.length > 0;
  const open = (path: string) => {
    setPick(path);
    setTab("preview");
  };
  return (
    <aside className="tools" aria-label="Changes">
      <Resizer name="--tools-w" label="Panel width" initial={400} min={300} max={760} edge="left" />
      <Tabs tab={tab} onTab={setTab} live={chat !== null} />
      <div className="panel">
        {error && <div className="changes-empty">{error}</div>}
        {inChat && <InChat made={made} onOpen={open} />}
        <ChangeTabs
          tab={tab}
          files={files}
          read={diff !== null && !error && !inChat}
          onPick={chat ? open : undefined}
        />
        {chat && <ChatTabs tab={tab} {...chat} files={files} pick={pick} version={version} />}
        {omitted > 0 && <div className="changes-empty">{omitted} more files not shown</div>}
      </div>
    </aside>
  );
}
