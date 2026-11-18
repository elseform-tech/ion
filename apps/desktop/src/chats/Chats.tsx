import type { IonClient } from "@ion/client/browser";
import type { ChatInfo, HarnessInfo, ProjectInfo } from "@ion/schema";
import { useState } from "react";
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
  const open = t.items.filter((i): i is Question => i.kind === "question" && !i.answered).at(-1);
  return (
    <>
      <header className="chat-head">
        <span className="chat-title">{chat.title}</span>
        <span className="chat-project">{chat.projectId}</span>
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
    </>
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
export function Chats({ client }: { client: IonClient }) {
  const live = useLive(client);
  const [openId, setOpenId] = useState<string | null>(null);
  const chat = live.chats.find((c) => c.chatId === openId);
  return (
    <>
      <aside className="sidebar" aria-label="Chats">
        <Sidebar groups={live.groups} open={openId} onOpen={setOpenId} />
      </aside>
      <main className="main">
        {chat ? (
          <OpenChat key={chat.chatId} client={client} chat={chat} harnesses={live.harnesses} />
        ) : (
          <NewChat client={client} projects={live.projects} harnesses={live.harnesses} onSent={setOpenId} />
        )}
      </main>
    </>
  );
}
