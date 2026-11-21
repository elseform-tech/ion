import { Avatar, Link, type LucideIcon, MessageSquare } from "@ion/design-system";
import type { IonClient } from "@ion/client/browser";
import type { HarnessInfo, ToolOrigin, ToolsInfo } from "@ion/schema";
import { type ReactNode, useEffect, useRef } from "react";
import { openLink } from "../opener.js";

/** What each Tools tab is given: the list, how to show a change, and the row a chat's link opened. */
export type TabProps = {
  client: IonClient;
  info: ToolsInfo;
  set: (t: ToolsInfo) => void;
  at?: string | null;
};
/** What a tab's rows share: the calls, whether the keychain is locked, and the row a chat's link opened. */
export type Part = { client: IonClient; set: (t: ToolsInfo) => void; locked: boolean; at: string | null };
export const partOf = (p: TabProps): Part => ({
  client: p.client,
  set: p.set,
  locked: !!p.info.keychainProblem,
  at: p.at ?? null,
});

/** What a connection, hook or skill shows beside its name when it's off for a reason. */
export type State = "New" | "Changed" | "Can't check" | "Can't reach";

/**
 * New (never turned on), Changed (it runs something else since you turned it on). With the keychain locked ion can't
 * check what you turned on, so what isn't on and isn't new reads Can't check, never Changed.
 */
export function stateOf(x: { on: boolean; new?: true; changed?: true }, locked: boolean): State | null {
  if (x.new) return "New";
  if (locked && !x.on) return "Can't check";
  return x.changed ? "Changed" : null;
}

/** Long commands end in "…". */
export const short = (s: string, most = 60) => (s.length > most ? `${s.slice(0, most - 1)}…` : s);

/** Where a source opens: the link ion found for it (a registry id's repo), or the https link given. */
const linkOf = (o: ToolOrigin) => o.link ?? (o.source?.startsWith("https://") ? o.source : undefined);

/** Its source: a link icon that opens it, the source as written when there's nothing to open, or "Unknown source". */
function Source({ o }: { o: ToolOrigin }) {
  const link = linkOf(o);
  if (link)
    return (
      <button
        className="ib"
        type="button"
        title={o.source ?? link}
        aria-label="Source"
        onClick={() => void openLink(link).catch(() => {})}
      >
        <Link />
      </button>
    );
  return <span title={o.source}>{o.source ? short(o.source, 40) : "Unknown source"}</span>;
}

/**
 * Where a row came from: its source and, for one a chat's agent added, that chat. One you added yourself with no
 * source says nothing.
 */
function Origin({ o }: { o: ToolOrigin }) {
  if (o.by === "you" && !o.source) return null;
  return (
    <span className="org">
      <Source o={o} />
      {o.by === "agent" && (
        <span title="Added by a chat">
          <MessageSquare />
          <span className="ct">{o.chatTitle ?? "A chat"}</span>
        </span>
      )}
    </span>
  );
}

/**
 * The lab's .trow: an icon, the name (and a chip, and where it came from), one line under it, then what it works
 * with, then its controls. `at`: the row a chat's link opened (shown, and scrolled to).
 */
export function ToolRow(p: {
  icon: LucideIcon;
  name: string;
  chip?: string | null;
  line?: ReactNode;
  mid?: ReactNode;
  end?: ReactNode;
  origin?: ToolOrigin;
  at?: boolean;
}) {
  const Icon = p.icon;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (p.at) ref.current?.scrollIntoView?.({ block: "center" });
  }, [p.at]);
  return (
    <div className={p.at ? "trow at" : "trow"} ref={ref}>
      <span className="ti">
        <Icon />
      </span>
      <div>
        <span className="tname">{p.name}</span>
        {p.chip && <span className="chip">{p.chip}</span>}
        {p.origin && <Origin o={p.origin} />}
        {p.line && <div className="s">{p.line}</div>}
      </div>
      <span className="hsup">{p.mid}</span>
      <div className="acts2">{p.end}</div>
    </div>
  );
}

/** Which agents work with it: each ready agent's face, crossed out where it doesn't. */
export function Works({ agents, works }: { agents: HarnessInfo[]; works: (id: string) => boolean }) {
  return agents.map((h) => (
    <span
      key={h.id}
      className={works(h.id) ? "" : "no"}
      title={`${h.label}: ${works(h.id) ? "works" : "not supported"}`}
    >
      <Avatar harness={h.id} />
    </span>
  ));
}
