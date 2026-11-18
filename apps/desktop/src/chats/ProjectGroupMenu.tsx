import { Ellipsis, FolderMinus, Pencil } from "@ion/design-system";
import { type KeyboardEvent, useRef, useState } from "react";
import { useDismiss } from "./dismiss.js";

export type ProjectActions = {
  onRenameProject: (projectId: string, name: string) => void;
  onRemoveProject: (projectId: string) => void;
};

/** The project's name in an input, saved on Enter or when you leave it; Escape leaves it as it was. */
export function ProjectRename(p: { name: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(p.name);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") p.onDone(name);
    if (e.key === "Escape") p.onDone(null);
  };
  return (
    // biome-ignore lint/a11y/noAutofocus: renaming starts in the box you asked for
    <input
      className="grename"
      aria-label="Project name"
      value={name}
      autoFocus
      onChange={(e) => setName(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => p.onDone(name)}
    />
  );
}

/** Remove, asked twice: the second click names the project. */
function RemoveItem(p: { name: string; sure: boolean; onAsk: () => void; onRemove: () => void }) {
  return p.sure ? (
    <button type="button" role="menuitem" className="danger" onClick={p.onRemove}>
      <FolderMinus />
      Remove {p.name}
    </button>
  ) : (
    <button type="button" role="menuitem" onClick={p.onAsk}>
      <FolderMinus />
      Remove
    </button>
  );
}

/** A project group's menu: Rename, and Remove (asked twice: its chats are archived; its folder stays). */
export function ProjectGroupMenu(p: { name: string; onRename: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setSure(false);
  };
  useDismiss(open, wrap, close);
  return (
    <div className="rmore gmore" ref={wrap}>
      <button className="ib" type="button" aria-label={`More for ${p.name}`} onClick={() => setOpen(!open)}>
        <Ellipsis />
      </button>
      {open && (
        <div className="pmenu rmenu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              p.onRename();
            }}
          >
            <Pencil />
            Rename
          </button>
          <RemoveItem
            name={p.name}
            sure={sure}
            onAsk={() => setSure(true)}
            onRemove={() => {
              close();
              p.onRemove();
            }}
          />
        </div>
      )}
    </div>
  );
}
