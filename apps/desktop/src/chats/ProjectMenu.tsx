import { Check, ChevronsUpDown, Folder, FolderPlus, Layers, Search, Star } from "@ion/design-system";
import type { NeedInfo, ProjectInfo } from "@ion/schema";
import { type KeyboardEvent, useRef, useState } from "react";
import { useDismiss } from "./dismiss.js";

type Pick = { project: string | null; onPick: (id: string | null) => void };

/** The lab's .pml: All projects (unless searching), then starred projects first, each with its waiting count. */
function ProjectList({
  projects,
  needs,
  q,
  project,
  onPick,
}: Pick & { projects: ProjectInfo[]; needs: NeedInfo[]; q: string }) {
  const list = [...projects]
    .sort((a, b) => Number(b.starred) - Number(a.starred))
    .filter((x) => !q.trim() || x.id.includes(q.trim().toLowerCase()));
  return (
    <div className="pml">
      {!q.trim() && (
        <button type="button" className={project === null ? "on" : ""} onClick={() => onPick(null)}>
          <Layers />
          All projects
          {project === null && <Check className="ck" />}
        </button>
      )}
      {list.map((x) => {
        const waiting = needs.filter((n) => n.projectId === x.id).length;
        return (
          <button
            type="button"
            key={x.id}
            className={x.id === project ? "on" : ""}
            onClick={() => onPick(x.id)}
          >
            {x.starred ? <Star className="stari" /> : <Folder />}
            {x.id}
            {waiting > 0 && <span className="nb">{waiting}</span>}
            {x.id === project && <Check className="ck" />}
          </button>
        );
      })}
      {list.length === 0 && <div className="pempty">No project matches</div>}
    </div>
  );
}

/** The lab's project menu: find a project, or show all. */
/** The project menu's find field. */
const FindProject = ({ q, onQ }: { q: string; onQ: (q: string) => void }) => (
  <div className="pmi">
    <Search />
    <input
      type="text"
      placeholder="Find a project"
      aria-label="Find a project"
      autoComplete="off"
      value={q}
      onChange={(e) => onQ(e.target.value)}
    />
  </div>
);

/** "New project": a name, made with Enter (ion makes the folder under your projects folder). */
function NewProject({ onNew }: { onNew: (name: string) => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  if (!naming)
    return (
      <button type="button" className="pnew" onClick={() => setNaming(true)}>
        <FolderPlus />
        New project
      </button>
    );
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") setNaming(false);
    if (e.key !== "Enter" || !name.trim()) return;
    onNew(name.trim());
    setNaming(false);
    setName("");
  };
  return (
    <div className="pmi pnew">
      <FolderPlus />
      {/* biome-ignore lint/a11y/noAutofocus: naming starts in the box you asked for */}
      <input
        aria-label="Project name"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKey}
      />
    </div>
  );
}

export function ProjectMenu(
  p: Pick & { projects: ProjectInfo[]; needs: NeedInfo[]; onNew: (name: string) => void },
) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setQ("");
  };
  useDismiss(open, wrap, close);
  return (
    <div className="pwrap" ref={wrap}>
      <button
        className="proj"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="projLbl">{p.project ?? "All projects"}</span>
        <ChevronsUpDown />
      </button>
      <div className="pmenu" hidden={!open}>
        <FindProject q={q} onQ={setQ} />
        <ProjectList
          projects={p.projects}
          needs={p.needs}
          q={q}
          project={p.project}
          onPick={(id) => {
            p.onPick(id);
            close();
          }}
        />
        <NewProject
          onNew={(name) => {
            p.onNew(name);
            close();
          }}
        />
      </div>
    </div>
  );
}
