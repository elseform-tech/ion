import type { IonClient } from "@ion/client/browser";
import { EV, type IonInfo } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";
import { useLive } from "../chats/live.js";
import { NewProject, ProjectMenu } from "../chats/ProjectMenu.js";
import { Star } from "@ion/design-system";
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
function useIons(client: IonClient): [IonInfo[], () => void] {
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
  return [ions, read];
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

/** A project's ion: its avatar, name, and last line (shimmering while one of its threads runs), then its star. */
function IonRow({
  ion,
  on,
  onOpen,
  onStar,
}: {
  ion: IonInfo;
  on: boolean;
  onOpen: () => void;
  onStar: (starred: boolean) => void;
}) {
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
      <button
        className={`ib star${ion.starred ? " on" : ""}`}
        type="button"
        title={`${ion.starred ? "Unstar" : "Star"} ${ion.name}`}
        aria-label={`${ion.starred ? "Unstar" : "Star"} ${ion.name}`}
        onClick={() => onStar(!ion.starred)}
      >
        <Star />
      </button>
    </div>
  );
}

/** The project ions, as the lab lists them: Starred, then Other projects (just "Projects" when none is starred). */
function IonList(p: {
  ions: IonInfo[];
  openId: string | undefined;
  onOpen: (id: string) => void;
  onStar: (projectId: string, starred: boolean) => void;
}) {
  const star = (projectId: string) => (starred: boolean) => p.onStar(projectId, starred);
  const row = (ion: IonInfo) => (
    <IonRow
      key={ion.ionId}
      ion={ion}
      on={p.openId === ion.ionId}
      onOpen={() => p.onOpen(ion.ionId)}
      onStar={star(ion.ionId)}
    />
  );
  const starred = p.ions.filter((x) => x.starred);
  const rest = p.ions.filter((x) => !x.starred);
  return (
    <>
      {starred.length > 0 && <div className="lh">Starred</div>}
      {starred.map(row)}
      {rest.length > 0 && (
        <div className="lh">
          {starred.length > 0 ? "Other projects" : "Projects"}
          <span>{rest.length}</span>
        </div>
      )}
      {rest.map(row)}
    </>
  );
}

/** The Ions screen, as the lab's: the header (project picker), ion chief, each project's ion (Starred first) and
 * Add project on the left; the open ion's chat on the right. */
export function Ions({ client, onOpenChat }: { client: IonClient; onOpenChat: (chatId: string) => void }) {
  const [ions, readIons] = useIons(client);
  const live = useLive(client);
  // Projects live in your config, not in ion's events: read them again after a change made here.
  const changed = () => {
    readIons();
    live.refreshProjects();
  };
  const onStar = (projectId: string, starred: boolean) =>
    void client.call("project.star", { projectId, starred }).then(changed, () => {});
  const [openId, setOpenId] = useState("chief");
  const [project, setProject] = useState<string | null>(null);
  const open = ions.find((x) => x.ionId === openId) ?? ions[0];
  const [chief, ...all] = ions;
  const projects = all.filter((x) => project === null || x.ionId === project);
  const addProject = (name: string) => client.call("project.create", { name }).then(changed);
  return (
    <>
      <aside className="ipanel" aria-label="Ions">
        <div className="ihead">
          <b className="brand ititle" aria-label="ions">
            i<i>o</i>ns
          </b>
          <ProjectMenu
            projects={live.projects}
            needs={live.needs}
            project={project}
            onPick={setProject}
            onNew={addProject}
          />
        </div>
        {chief && <Chief ion={chief} on={open?.ionId === "chief"} onOpen={() => setOpenId("chief")} />}
        <div className="ilist">
          <IonList ions={projects} openId={open?.ionId} onOpen={setOpenId} onStar={onStar} />
          {project === null && <NewProject onNew={addProject} label="Add project" className="addp" />}
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
