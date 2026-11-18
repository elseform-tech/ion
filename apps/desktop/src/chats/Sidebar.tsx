import { ChevronDown, ChevronRight, Pin, SquarePen, Star } from "@ion/design-system";
import type { ChatInfo, IonInfo, NeedInfo, ProjectInfo } from "@ion/schema";
import { type ReactNode, useMemo, useState } from "react";
import { groupChats } from "./live.js";
import { ProjectMenu } from "./ProjectMenu.js";
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
  children,
}: {
  label: ReactNode;
  count?: number;
  fold?: Fold;
  star?: StarProps;
  children: ReactNode;
}) {
  return (
    <div className="grp">
      <div className="gl">
        {fold ? (
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
  onNewProject: (name: string) => void;
  /** Star (watch) or unstar a project. */
  onStar: (projectId: string, starred: boolean) => void;
} & RowActions;

const NEEDS_LABEL = (
  <span className="pinl">
    <Pin />
    Needs you
  </span>
);

/**
 * Your chats grouped by project: the projects you watch (starred) first and open, the rest folded until you open
 * them (nothing is folded while no project is starred). Each group shows its 5 most recent chats until you ask.
 */
function ProjectGroups(p: {
  chats: ChatInfo[];
  starred: Set<string>;
  onStar: (projectId: string, on: boolean) => void;
  row: (c: ChatInfo) => ReactNode;
}) {
  // What you've opened or folded yourself, against each group's default.
  const [flipped, flip] = useToggles();
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
            label={projectId}
            fold={{ folded, onToggle: () => flip(projectId) }}
            {...(projectId === "default"
              ? {}
              : {
                  star: {
                    name: projectId,
                    on: p.starred.has(projectId),
                    onStar: (on: boolean) => p.onStar(projectId, on),
                  },
                })}
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

/** The lab's Chats sidebar: Needs you (pinned), Running (shimmering), then your chats by project. */
export function Sidebar(p: Props) {
  const { chats, needs, projects, ions = [], open, onOpen, onNewProject, onRename, onArchive, onStar } = p;
  const starred = useMemo(() => new Set(projects.filter((x) => x.starred).map((x) => x.id)), [projects]);
  const [project, setProject] = useState<string | null>(null);
  const g = useMemo(() => groupChats(chats, needs, project), [chats, needs, project]);
  const props = (c: ChatInfo): RowProps => {
    const ion = c.by === "ion" ? ions.find((x) => x.ionId === c.projectId) : undefined;
    return { chat: c, open: open === c.chatId, onOpen: () => onOpen(c.chatId), ...(ion ? { ion } : {}) };
  };
  const acts = { onRename, onArchive };
  const row = (c: ChatInfo) => <ChatRow key={c.chatId} {...props(c)} acts={acts} />;
  return (
    <>
      <div className="shead">
        <ProjectMenu
          projects={projects}
          needs={needs}
          project={project}
          onPick={setProject}
          onNew={onNewProject}
        />
        <button className="ib" type="button" title="New chat" onClick={() => onOpen(null)}>
          <SquarePen />
        </button>
      </div>
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
          <ProjectGroups chats={g.chats} starred={starred} onStar={onStar} row={row} />
        )}
      </div>
    </>
  );
}
