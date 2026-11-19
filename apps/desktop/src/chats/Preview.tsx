import type { IonClient } from "@ion/client/browser";
import { Square } from "@ion/design-system";
import type { FilePreview, TaskInfo } from "@ion/schema";
import { useEffect, useState } from "react";
import { why } from "../callError.js";

/** How often the Tasks tab reads again while it's open. */
const TASKS_MS = 3000;

/** What's still running in the chat's worktree, read again every few seconds while shown. */
function useTasks(client: IonClient, chatId: string): [TaskInfo[] | null, () => void] {
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () =>
      void client.call("chat.tasks", { chatId }).then(
        (t) => live && setTasks(t),
        () => {},
      );
    read();
    const timer = setInterval(read, TASKS_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, chatId, n]);
  return [tasks, () => setN((x) => x + 1)];
}

/** Background tasks: each one's command, PID, ports and how long it's run; Stop ends it. */
export function Tasks({ client, chatId }: { client: IonClient; chatId: string }) {
  const [tasks, again] = useTasks(client, chatId);
  const [error, setError] = useState<string | null>(null);
  const stop = (pid: number) =>
    void client.call("task.stop", { chatId, pid }).then(again, (e: unknown) => setError(why(e)));
  if (tasks?.length === 0) return <div className="changes-empty">Nothing running</div>;
  return (
    <div className="tasks">
      {error && <div className="changes-empty">{error}</div>}
      {tasks?.map((t) => (
        <div className="task" key={t.pid}>
          <div className="tc">{t.command}</div>
          {/* Where it runs, when that isn't the chat's worktree (the daemon says so). */}
          {t.where && <div className="tw">{t.where}</div>}
          <div className="tm">
            <span className="chip mono">PID {t.pid}</span>
            {t.ports.map((p) => (
              <span className="chip mono" key={p}>
                :{p}
              </span>
            ))}
            <span className="te">{t.elapsed}</span>
          </div>
          <button
            className="ib"
            type="button"
            aria-label={`Stop ${t.pid}`}
            title="Stop"
            onClick={() => stop(t.pid)}
          >
            <Square />
          </button>
        </div>
      ))}
    </div>
  );
}

type PreviewProps = {
  client: IonClient;
  chatId: string;
  path: string | null;
  /** The chat's changes moved: the file is read again. */
  version?: number;
  /** The chat deleted it: nothing to read. */
  deleted?: boolean;
};

/** The file as it is now: read when picked, and again each time the chat's changes move. */
function useFile({ client, chatId, path, version, deleted }: PreviewProps) {
  const [file, setFile] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFile(null);
    setError(null);
  }, [chatId, path]);
  useEffect(() => {
    if (!path || deleted) return;
    let live = true;
    void client.call("chat.file", { chatId, path }).then(
      (f) => {
        if (!live) return;
        setFile(f);
        setError(null);
      },
      (e: unknown) => live && setError(why(e)),
    );
    return () => {
      live = false;
    };
  }, [client, chatId, path, deleted, version]);
  return { file, error };
}

/** A file of the chat's worktree as it is: code and text, HTML rendered in a locked frame, an image. */
export function Preview(p: PreviewProps) {
  const { file, error } = useFile(p);
  const { path } = p;
  if (!path) return <div className="changes-empty">No files yet</div>;
  if (p.deleted) return <div className="changes-empty">Deleted</div>;
  if (error) return <div className="changes-empty">{error}</div>;
  if (!file) return null;
  return (
    <div className="preview">
      <div className="lh2">{file.path}</div>
      {file.kind === "text" && <pre className="code">{file.text}</pre>}
      {/* No scripts, forms or navigation: an agent's page is shown, never run. */}
      {file.kind === "html" && <iframe title={file.path} sandbox="" srcDoc={file.text} />}
      {file.kind === "image" && <img src={file.dataUrl} alt={file.path} />}
      {file.kind === "binary" && <div className="changes-empty">Can't preview this file</div>}
    </div>
  );
}
