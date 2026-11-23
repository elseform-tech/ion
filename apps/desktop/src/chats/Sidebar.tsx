import { ChevronDown, ChevronRight, Pin, SquarePen, Star } from "@ion/design-system";
import type { ChatInfo, IonInfo, NeedInfo, ProjectInfo } from "@ion/schema";
import { type ReactNode, useMemo, useState } from "react";
import { groupChats } from "./live.js";
import { type ProjectActions, ProjectGroupMenu, ProjectRename } from "./ProjectGroupMenu.js";
import { ProjectMenu } from "./ProjectMenu.js";
import type { AddFolderFn } from "../start/PickFolder.js";
import { ChatRow, NeedRow, type RowActions, type RowProps } from "./SidebarRows.js";

/** A project group shows this many chats until you ask for the rest. */
const SHOWN = 5;

type Fold = { folded: boolean; onToggle: () => void };
/** A group's star: on for a project you watch (kept open, listed first). */
type StarProps = { name: string; on: boolean; onStar: (on: boolean) => void };

function Group({
  label,
  count,
  fold,
  star,
  menu,
  editing,
  children,
}: {
  label: ReactNode;
  count?: number;
  fold?: Fold;
  star?: StarProps;
  /** The group's own menu (a project's Rename and Remove). */
  menu?: ReactNode;
  /** The label is a rename box: it stays out of the fold button. */
  editing?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grp">
      <div className="gl">
        {fold && !editing ? (
          <button type="button" className="gfold" aria-expanded={!fold.folded} onClick={fold.onToggle}>
            {fold.folded ? <ChevronRight /> : <ChevronDown />}
            {label}
          </button>
        ) : (
          <span>{label}</span>
        )}
        {count !== undefined && <span>{count}</span>}
        {star && (
          <button
            type="button"
            className={`ib star${star.on ? " on" : ""}`}
            title={`${star.on ? "Unstar" : "Star"} ${star.name}`}
            aria-label={`${star.on ? "Unstar" : "Star"} ${star.name}`}
            onClick={() => star.onStar(!star.on)}
          >
            <Star />
          </button>
        )}
        {menu}
      </div>
      {!fold?.folded && children}
    </div>
  );
}

/** Chats by project, the most recently active project first (the chats are newest first already). */
function byProject(chats: ChatInfo[]): { projectId: string; chats: ChatInfo[] }[] {
  const groups = new Map<string, ChatInfo[]>();
  for (const c of chats)
    groups.set(c.projectId ?? "default", [...(groups.get(c.projectId ?? "default") ?? []), c]);
  return [...groups].map(([projectId, list]) => ({ projectId, chats: list }));
}

/** A set kept for the window's life: which groups are folded, which show all their chats. */
function useToggles(): [Set<string>, (key: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setSet((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return [set, toggle];
}

type Props = {
  chats: ChatInfo[];
  needs: NeedInfo[];
  projects: ProjectInfo[];
  /** Each project's ion, for its avatar beside the threads it started. */
  ions?: IonInfo[];
  open: string | null;
  onOpen: (chatId: string | null) => void;
  /** Makes a project: its id, or a refusal (an Error with ion's words). */
  onNewProject: (name: string) => Promise<string>;
  /** Adds a folder of yours (Plan 21). */
  onAddFolder?: AddFolderFn;
  /** Star (watch) or unstar a project. */
  onStar: (projectId: string, starred: boolean) => void;
} & RowActions &
  ProjectActions;

const NEEDS_LABEL = (
  <span className="pinl">
    <Pin />
    Needs you
  </span>
);

/** A group header's parts. */
type Head = { label: ReactNode; editing?: boolean; star?: StarProps; menu?: ReactNode };

/** Each project group's header: its name (or the rename box), its star and its menu; `default` has neither. */
function useProjectHead(
  p: {
    starred: Set<string>;
    names: Map<string, string>;
    onStar: (projectId: string, on: boolean) => void;
  } & ProjectActions,
): [string | null, (projectId: string) => Head] {
  const [renaming, setRenaming] = useState<string | null>(null);
  const head = (projectId: string): Head => {
    const name = p.names.get(projectId) ?? projectId;
    if (projectId === "default") return { label: name };
    const done = (to: string | null) => {
      setRenaming(null);
      if (to?.trim() && to.trim() !== name) p.onRenameProject(projectId, to.trim());
    };
    return {
      label: renaming === projectId ? <ProjectRename name={name} onDone={done} /> : name,
      editing: renaming === projectId,
      star: { name, on: p.starred.has(projectId), onStar: (on: boolean) => p.onStar(projectId, on) },
      menu: (
        <ProjectGroupMenu
          name={name}
          onRename={() => setRenaming(projectId)}
          onRemove={() => p.onRemoveProject(projectId)}
        />
      ),
    };
  };
  return [renaming, head];
}

/**
 * Your chats grouped by project: the projects you watch (starred) first and open, the rest folded until you open
 * them (nothing is folded while no project is starred). Each group shows its 5 most recent chats until you ask.
 */
function ProjectGroups(
  p: {
    chats: ChatInfo[];
    starred: Set<string>;
    /** Each project's shown name (its id when not renamed). */
    names: Map<string, string>;
    onStar: (projectId: string, on: boolean) => void;
    row: (c: ChatInfo) => ReactNode;
  } & ProjectActions,
) {
  // What you've opened or folded yourself, against each group's default.
  const [flipped, flip] = useToggles();
  const [renaming, head] = useProjectHead(p);
  const [all, showAll] = useToggles();
  const watching = p.starred.size > 0;
  const groups = byProject(p.chats).sort(
    (a, b) => Number(p.starred.has(b.projectId)) - Number(p.starred.has(a.projectId)),
  );
  return (
    <>
      {groups.map(({ projectId, chats }) => {
        const folded = (watching && !p.starred.has(projectId)) !== flipped.has(projectId);
        const shown = all.has(projectId) ? chats : chats.slice(0, SHOWN);
        const more = chats.length - shown.length;
        return (
          <Group
            key={projectId}
            {...head(projectId)}
            fold={{ folded: folded && renaming !== projectId, onToggle: () => flip(projectId) }}
          >
            {shown.map(p.row)}
            {more > 0 && (
              <button type="button" className="more-rows" onClick={() => showAll(projectId)}>
                {more} more
              </button>
            )}
          </Group>
        );
      })}
    </>
  );
}

/** The sidebar's head: the project picker (with New project) and New chat. */
function SidebarHead(p: {
  projects: ProjectInfo[];
  needs: NeedInfo[];
  project: string | null;
  onPick: (id: string | null) => void;
  onNewProject: (name: string) => Promise<string>;
  onAddFolder: AddFolderFn | undefined;
  onOpen: (chatId: string | null) => void;
}) {
  const { projects, needs, project, onOpen } = p;
  const setProject = p.onPick;
  const onNewProject = p.onNewProject;
  return (
    <div className="shead">
      <ProjectMenu
        projects={projects}
        needs={needs}
        project={project}
        onPick={setProject}
        onNew={(name) =>
          onNewProject(name).then((id) => {
            // A new project has no chats yet: show it, with a new chat open in it.
            setProject(id);
            onOpen(null);
          })
        }
        {...(p.onAddFolder ? { onAddFolder: p.onAddFolder } : {})}
      />
      <button className="ib" type="button" title="New chat" onClick={() => onOpen(null)}>
        <SquarePen />
      </button>
    </div>
  );
}

/** Which projects are starred, and each one's shown name. */
function useProjectSets(projects: ProjectInfo[]) {
  const starred = useMemo(() => new Set(projects.filter((x) => x.starred).map((x) => x.id)), [projects]);
  const names = useMemo(() => new Map(projects.map((x) => [x.id, x.name ?? x.id])), [projects]);
  return { starred, names };
}

/** The lab's Chats sidebar: Needs you (pinned), Running (shimmering), then your chats by project. */
export function Sidebar(p: Props) {
  const { chats, needs, projects, ions = [], open, onOpen, onNewProject, onRename, onArchive, onStar } = p;
  const { starred, names } = useProjectSets(projects);
  const [project, setProject] = useState<string | null>(null);
  const g = useMemo(() => groupChats(chats, needs, project), [chats, needs, project]);
  const props = (c: ChatInfo): RowProps => {
    const ion = c.by === "ion" ? ions.find((x) => x.ionId === c.projectId) : undefined;
    return { chat: c, open: open === c.chatId, onOpen: () => onOpen(c.chatId), ...(ion ? { ion } : {}) };
  };
  const acts = { onRename, onArchive, onRemember: p.onRemember };
  const row = (c: ChatInfo) => <ChatRow key={c.chatId} {...props(c)} acts={acts} />;
  return (
    <>
      <SidebarHead
        {...{ projects, needs, project, onNewProject, onOpen }}
        onPick={setProject}
        onAddFolder={p.onAddFolder}
      />
      <div className="slist">
        {g.needsYou.length > 0 && (
          <Group label={NEEDS_LABEL} count={g.needsYou.length}>
            {g.needsYou.map(({ chat, need }) => (
              <NeedRow key={need.needId} {...props(chat)} need={need} />
            ))}
          </Group>
        )}
        {g.running.length > 0 && (
          <Group label="Running" count={g.running.length}>
            {g.running.map((c) => (
              <ChatRow key={c.chatId} {...props(c)} acts={acts} running />
            ))}
          </Group>
        )}
        {project ? (
          <Group label="Chats">{g.chats.map(row)}</Group>
        ) : (
          <ProjectGroups
            chats={g.chats}
            {...{ starred, names, onStar, row }}
            onRenameProject={p.onRenameProject}
            onRemoveProject={p.onRemoveProject}
          />
        )}
      </div>
    </>
  );
}
