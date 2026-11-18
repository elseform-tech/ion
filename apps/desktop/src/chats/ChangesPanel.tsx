import type { IonClient } from "@ion/client/browser";
import type { FileDiff } from "@ion/schema";
import { useEffect, useState } from "react";

/** The CSS class for one line of a patch: added, removed, a hunk header, or file headers (hidden). */
function lineClass(line: string): string | null {
  if (line.startsWith("diff --git") || line.startsWith("index ") || /^(---|\+\+\+) /.test(line)) return null;
  if (line.startsWith("new file mode") || line.startsWith("deleted file mode")) return null;
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-ctx";
}

function File({ f }: { f: FileDiff }) {
  const lines = f.patch.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
  return (
    <section className="diff-file">
      <header className="diff-head">
        <span className="diff-path">{f.path}</span>
        <span className="diff-counts">
          <span className="diff-plus">+{f.added}</span> <span className="diff-minus">−{f.removed}</span>
        </span>
      </header>
      <pre className="diff-body">
        {lines.map((l, i) => {
          const cls = lineClass(l);
          return cls ? (
            <div key={i} className={cls}>
              {l}
            </div>
          ) : null;
        })}
        {f.truncated && <div className="diff-hunk">Too long to show in full</div>}
      </pre>
    </section>
  );
}

/**
 * What the chat changed in its worktree (its own branch, new files included). `version` changes whenever the
 * chat does something, and the changes are read again.
 */
export function ChangesPanel({
  client,
  chatId,
  version,
}: {
  client: IonClient;
  chatId: string;
  version: number;
}) {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  useEffect(() => {
    let live = true;
    void client.call("chat.diff", { chatId }).then(
      (r) => live && setFiles(r.files),
      () => live && setFiles([]),
    );
    return () => {
      live = false;
    };
  }, [client, chatId, version]);
  return (
    <aside className="changes" aria-label="Changes">
      {files?.length === 0 && <div className="changes-empty">No changes yet</div>}
      {files?.map((f) => (
        <File key={f.path} f={f} />
      ))}
    </aside>
  );
}
