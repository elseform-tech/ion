import type { IonClient } from "@ion/client/browser";
import { EV, type IonInfo } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";
import { useLive } from "../chats/live.js";
import { IonAvatar, IonChat, IonName } from "./IonChat.js";

/** What changes the ions list: an ion's line, its threads starting, running and ending, their questions. */
const IONS_CHANGE = new Set<string>([
  EV.ionSaid,
  EV.chatCreated,
  EV.chatArchived,
  EV.runQueued,
  EV.runStarted,
  EV.runFinished,
  EV.needRaised,
  EV.needResolved,
]);

/** The ions, kept live: read again when something they show changes. */
function useIons(client: IonClient): IonInfo[] {
  const [ions, setIons] = useState<IonInfo[]>([]);
  const read = useCallback(() => void client.call("ions.list", {}).then(setIons, () => {}), [client]);
  useEffect(() => {
    read();
    let stop: (() => void) | undefined;
    let gone = false;
    void client
      .subscribe({ fromNow: true }, (e) => {
        if (!gone && IONS_CHANGE.has(e.type)) read();
      })
      .then(
        (s) => {
          if (gone) s();
          else stop = s;
        },
        () => {},
      );
    return () => {
      gone = true;
      stop?.();
    };
  }, [client, read]);
  return ions;
}

/** ion chief's tile: the wordmark, "All projects", and how many questions wait. */
function Chief({ ion, on, onOpen }: { ion: IonInfo; on: boolean; onOpen: () => void }) {
  return (
    <button className={`chief${on ? " on" : ""}`} type="button" onClick={onOpen}>
      <IonAvatar ion={ion} />
      <span className="g">
        <IonName ion={ion} className="tname" />
        <small>All projects</small>
      </span>
      {ion.needs > 0 && <span className="nb">{ion.needs}</span>}
    </button>
  );
}

/** A project's ion: its avatar, name, and last line (shimmering while one of its threads runs). */
function IonRow({ ion, on, onOpen }: { ion: IonInfo; on: boolean; onOpen: () => void }) {
  return (
    <div className={`prow${on ? " on" : ""}`}>
      <button className="pmain" type="button" onClick={onOpen}>
        <IonAvatar ion={ion} />
        <span className="g">
          <b>{ion.name}</b>
          {ion.last && <small className={ion.working ? "now" : undefined}>{ion.last}</small>}
        </span>
        {ion.needs > 0 && <span className="nb">{ion.needs}</span>}
      </button>
    </div>
  );
}

/** The Ions screen, as the lab's: ion chief and each project's ion on the left, the open ion's chat on the right. */
export function Ions({ client, onOpenChat }: { client: IonClient; onOpenChat: (chatId: string) => void }) {
  const ions = useIons(client);
  const live = useLive(client);
  const [openId, setOpenId] = useState("chief");
  const open = ions.find((x) => x.ionId === openId) ?? ions[0];
  const [chief, ...projects] = ions;
  return (
    <>
      <aside className="ipanel" aria-label="Ions">
        <div className="ihead">
          <b className="brand ititle" aria-label="ions">
            i<i>o</i>ns
          </b>
        </div>
        {chief && <Chief ion={chief} on={open?.ionId === "chief"} onOpen={() => setOpenId("chief")} />}
        <div className="ilist">
          {projects.length > 0 && (
            <div className="lh">
              Projects<span>{projects.length}</span>
            </div>
          )}
          {projects.map((ion) => (
            <IonRow
              key={ion.ionId}
              ion={ion}
              on={open?.ionId === ion.ionId}
              onOpen={() => setOpenId(ion.ionId)}
            />
          ))}
        </div>
      </aside>
      {open && (
        <IonChat
          key={open.ionId}
          client={client}
          ion={open}
          chats={live.chats}
          needs={live.needs.filter((n) => live.chats.some((c) => c.chatId === n.chatId && c.by === "ion"))}
          ions={ions}
          onOpenChat={onOpenChat}
        />
      )}
    </>
  );
}
