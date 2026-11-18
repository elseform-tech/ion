import { CircleAlert, Pin, Square, SquarePen } from "@ion/design-system";
import type { ChatInfo, NeedInfo, ProjectInfo } from "@ion/schema";
import { type ReactNode, useMemo, useState } from "react";
import { groupChats, relTime } from "./live.js";
import { ProjectMenu } from "./ProjectMenu.js";

function Group({ label, count, children }: { label: ReactNode; count?: number; children: ReactNode }) {
  return (
    <div className="grp">
      <div className="gl">
        <span>{label}</span>
        {count !== undefined && <span>{count}</span>}
      </div>
      {children}
    </div>
  );
}

type Row = { chat: ChatInfo; open: boolean; onOpen: () => void };

/** A Needs-you row: the question, its project under it, the wait dot. */
const NeedRow = ({ chat, open, onOpen, need }: Row & { need: NeedInfo }) => (
  <button className={`r${open ? " on" : ""}`} type="button" onClick={onOpen}>
    <span />
    <span>
      <span className="tt">{need.summary}</span>
      <span className="sub">{chat.projectId}</span>
    </span>
    <i className="wd" />
  </button>
);

/** How a chat's last run ended, when that's worth a mark: failed or stopped. */
const MARKS: Record<string, { label: string; Icon: typeof CircleAlert }> = {
  failed: { label: "Failed", Icon: CircleAlert },
  interrupted: { label: "Stopped", Icon: Square },
  capped: { label: "Stopped", Icon: Square },
};

/** When it was last active, after a mark if its last run failed or was stopped. */
function When({ chat }: { chat: ChatInfo }) {
  const mark = MARKS[chat.lastRunStatus ?? ""];
  return (
    <span className="tm">
      {mark && <mark.Icon className="st" aria-label={mark.label} />}
      {relTime(chat.lastActivityAt)}
    </span>
  );
}

/**
 * A chat row: its title with the start of the agent's last reply under it, then a spinner while it runs, else
 * when it was last active. The first slot stays empty: an avatar there marks a thread ion started, not yours.
 */
const ChatRow = ({ chat, open, onOpen, running }: Row & { running?: boolean }) => (
  <button className={`r${open ? " on" : ""}`} type="button" onClick={onOpen}>
    <span />
    <span>
      <span className="tt">{chat.title}</span>
      {chat.preview && <span className="sub">{chat.preview}</span>}
    </span>
    {running ? <i className="spin" /> : <When chat={chat} />}
  </button>
);

/** Chats by project, the most recently active project first (the chats are newest first already). */
function byProject(chats: ChatInfo[]): { projectId: string; chats: ChatInfo[] }[] {
  const groups = new Map<string, ChatInfo[]>();
  for (const c of chats)
    groups.set(c.projectId ?? "default", [...(groups.get(c.projectId ?? "default") ?? []), c]);
  return [...groups].map(([projectId, list]) => ({ projectId, chats: list }));
}

type Props = {
  chats: ChatInfo[];
  needs: NeedInfo[];
  projects: ProjectInfo[];
  open: string | null;
  onOpen: (chatId: string | null) => void;
};

const NEEDS_LABEL = (
  <span className="pinl">
    <Pin />
    Needs you
  </span>
);

/** The lab's Chats sidebar: Needs you (pinned), Running (with a spinner), then everything else by activity. */
export function Sidebar({ chats, needs, projects, open, onOpen }: Props) {
  const [project, setProject] = useState<string | null>(null);
  const g = useMemo(() => groupChats(chats, needs, project), [chats, needs, project]);
  const props = (c: ChatInfo) => ({ chat: c, open: open === c.chatId, onOpen: () => onOpen(c.chatId) });
  return (
    <>
      <div className="shead">
        <ProjectMenu projects={projects} needs={needs} project={project} onPick={setProject} />
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
              <ChatRow key={c.chatId} {...props(c)} running />
            ))}
          </Group>
        )}
        {project ? (
          <Group label="Chats">
            {g.chats.map((c) => (
              <ChatRow key={c.chatId} {...props(c)} />
            ))}
          </Group>
        ) : (
          byProject(g.chats).map((p) => (
            <Group key={p.projectId} label={p.projectId}>
              {p.chats.map((c) => (
                <ChatRow key={c.chatId} {...props(c)} />
              ))}
            </Group>
          ))
        )}
      </div>
    </>
  );
}
