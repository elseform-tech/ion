import type { IonClient } from "@ion/client/browser";
import { type ChatInfo, EV, type HarnessInfo, type NeedInfo, type ProjectInfo } from "@ion/schema";
import { useCallback, useEffect, useMemo, useState } from "react";

export type Groups = {
  needsYou: { chat: ChatInfo; need: NeedInfo }[];
  running: ChatInfo[];
  chats: ChatInfo[];
};

const RUNNING = new Set(["queued", "running"]);

/** The sidebar's sections: Needs you (one row per question), then Running, then the rest, newest first. */
export function groupChats(chats: ChatInfo[], needs: NeedInfo[]): Groups {
  const live = chats.filter((c) => !c.archived).reverse();
  const byId = new Map(live.map((c) => [c.chatId, c]));
  const needsYou = needs.flatMap((need) => {
    const chat = byId.get(need.chatId);
    return chat ? [{ chat, need }] : [];
  });
  const waiting = new Set(needsYou.map((x) => x.chat.chatId));
  const running = live.filter((c) => !waiting.has(c.chatId) && RUNNING.has(c.lastRunStatus ?? ""));
  const chatsLeft = live.filter((c) => !waiting.has(c.chatId) && !RUNNING.has(c.lastRunStatus ?? ""));
  return { needsYou, running, chats: chatsLeft };
}

/** Events after which the sidebar re-reads its lists. */
const CHANGES = new Set<string>([
  EV.chatCreated,
  EV.chatArchived,
  EV.runQueued,
  EV.runStarted,
  EV.runFinished,
  EV.needRaised,
  EV.needResolved,
]);

/** What the sidebar and composer show, kept live: chats, open questions, projects and harnesses. */
export function useLive(client: IonClient) {
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [needs, setNeeds] = useState<NeedInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const refresh = useCallback(async () => {
    const [c, n] = await Promise.all([client.call("chats.list", {}), client.call("needs.list", {})]);
    setChats(c);
    setNeeds(n);
  }, [client]);
  useEffect(() => {
    const quiet = () => {}; // a dropped connection shows as "ion isn't running"; nothing to add here
    void client.call("projects.list", {}).then(setProjects, quiet);
    void client.call("harnesses.list", {}).then(setHarnesses, quiet);
    let stop: (() => void) | undefined;
    let gone = false;
    // Live events first, then the lists: nothing can happen between reading them and listening.
    void client
      .subscribe({ fromNow: true }, (e) => {
        if (CHANGES.has(e.type)) void refresh().catch(quiet);
        if (e.type === EV.chatCreated) void client.call("projects.list", {}).then(setProjects, quiet);
      })
      .then((s) => {
        if (gone) return s();
        stop = s;
        return refresh();
      })
      .catch(quiet);
    return () => {
      gone = true;
      stop?.();
    };
  }, [client, refresh]);
  const groups = useMemo(() => groupChats(chats, needs), [chats, needs]);
  return { groups, chats, needs, projects, harnesses };
}
