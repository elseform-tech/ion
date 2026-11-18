import type { IonClient } from "@ion/client/browser";
import type { ChatInfo, HarnessInfo, ProjectInfo } from "@ion/schema";
import { PanelRight } from "@ion/design-system";
import { useState } from "react";
import { ChangesPanel } from "./ChangesPanel.js";
import { ChatView, useTimeline } from "./ChatView.js";
import { Composer } from "./Composer.js";
import { QuestionBar } from "./QuestionBar.js";
import { Sidebar } from "./Sidebar.js";
import { useLive } from "./live.js";
import type { Item } from "./timeline.js";

type Question = Extract<Item, { kind: "question" }>;

/** An open chat: its header, timeline, any open question, and the message box. */
function OpenChat({
  client,
  chat,
  harnesses,
}: {
  client: IonClient;
  chat: ChatInfo;
  harnesses: HarnessInfo[];
}) {
  const t = useTimeline(client, chat.chatId);
  const open = t.items.filter((i): i is Question => i.kind === "question" && !i.resolved).at(-1);
  // The side panel only appears in chats that have a worktree (an archived chat has none).
  const hasWorktree = Boolean(chat.branch) && !chat.archived;
  const [panel, setPanel] = useState(true);
  return (
    <div className={`chatwrap${hasWorktree && panel ? " chatwrap--panel" : ""}`}>
      <div className="chat-main">
        <header className="chat-head">
          <span className="chat-title">{chat.title}</span>
          <span className="chat-project">{chat.projectId}</span>
          {hasWorktree && (
            <button
              type="button"
              className="icon-button chat-panel-toggle"
              aria-label={panel ? "Hide changes" : "Show changes"}
              aria-pressed={panel}
              onClick={() => setPanel(!panel)}
            >
              <PanelRight size={16} />
            </button>
          )}
        </header>
        <ChatView timeline={t} />
        <div className="dock">
          {open && <QuestionBar key={open.needId} client={client} question={open} />}
          <Composer
            client={client}
            harnesses={harnesses}
            to={{ chatId: chat.chatId }}
            running={t.running}
            harness={t.harness}
            onSent={() => {}}
          />
        </div>
      </div>
      {hasWorktree && panel && <ChangesPanel client={client} chatId={chat.chatId} version={t.changes} />}
    </div>
  );
}

/** A new chat: which project it's in (ion's `default` unless you pick one), then the message box. */
function NewChat(props: {
  client: IonClient;
  projects: ProjectInfo[];
  harnesses: HarnessInfo[];
  onSent: (chatId: string) => void;
}) {
  const [projectId, setProjectId] = useState<string>("");
  return (
    <>
      <header className="chat-head">
        <span className="chat-title">New chat</span>
        <select
          aria-label="Project"
          className="project-pick"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">default</option>
          {props.projects
            .filter((p) => p.id !== "default")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
        </select>
      </header>
      <div className="timeline timeline--empty">What should we work on?</div>
      <div className="dock">
        <Composer
          client={props.client}
          harnesses={props.harnesses}
          to={{ projectId: projectId || null }}
          running={null}
          onSent={props.onSent}
        />
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
          <OpenChat key={chat.chatId} client={client} chat={chat} harnesses={live.harnesses} />
        ) : (
          <NewChat client={client} projects={live.projects} harnesses={live.harnesses} onSent={setOpenId} />
        )}
      </main>
    </>
  );
}
