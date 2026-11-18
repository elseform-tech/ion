import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { FileDiff } from "@ion/schema";
import { File as FileIcon, FolderOpen, FolderTree, GitCompare } from "@ion/design-system";
import { Fragment, memo, useEffect, useRef, useState } from "react";
import { diffLines, fileMark, treeOf } from "./diffLines.js";

const SETTLE_MS = 500;

/** One file in the lab's Changes: its header (path, +added, −removed), then its numbered lines. */
const File = memo(function File({ f }: { f: FileDiff }) {
  return (
    <section>
      <div className="fh">
        <span>{f.path}</span>
        <span className="sp" />
        <span className="plus">+{f.added}</span>
        <span className="minus">−{f.removed}</span>
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
function Tree({ files }: { files: FileDiff[] }) {
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
            const mark = marks.get(g.folder ? `${g.folder}/${name}` : name)!;
            return (
              <div key={name} style={g.folder ? { paddingLeft: 26 } : undefined}>
                <FileIcon />
                {name}
                <span className="x" style={{ color: MARK_COLOR[mark] }}>
                  {mark}
                </span>
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

type Tab = "diff" | "files";

/** The lab's .ttabs: Changes and Files. */
function Tabs({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
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
    </div>
  );
}

/** The chat's changes: read when it opens, then again once a burst of edits settles. */
function useDiff(client: IonClient, chatId: string, version: number) {
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
  return { diff, error };
}

/**
 * What the chat changed in its worktree (its own branch, new files included). `version` changes whenever the
 * chat does something, and the changes are read again.
 */
export function ToolsPanel({
  client,
  chatId,
  version,
}: {
  client: IonClient;
  chatId: string;
  version: number;
}) {
  const { diff, error } = useDiff(client, chatId, version);
  const [tab, setTab] = useState<Tab>("diff");
  const omitted = diff?.omitted ?? 0;
  const files = diff?.files ?? [];
  return (
    <aside className="tools" aria-label="Changes">
      <Tabs tab={tab} onTab={setTab} />
      <div className="panel">
        {error && <div className="changes-empty">{error}</div>}
        {tab === "diff" && files.length > 0 && (
          <div className="code">
            {files.map((f) => (
              <File key={f.path} f={f} />
            ))}
          </div>
        )}
        {tab === "files" && files.length > 0 && <Tree files={files} />}
        {omitted > 0 && <div className="changes-empty">{omitted} more files not shown</div>}
      </div>
    </aside>
  );
}
