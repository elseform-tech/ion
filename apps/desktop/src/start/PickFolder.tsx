import { ApiCallError } from "@ion/client/browser";
import { Folder, FolderOpen, Info } from "@ion/design-system";
import type { ProjectInfo } from "@ion/schema";
import { open } from "@tauri-apps/plugin-dialog";
import { type KeyboardEvent, useState } from "react";
import { why } from "../callError.js";

/** A folder ion added: `gitSetUp` when it set up git there first (the files in its first commit; how many were left out). */
export type Added = ProjectInfo & { gitSetUp?: { files: number; left: number } };
/** Adds a folder (`projects.add`); `confirm`: you said yes to ion's question. */
export type AddFolderFn = (path: string, confirm?: boolean) => Promise<Added>;

const inTauri = () => "__TAURI_INTERNALS__" in window;

/** The system's folder picker (the app); null when you cancel it. */
async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: "Pick a folder" });
  return typeof picked === "string" ? picked : null;
}

/** ion's git setup in one line: the files in its first commit, and that some were left out. */
function setUpLine(s: { files: number; left: number }): string {
  const files = `${s.files} ${s.files === 1 ? "file" : "files"}`;
  const left = s.left ? `, ${s.left} left out (secrets, dependencies, build output, big files)` : "";
  return `Git set up: ${files} in its first commit${left}`;
}

/** ion's question before it sets up git (or adds the repo a folder is in), with its path. */
type Asking = { question: string; path: string };

/**
 * Adding a folder: a typed path (a browser), the folder picker (the app), ion's question and your yes (review of Plan
 * 21 Task 2, 2026-11-23: git was set up without asking), while it works, what was added, and why it wasn't.
 */
function useAddFolder(add: AddFolderFn, onAdded: (p: Added) => void) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [working, setWorking] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  const go = (p: string, confirm = false) => {
    setWorking(confirm);
    setAsking(null);
    return add(p, confirm)
      .then(
        (r) => {
          setAdded(r);
          setError(null);
          setPath("");
          onAdded(r);
        },
        (e: unknown) =>
          e instanceof ApiCallError && e.code === "confirm"
            ? setAsking({ question: e.message, path: p })
            : setError(why(e)),
      )
      .finally(() => setWorking(false));
  };
  const browse = () =>
    void pickFolder().then(
      (p) => (p ? go(p) : undefined),
      () => setError("Couldn't open the folder picker"),
    );
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && path.trim()) void go(path.trim());
  };
  const edit = (t: string) => {
    setPath(t);
    setError(null);
  };
  const yes = () => asking && void go(asking.path, true);
  const clear = () => setAdded(null);
  return { path, edit, error, added, browse, onKey, asking, working, yes, no: () => setAsking(null), clear };
}

/** What adding a folder says under it: ion's question, that it's working, or what it set up. */
function Status({ f }: { f: ReturnType<typeof useAddFolder> }) {
  if (f.working)
    return (
      <div className="fwait">
        <i className="spin" />
        Setting up git…
      </div>
    );
  if (f.asking) {
    const setUp = f.asking.question.startsWith("Set up git");
    return (
      <div className="hsign">
        <span className="g">{f.asking.question}</span>
        <button className="btn" type="button" onClick={f.no}>
          Cancel
        </button>
        <button className="btn pri" type="button" onClick={f.yes}>
          {setUp ? "Set up git" : "Add repo"}
        </button>
      </div>
    );
  }
  if (!f.added?.gitSetUp) return null;
  return (
    <div className="quiet">
      <Info />
      {setUpLine(f.added.gitSetUp)}
    </div>
  );
}

/**
 * Pick a folder of yours (Plan 21 audit, 2026-11-23: the app couldn't add one; only `ion projects add` could): the
 * system's folder picker in the app, a typed path in a browser. One that isn't a git repo gets ion's git setup once
 * you say yes, said in one line.
 */
export function PickFolder({ add, onAdded }: { add: AddFolderFn; onAdded: (p: Added) => void }) {
  const f = useAddFolder(add, onAdded);
  return (
    <>
      <div className="ffolder">
        {inTauri() ? (
          <button className="btn" type="button" onClick={f.browse}>
            <FolderOpen />
            Pick a folder
          </button>
        ) : (
          <input
            className="fin"
            aria-label="Folder"
            placeholder="Folder path"
            value={f.path}
            onChange={(e) => f.edit(e.target.value)}
            onKeyDown={f.onKey}
          />
        )}
        {f.added && (
          <span className="chip">
            <Folder />
            {f.added.name ?? f.added.id}
          </span>
        )}
        {f.error && <div className="perr">{f.error}</div>}
      </div>
      <Status f={f} />
    </>
  );
}

/**
 * The project menu's Add folder (beside New project): the folder picker in the app; in a browser, a path typed in
 * its place. ion's question and its git setup are said under it.
 */
export function AddFolder({ add, onAdded }: { add: AddFolderFn; onAdded: (p: Added) => void }) {
  const f = useAddFolder(add, onAdded);
  const [typing, setTyping] = useState(false);
  // Typing until ion asks, works or has added it; then what it says.
  if (typing && !inTauri() && !f.asking && !f.working && !f.added)
    return (
      <div className="pmi pnew">
        <FolderOpen />
        {/* biome-ignore lint/a11y/noAutofocus: typing starts in the box you asked for */}
        <input
          aria-label="Folder"
          placeholder="Folder path"
          autoFocus
          value={f.path}
          onChange={(e) => f.edit(e.target.value)}
          onKeyDown={(e) => (e.key === "Escape" ? setTyping(false) : f.onKey(e))}
        />
        {f.error && <div className="perr">{f.error}</div>}
      </div>
    );
  return (
    <>
      <button
        type="button"
        className="pnew"
        onClick={() => {
          f.clear();
          if (inTauri()) f.browse();
          else setTyping(true);
        }}
      >
        <FolderOpen />
        Add folder
      </button>
      {f.error && <div className="perr">{f.error}</div>}
      <Status f={f} />
    </>
  );
}
