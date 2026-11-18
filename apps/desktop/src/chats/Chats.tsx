import type { IonClient } from "@ion/client/browser";
import type { ChatInfo, HarnessInfo, ProjectInfo } from "@ion/schema";
import { PanelRight } from "@ion/design-system";
import { useState } from "react";
import { type Focus, ToolsPanel, useDiff } from "./ToolsPanel.js";
import { ChatView, Starting, useTimeline } from "./ChatView.js";
import { Composer } from "./Composer.js";
import { QuestionBar } from "./QuestionBar.js";
import { Resizer } from "./Resizer.js";
import { Sidebar } from "./Sidebar.js";
import { useLive } from "./live.js";
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
function sidebarActions(client: IonClient, openId: string | null, setOpenId: (id: string | null) => void) {
  const act = (f: () => Promise<unknown>) => void f().catch(() => {});
  return {
    onNewProject: (name: string) => act(() => client.call("project.create", { name })),
    onRename: (chatId: string, title: string) => act(() => client.call("chat.rename", { chatId, title })),
    onArchive: (chatId: string) => {
      if (chatId === openId) setOpenId(null);
      act(() => client.call("chat.archive", { chatId }));
    },
  };
}

/** The lab's chat header: title, project, and the panel toggle when there's a worktree (`panel` not null). */
function ChatHead({ chat, panel, onPanel }: { chat: ChatInfo; panel: boolean | null; onPanel: () => void }) {
  return (
    <header className="head" data-tauri-drag-region>
      <span className="title">{chat.title}</span>
      <span className="muted">{chat.by === "ion" ? `${chat.projectId}'s ion` : chat.projectId}</span>
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
}: {
  client: IonClient;
  chat: ChatInfo;
  harnesses: HarnessInfo[];
  onBrainOpen: () => void;
  panel: Panel;
}) {
  const t = useTimeline(client, chat.chatId);
  const open = t.items.filter((i): i is Question => i.kind === "question" && !i.resolved).at(-1);
  const hasWorktree = Boolean(chat.branch) && !chat.archived;
  const changes = useDiff(client, chat.chatId, t.changes);
  const showPanel = hasWorktree && panel.open;
  return (
    <>
      <ChatHead chat={chat} panel={hasWorktree ? panel.open : null} onPanel={panel.toggle} />
      <div className={`split${showPanel ? "" : " solo"}`}>
        <div className="convo">
          <ChatView timeline={t} onFile={hasWorktree ? panel.show : undefined} />
          <div className="foot">
            <div className="fcol">
              {open && <QuestionBar key={open.needId} client={client} question={open} />}
              <Composer
                client={client}
                harnesses={harnesses}
                onBrainOpen={onBrainOpen}
                to={{ chatId: chat.chatId }}
                running={t.running}
                locked={Boolean(open)}
                harness={t.harness}
                onSent={() => {}}
              />
            </div>
          </div>
        </div>
        {showPanel && <ToolsPanel {...changes} focus={panel.focus} />}
      </div>
    </>
  );
}

/** A new chat: which project it's in (ion's `default` unless you pick one), then the message box. */
function NewChat(props: {
  client: IonClient;
  projects: ProjectInfo[];
  harnesses: HarnessInfo[];
  onSent: (chatId: string) => void;
  onBrainOpen: () => void;
}) {
  const [projectId, setProjectId] = useState<string>("default");
  // Your first message, shown at once while ion makes the chat (ion can take a moment).
  const [sending, setSending] = useState<string | null>(null);
  return (
    <>
      <header className="head" data-tauri-drag-region />
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
            project={{
              value: projectId,
              options: ["default", ...props.projects.map((p) => p.id).filter((id) => id !== "default")],
              onChange: setProjectId,
            }}
            onSending={setSending}
            onSent={props.onSent}
          />
        </div>
      </div>
    </>
  );
}

/** The Chats screen: the sidebar, and the open chat or a new one. */
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

  const chat = live.chats.find((c) => c.chatId === openId);
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
          {...sidebarActions(client, openId, setOpenId)}
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
          />
        ) : (
          <NewChat
            client={client}
            projects={live.projects}
            harnesses={live.harnesses}
            onBrainOpen={live.refreshHarnesses}
            onSent={setOpenId}
          />
        )}
      </main>
    </>
  );
}
