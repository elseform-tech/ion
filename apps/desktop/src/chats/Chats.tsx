import type { IonClient } from "@ion/client/browser";
import type { ChatInfo, HarnessInfo, ProjectInfo } from "@ion/schema";
import { PanelRight } from "@ion/design-system";
import { useEffect, useState } from "react";
import { ToolsPanel } from "./ToolsPanel.js";
import { ChatView, useTimeline } from "./ChatView.js";
import { Composer } from "./Composer.js";
import { QuestionBar } from "./QuestionBar.js";
import { Sidebar } from "./Sidebar.js";
import { useLive } from "./live.js";
import type { Item } from "./timeline.js";

type Question = Extract<Item, { kind: "question" }>;

const WIDE = "(min-width: 1100px)";

/**
 * The side panel starts open (when `open`) on a wide window; narrowing below 1100 px closes it, and widening opens
 * it again when it started open.
 */
function useWidePanel(open: boolean): [boolean, (v: boolean) => void] {
  const mq = typeof matchMedia === "function" ? matchMedia(WIDE) : null;
  const [panel, setPanel] = useState(open && (mq?.matches ?? true));
  useEffect(() => {
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setPanel(open && e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mq, open]);
  return [panel, setPanel];
}

/** The lab's chat header: title, project, and the panel toggle when there's a worktree (`panel` not null). */
function ChatHead({ chat, panel, onPanel }: { chat: ChatInfo; panel: boolean | null; onPanel: () => void }) {
  return (
    <header className="head" data-tauri-drag-region>
      <span className="title">{chat.title}</span>
      <span className="muted">{chat.projectId}</span>
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

/** An open chat: its header, timeline, any open question, and the message box. */
function OpenChat({
  client,
  chat,
  harnesses,
  onBrainOpen,
}: {
  client: IonClient;
  chat: ChatInfo;
  harnesses: HarnessInfo[];
  onBrainOpen: () => void;
}) {
  const t = useTimeline(client, chat.chatId);
  const open = t.items.filter((i): i is Question => i.kind === "question" && !i.resolved).at(-1);
  const hasWorktree = Boolean(chat.branch) && !chat.archived;
  // A plain chat (in ion's `default`) opens as just a conversation, as the lab's; its changes are a click away.
  const [panel, setPanel] = useWidePanel(chat.projectId !== "default");
  const showPanel = hasWorktree && panel;
  return (
    <>
      <ChatHead chat={chat} panel={hasWorktree ? panel : null} onPanel={() => setPanel(!panel)} />
      <div className={`split${showPanel ? "" : " solo"}`}>
        <div className="convo">
          <ChatView timeline={t} />
          <div className="foot">
            <div className="fcol">
              {open && <QuestionBar key={open.needId} client={client} question={open} />}
              <Composer
                client={client}
                harnesses={harnesses}
                onBrainOpen={onBrainOpen}
                to={{ chatId: chat.chatId }}
                running={t.running}
                harness={t.harness}
                onSent={() => {}}
              />
            </div>
          </div>
        </div>
        {showPanel && <ToolsPanel client={client} chatId={chat.chatId} version={t.changes} />}
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
  return (
    <>
      <header className="head" data-tauri-drag-region />
      <div className="empty">
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

  const chat = live.chats.find((c) => c.chatId === openId);
  return (
    <>
      <aside className="side" aria-label="Chats">
        <Sidebar
          chats={live.chats}
          needs={live.needs}
          projects={live.projects}
          open={openId}
          onOpen={setOpenId}
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
