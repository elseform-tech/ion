import type { IonClient } from "@ion/client/browser";
import { ChevronLeft, FilePen, History } from "@ion/design-system";
import type { IonInfo, MemoryChangeInfo, MemoryFileInfo } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";
import { useCallError } from "../callError.js";
import { Markdown } from "../chats/Message.js";
import { relTime } from "../chats/live.js";
import { CANT_OPEN } from "../opener.js";
import { whoOf } from "./memory-data.js";
import { ForgetAsk, ForgetButton, IconButton, TypeIcon } from "./memory-parts.js";
import { OpenPath } from "./OpenPath.js";

type Props = {
  client: IonClient;
  path: string;
  /** The memory folder, for Open. */
  folder: string | null;
  ions: IonInfo[];
  onBack: () => void;
};

/** Each change, newest first: who and when; an older text has Restore (written back as you, over this version). */
function HistoryList(p: {
  changes: MemoryChangeInfo[];
  now: string;
  ions: IonInfo[];
  onRestore: (text: string) => void;
}) {
  return (
    <div>
      <h4>History</h4>
      <div className="group">
        {p.changes.map((c, i) => (
          <div className="srow" key={`${c.at}-${i}`}>
            <div className="g">
              {whoOf(c, p.ions)}
              {c.kind === "forgotten" && <span className="chip">Forgotten</span>}
            </div>
            <span className="when">{relTime(c.at)}</span>
            {i > 0 && c.text !== undefined && c.text !== p.now && (
              <button className="btn" type="button" onClick={() => p.onRestore(c.text!)}>
                Restore
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A file's type, name, and its controls: Open (in your editor), History, Forget. */
function FileHead(p: {
  file: MemoryFileInfo;
  folder: string | null;
  history: boolean;
  onHistory: () => void;
  onForget: () => void;
  onCantOpen: (failed: boolean) => void;
}) {
  const { file, folder } = p;
  return (
    <>
      <div className="mhead">
        <TypeIcon m={file} />
        <h3>{file.name}</h3>
        {folder && (
          <OpenPath path={`${folder}/${file.path}`} name="Open" icon={FilePen} onFail={p.onCantOpen} />
        )}
        <IconButton
          name={p.history ? "Hide history" : "History"}
          icon={History}
          on={p.history}
          onClick={p.onHistory}
        />
        <ForgetButton onClick={p.onForget} />
      </div>
      <div className="s">{file.description}</div>
    </>
  );
}

/** Back to the list. */
const Back = ({ onBack }: { onBack: () => void }) => (
  <button className="back" type="button" onClick={onBack}>
    <ChevronLeft />
    Memory
  </button>
);

/** A memory file opened from its row: its text, read-only, with Open (your editor), History and Forget. */
export function MemoryFile({ client, path, folder, ions, onBack }: Props) {
  const [file, setFile] = useState<MemoryFileInfo | null>(null);
  const [changes, setChanges] = useState<MemoryChangeInfo[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [cantOpen, setCantOpen] = useState(false);
  const [error, run] = useCallError();
  const load = useCallback(
    (withHistory: boolean) => {
      run(client.call("memory.read", { name: path }), setFile);
      if (withHistory) run(client.call("memory.history", { path }), setChanges);
    },
    [client, path, run],
  );
  useEffect(() => load(false), [load]);
  const restore = (text: string) =>
    file && run(client.call("memory.write", { path, text, expect: file.hash }), () => load(true));
  return (
    <>
      <Back onBack={onBack} />
      {file && (
        <FileHead
          file={file}
          folder={folder}
          history={!!changes}
          onHistory={() => (changes ? setChanges(null) : load(true))}
          onForget={() => setAsking(true)}
          onCantOpen={setCantOpen}
        />
      )}
      {(error || cantOpen) && <div className="perr">{error ?? CANT_OPEN}</div>}
      {asking && file && (
        <div className="group">
          <ForgetAsk
            name={file.name}
            onCancel={() => setAsking(false)}
            onForget={() => run(client.call("memory.forget", { memoryId: path }), onBack)}
          />
        </div>
      )}
      {file && (
        <div className="group mtext">
          <Markdown text={file.text} htmlAsText noImages />
        </div>
      )}
      {changes && file && <HistoryList changes={changes} now={file.text} ions={ions} onRestore={restore} />}
    </>
  );
}
