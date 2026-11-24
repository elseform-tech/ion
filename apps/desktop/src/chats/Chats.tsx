import type { IonClient } from "@ion/client/browser";
import type { ChatInfo, HarnessInfo, ProjectInfo } from "@ion/schema";
import { Ghost, PanelRight } from "@ion/design-system";
import { useCallback, useEffect, useState } from "react";
import { type Focus, ToolsPanel, useDiff } from "./ToolsPanel.js";
import { ChatView, Starting, useTimeline } from "./ChatView.js";
import { Composer } from "./Composer.js";
import { QuestionBar } from "./QuestionBar.js";
import { Resizer } from "./Resizer.js";
import { Sidebar } from "./Sidebar.js";
import { useLive } from "./live.js";
import { FirstRun } from "../start/FirstRun.js";
import { lastProject } from "../start/steps.js";
import { FirstAnswer } from "../start/FirstAnswer.js";
import type { Item } from "./timeline.js";

type Question = Extract<Item, { kind: "question" }>;

/** The side panel's state for the window: closed to start; picking a changed file opens it at that file. */
function usePanel(): Panel {
  const [open, setOpen] = useState(false);
  // A count with the path, so picking the same file again scrolls to it again.
  const [focus, setFocus] = useState<Focus | null>(null);
  return {
    open,
    focus,
    toggle: () => setOpen((o) => !o),
    show: (path) => {
      setFocus((f) => ({ path, n: (f?.n ?? 0) + 1 }));
      setOpen(true);
    },
  };
}

/** The sidebar's actions, sent to ion; a refusal shows nowhere new (the list simply doesn't change). */
function sidebarActions(
  client: IonClient,
  open: { id: string | null; set: (id: string | null) => void },
  onProjects: () => void,
) {
  const [openId, setOpenId] = [open.id, open.set];
  const act = (f: () => Promise<unknown>) => void f().catch(() => {});
  return {
    onNewProject: (name: string) =>
      client.call("project.create", { name }).then((made) => {
        onProjects();
        return made.id;
      }),
    onAddFolder: (path: string, confirm?: boolean) =>
      client.call("projects.add", { path, ...(confirm ? { confirm } : {}) }).then((added) => {
        onProjects();
        return added;
      }),
    onRename: (chatId: string, title: string) => act(() => client.call("chat.rename", { chatId, title })),
    onRemember: (chatId: string, on: boolean) => act(() => client.call("chat.remember", { chatId, on })),
    onRenameProject: (projectId: string, name: string) =>
      act(() => client.call("project.rename", { projectId, name }).then(onProjects)),
    onRemoveProject: (projectId: string) =>
      act(() => client.call("project.remove", { projectId }).then(onProjects)),
    onStar: (projectId: string, starred: boolean) =>
      act(() => client.call("project.star", { projectId, starred }).then(onProjects)),
    onArchive: (chatId: string) => {
      if (chatId === openId) setOpenId(null);
      act(() => client.call("chat.archive", { chatId }));
    },
  };
}

/** The lab's chat header: title, project, and the panel toggle when there's a worktree (`panel` not null). */
function ChatHead(p: { chat: ChatInfo; panel: boolean | null; onPanel: () => void; why: string | null }) {
  const { chat, panel, onPanel } = p;
  return (
    <header className="head" data-tauri-drag-region>
      <span className="title">{chat.title}</span>
      <span className="muted">{chat.by === "ion" ? `${chat.projectId}'s ion` : chat.projectId}</span>
      {/* Why Pick by usage put the chat on its agent, in one line (the user, 2026-11-22). */}
      {p.why && <span className="muted why">{p.why}</span>}
      <span className="sp" />
      {panel !== null && (
        <button
          type="button"
          className={`ib${panel ? " on" : ""}`}
          aria-label={panel ? "Hide changes" : "Show changes"}
          aria-pressed={panel}
          onClick={onPanel}
        >
          <PanelRight />
        </button>
      )}
    </header>
  );
}

/** The side panel: one choice for the window, closed until you open it; `focus` is a file to show. */
type Panel = { open: boolean; toggle: () => void; focus: Focus | null; show: (path: string) => void };

/** An open chat: its header, timeline, any open question, and the message box. */
function OpenChat({
  client,
  chat,
  harnesses,
  onBrainOpen,
  panel,
  only,
}: {
  client: IonClient;
  chat: ChatInfo;
  harnesses: HarnessInfo[];
  onBrainOpen: () => void;
  panel: Panel;
  /** Your first run's chat: after its first answer, one line points to what ion remembers (once). */
  only: (() => void) | null;
}) {
  const t = useTimeline(client, chat.chatId);
  const open = t.items.filter((i): i is Question => i.kind === "question" && !i.resolved).at(-1);
  const hasWorktree = Boolean(chat.branch) && !chat.archived;
  const changes = useDiff(client, chat.chatId, t.changes);
  const showPanel = hasWorktree && panel.open;
  const seen = only && !t.running && chat.lastRunStatus === "done" ? only : null;
  const ask = { harness: t.harness, current: { model: t.model, effort: t.effort }, why: t.routed };
  return (
    <>
      <ChatHead chat={chat} panel={hasWorktree ? panel.open : null} onPanel={panel.toggle} why={t.routed} />
      <div className={`split${showPanel ? "" : " solo"}`}>
        <div className="convo">
          <ChatView timeline={t} onFile={hasWorktree ? panel.show : undefined} />
          <div className="foot">
            <div className="fcol">
              {seen && <FirstAnswer client={client} onSeen={seen} />}
              {open && <QuestionBar key={open.needId} client={client} question={open} />}
              <Composer
                client={client}
                harnesses={harnesses}
                onBrainOpen={onBrainOpen}
                to={{ chatId: chat.chatId }}
                running={t.running}
                locked={Boolean(open)}
                {...ask}
                onSent={() => {}}
              />
            </div>
          </div>
        </div>
        {showPanel && <ToolsPanel {...changes} focus={panel.focus} client={client} chatId={chat.chatId} />}
      </div>
    </>
  );
}

/** A new chat's head: Don't remember (the lab's ghost; review of #34, 2026-11-23), pressed while it's on. */
function NewHead(p: { noMemory: boolean; onNoMemory: (on: boolean) => void }) {
  return (
    <header className="head" data-tauri-drag-region>
      <span className="sp" />
      <button
        className={`ib${p.noMemory ? " on" : ""}`}
        type="button"
        title="Don't remember"
        aria-label="Don't remember"
        aria-pressed={p.noMemory}
        onClick={() => p.onNoMemory(!p.noMemory)}
      >
        <Ghost />
      </button>
    </header>
  );
}

/** The projects a new chat can go in: ion's `default` first. */
const projectOptions = (projects: ProjectInfo[]) => [
  { id: "default", name: "default" },
  ...projects.filter((p) => p.id !== "default").map((p) => ({ id: p.id, name: p.name ?? p.id })),
];

/**
 * A new chat: which project it's in (the one you used last until you pick one: Plan 21 audit, 2026-11-23), then the
 * message box.
 */
function NewChat(props: {
  client: IonClient;
  projects: ProjectInfo[];
  chats: ChatInfo[];
  harnesses: HarnessInfo[];
  onSent: (chatId: string) => void;
  onBrainOpen: () => void;
}) {
  const [picked, setProjectId] = useState<string | null>(null);
  const projectId = picked ?? lastProject(props.chats, props.projects);
  // Your first message, shown at once while ion makes the chat (ion can take a moment).
  const [sending, setSending] = useState<string | null>(null);
  // Don't remember: the chat gets no memory and writes none.
  const [noMemory, setNoMemory] = useState(false);
  return (
    <>
      <NewHead noMemory={noMemory} onNoMemory={setNoMemory} />
      {sending !== null && (
        <div className="msgs">
          <div className="col">
            <div className="u">{sending}</div>
            <Starting />
          </div>
        </div>
      )}
      <div className="empty" hidden={sending !== null}>
        <div className="inner">
          <h3>What are we working on?</h3>
          <Composer
            client={props.client}
            harnesses={props.harnesses}
            onBrainOpen={props.onBrainOpen}
            to={{ projectId: projectId === "default" ? null : projectId }}
            running={null}
            project={{ value: projectId, options: projectOptions(props.projects), onChange: setProjectId }}
            onSending={setSending}
            onSent={props.onSent}
            auto
            noMemory={noMemory}
          />
        </div>
      </div>
    </>
  );
}

/** No chat open: the first run's three steps (the first time), else a new chat. */
function Fresh(p: {
  client: IonClient;
  live: ReturnType<typeof useLive>;
  first: boolean;
  onSent: (chatId: string) => void;
}) {
  const { client, live } = p;
  if (p.first)
    return (
      <FirstRun
        client={client}
        harnesses={live.harnesses}
        onReload={live.refreshHarnesses}
        onSent={p.onSent}
      />
    );
  return (
    <NewChat
      client={client}
      projects={live.projects}
      chats={live.chats}
      harnesses={live.harnesses}
      onBrainOpen={live.refreshHarnesses}
      onSent={p.onSent}
    />
  );
}

/**
 * Whether this is a first run (Plan 21: no projects and no chats), asked once when the screen opens and kept until
 * your first message: adding a folder on the way doesn't end it.
 */
function useFirstRun(client: IonClient, onEnd: () => void): [boolean, () => void, (() => void) | null] {
  const [first, setFirst] = useState(false);
  // A first run ended in this window: its chat may say what ion remembers (never for someone upgrading).
  const [started, setStarted] = useState(false);
  useEffect(() => {
    void client.call("start.status", {}).then(
      (s) => setFirst(s?.firstRun === true),
      () => {},
    );
  }, [client]);
  // Your first message ends it; the folder you added shows in the sidebar.
  const end = () => {
    if (!first) return;
    setFirst(false);
    setStarted(true);
    onEnd();
  };
  const seen = useCallback(() => setStarted(false), []);
  return [first, end, started ? seen : null];
}

/** The Chats screen: the sidebar, and the open chat or a new one (the first run's three steps, the first time). */
export function Chats({
  client,
  openId,
  setOpenId,
}: {
  client: IonClient;
  /** The open chat, kept by the window so it stays open across a reconnect. */
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  const live = useLive(client);
  const panel = usePanel();
  const [first, endFirst, started] = useFirstRun(client, live.refreshProjects);

  const chat = live.chats.find((c) => c.chatId === openId);
  const sent = (chatId: string) => {
    endFirst();
    setOpenId(chatId);
  };
  return (
    <>
      <aside className="side" aria-label="Chats">
        <Resizer name="--side-w" label="Sidebar width" initial={256} min={200} max={440} edge="right" />
        <Sidebar
          chats={live.chats}
          needs={live.needs}
          projects={live.projects}
          ions={live.ions}
          open={openId}
          onOpen={setOpenId}
          {...sidebarActions(client, { id: openId, set: setOpenId }, live.refreshProjects)}
        />
      </aside>
      <main className="chat">
        {chat ? (
          <OpenChat
            key={chat.chatId}
            client={client}
            chat={chat}
            harnesses={live.harnesses}
            onBrainOpen={live.refreshHarnesses}
            panel={panel}
            only={started}
          />
        ) : (
          <Fresh client={client} live={live} first={first} onSent={sent} />
        )}
      </main>
    </>
  );
}
