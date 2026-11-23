import { Folder, FolderOpen, Info } from "@ion/design-system";
import type { ProjectInfo } from "@ion/schema";
import { open } from "@tauri-apps/plugin-dialog";
import { type KeyboardEvent, useState } from "react";
import { why } from "../callError.js";

/** A folder ion added: `gitSetUp` when it set up git there first. */
export type Added = ProjectInfo & { gitSetUp?: true };
/** Adds a folder (`projects.add`). */
export type AddFolderFn = (path: string) => Promise<Added>;

const inTauri = () => "__TAURI_INTERNALS__" in window;

/** The system's folder picker (the app); null when you cancel it. */
async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: "Pick a folder" });
  return typeof picked === "string" ? picked : null;
}

/** Adding a folder: a typed path (a browser), the folder picker (the app), what was added, and why it wasn't. */
function useAddFolder(add: AddFolderFn, onAdded: (p: Added) => void) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const go = (p: string) =>
    add(p).then(
      (r) => {
        setAdded(r);
        setError(null);
        setPath("");
        onAdded(r);
      },
      (e: unknown) => setError(why(e)),
    );
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
  return { path, edit, error, added, browse, onKey };
}

/** ion's git setup, in one line. */
const SetUp = () => (
  <div className="quiet">
    <Info />
    Set up git here: your files are its first commit
  </div>
);

/**
 * Pick a folder of yours (Plan 21 audit, 2026-11-23: the app couldn't add one; only `ion projects add` could): the
 * system's folder picker in the app, a typed path in a browser. One that isn't a git repo gets ion's git setup, said
 * in one line.
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
      {f.added?.gitSetUp && <SetUp />}
    </>
  );
}

/**
 * The project menu's Add folder (beside New project): the folder picker in the app; in a browser, a path typed in
 * its place. ion's git setup is said under it.
 */
export function AddFolder({ add, onAdded }: { add: AddFolderFn; onAdded: (p: Added) => void }) {
  const f = useAddFolder(add, onAdded);
  const [typing, setTyping] = useState(false);
  if (typing && !inTauri())
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
      <button type="button" className="pnew" onClick={() => (inTauri() ? f.browse() : setTyping(true))}>
        <FolderOpen />
        Add folder
      </button>
      {f.error && inTauri() && <div className="perr">{f.error}</div>}
      {f.added?.gitSetUp && <SetUp />}
    </>
  );
}
