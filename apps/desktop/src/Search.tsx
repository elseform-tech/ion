import type { IonClient } from "@ion/client/browser";
import {
  Avatar,
  CodeXml,
  type LucideIcon,
  MessageSquare,
  Orbit,
  Search as SearchIcon,
  SquarePen,
} from "@ion/design-system";
import type { ChatInfo, IonInfo } from "@ion/schema";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { why } from "./callError.js";
import { hit } from "./hotkeys.js";
import { projectName } from "./projectName.js";
import { SETTINGS_PAGES, type SettingsPage } from "./settings/pages.js";

/** Where a search result goes. */
export type Place =
  | { kind: "new" }
  | { kind: "chats" }
  | { kind: "ions" }
  | { kind: "chat"; chatId: string }
  | { kind: "ion"; ionId: string }
  | { kind: "settings"; page: SettingsPage; more?: true };

const OPEN_SEARCH = "ion:open-search";

/** Opens Search from anywhere (the rail's button). */
export const openSearch = (): void => void window.dispatchEvent(new Event(OPEN_SEARCH));

/** ⌘K toggles Search; the rail's button opens it. */
export function useSearchKey(toggle: () => void, open: () => void): void {
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (!hit("search", e)) return;
      e.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", key);
    window.addEventListener(OPEN_SEARCH, open);
    return () => {
      document.removeEventListener("keydown", key);
      window.removeEventListener(OPEN_SEARCH, open);
    };
  }, [toggle, open]);
}

/** One result: its icon, title (and a quiet second part), what's on its right, and where it goes (or what it asks). */
type Item = {
  key: string;
  icon: ReactNode;
  title: string;
  small?: string;
  to: Place;
  ask?: string;
  hint?: string;
};
type Group = { name: string; items: Item[] };

/** The lab's actions: a new chat, each screen, each Settings page. */
const ACTIONS: { title: string; icon: LucideIcon; to: Place; small?: string }[] = [
  { title: "New chat", icon: SquarePen, to: { kind: "new" } },
  { title: "Chats", icon: MessageSquare, to: { kind: "chats" } },
  { title: "Ions", icon: Orbit, to: { kind: "ions" } },
  ...SETTINGS_PAGES.map((p) => ({
    title: p.label,
    icon: p.icon,
    small: "Settings",
    to: { kind: "settings" as const, page: p.id },
  })),
  // Plan 21 Task 6 tour: what waits inside a page (under its More, or low on it) is one search away too.
  ...(
    [
      ["Check the agents each night", "agents", false],
      ["Check as judge", "agents", true],
      ["Prefer in this order", "agents", true],
      ["Dream", "memory", true],
    ] as const
  ).map(([title, page, more]) => {
    const p = SETTINGS_PAGES.find((x) => x.id === page)!;
    return {
      title,
      icon: p.icon,
      small: `Settings · ${p.label}`,
      to: { kind: "settings" as const, page, ...(more ? { more: true as const } : {}) },
    };
  }),
];

/** Whether `q` is in any of the words shown (a title and its quiet part). */
const has = (q: string, ...shown: (string | null | undefined)[]) =>
  !q || shown.some((s) => (s ?? "").toLowerCase().includes(q));

/** Chats (newest first, none archived), ions and actions that match `q`; with words, Ask ion last. */
function groupsOf(q: string, words: string, chats: ChatInfo[], ions: IonInfo[]): Group[] {
  const chatItems = chats
    .map((c) => ({ c, small: c.projectId ? projectName(c.projectId) : undefined }))
    .filter(({ c, small }) => !c.archived && has(q, c.title, small))
    .slice(0, q ? 6 : 4)
    .map(({ c, small }) => ({
      key: `c:${c.chatId}`,
      icon: c.projectId ? <CodeXml /> : <MessageSquare />,
      title: c.title,
      small,
      to: { kind: "chat" as const, chatId: c.chatId },
    }));
  const ionItems = ions
    .filter((i) => has(q, i.name))
    .slice(0, q ? 5 : 3)
    .map((i) => ({
      key: `i:${i.ionId}`,
      icon: <Avatar ion={i.ionId === "chief" ? "chief" : { harness: i.harness, color: i.color }} />,
      title: i.name,
      small: i.ionId === "chief" ? "All projects" : undefined,
      to: { kind: "ion" as const, ionId: i.ionId },
    }));
  const actions = ACTIONS.filter((a) => has(q, a.title, a.small))
    .slice(0, q ? 8 : 3)
    .map((a) => ({
      key: `a:${a.title}:${a.small ?? ""}`,
      icon: <a.icon />,
      title: a.title,
      small: a.small,
      to: a.to,
    }));
  const ask: Item[] = words
    ? [
        {
          key: "ask",
          icon: <Avatar ion="chief" />,
          title: `Ask ion: “${words}”`,
          to: { kind: "ion", ionId: "chief" },
          ask: words,
          // As in the lab: ↵ asks only when nothing else matches; else ⌘↵.
          hint: chatItems.length + ionItems.length + actions.length ? "⌘↵" : "↵",
        },
      ]
    : [];
  return [
    { name: q ? "Chats" : "Recent", items: chatItems },
    { name: "Ions", items: ionItems },
    { name: "Actions", items: actions },
    { name: "", items: ask },
  ].filter((g) => g.items.length);
}

/** Your chats and ions, read when Search opens. */
function useLists(client: IonClient, open: boolean): [ChatInfo[], IonInfo[]] {
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [ions, setIons] = useState<IonInfo[]>([]);
  useEffect(() => {
    if (!open) return;
    const by = (c: ChatInfo) => c.lastActivityAt ?? "";
    void client.call("chats.list", {}).then(
      (c) => setChats([...c].sort((a, b) => by(b).localeCompare(by(a)))),
      () => {},
    );
    void client.call("ions.list", {}).then(setIons, () => {});
  }, [client, open]);
  return [chats, ions];
}

/** The results, grouped, the one at `at` marked. */
function Results(p: { groups: Group[]; at: number; onPick: (i: Item) => void; onAt: (n: number) => void }) {
  let n = -1;
  if (!p.groups.length) return <div className="pempty">Nothing found</div>;
  return p.groups.map((g) => (
    <div key={g.name || "ask"} role="group" aria-label={g.name || undefined}>
      {g.name && <div className="pg">{g.name}</div>}
      {g.items.map((it) => {
        n += 1;
        const i = n;
        return (
          <button
            key={it.key}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={i === p.at}
            className={`pr${i === p.at ? " on" : ""}`}
            onClick={() => p.onPick(it)}
            onMouseMove={() => i !== p.at && p.onAt(i)}
          >
            {it.icon}
            <span className="tt">
              {it.title}
              {it.small && <small>{it.small}</small>}
            </span>
            <span className="r2" aria-hidden="true">
              {it.hint}
            </span>
          </button>
        );
      })}
    </div>
  ));
}

/** The lab's foot: how to move and open, and ⌘K. */
const Foot = () => (
  <div className="pfoot">
    <span>
      <kbd>↑</kbd>
      <kbd>↓</kbd>move
    </span>
    <span>
      <kbd>↵</kbd>open
    </span>
    <span className="sp" />
    <span>
      <kbd>⌘</kbd>
      <kbd>K</kbd>
    </span>
  </div>
);

/** The words box: it has the focus while Search is open. */
function Box(p: { q: string; onQ: (q: string) => void; onKey: (e: KeyboardEvent) => void }) {
  return (
    <div className="pin">
      <SearchIcon />
      <input
        // biome-ignore lint/a11y/noAutofocus: Search opens to type in
        autoFocus
        type="text"
        role="combobox"
        aria-label="Search"
        aria-expanded="true"
        aria-controls="pres"
        placeholder="Search chats and ions, or ask ion"
        autoComplete="off"
        spellCheck={false}
        value={p.q}
        onChange={(e) => p.onQ(e.target.value)}
        onKeyDown={p.onKey}
      />
      <kbd>esc</kbd>
    </div>
  );
}

/** Whether Search is open: ⌘K toggles it, the rail opens it; closing gives the focus back. */
function useOpen() {
  const [open, setOpen] = useState(false);
  const back = useRef<Element | null>(null);
  const show = useCallback(() => {
    back.current = document.activeElement;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    if (back.current instanceof HTMLElement) back.current.focus();
  }, []);
  useSearchKey(
    useCallback(() => (open ? close() : show()), [open, close, show]),
    show,
  );
  return { open, close };
}

/**
 * Going where a result points; Ask ion asks first, then opens ion's chat, and a failure keeps Search open with your
 * words, saying why (Plan 21 final review, M9).
 */
function usePick(client: IonClient, close: () => void, go: (to: Place) => void) {
  const [failed, setFailed] = useState<string | null>(null);
  const pick = (it: Item | undefined) => {
    if (!it) return;
    const done = () => {
      close();
      go(it.to);
    };
    if (!it.ask) return done();
    void client
      .call("ion.message", { ionId: "chief", text: it.ask })
      .then(done, (e: unknown) => setFailed(why(e)));
  };
  return { failed, setFailed, pick };
}

/**
 * The lab's Search (⌘K): your chats, ions and actions (each screen and Settings page), so nothing tucked under More is
 * out of reach (Plan 21 Task 4); free text asks ion. `go` takes you to a result.
 */
export function Search({ client, go }: { client: IonClient; go: (to: Place) => void }) {
  const { open, close } = useOpen();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [chats, ions] = useLists(client, open);
  const { failed, setFailed, pick } = usePick(client, close, go);
  useEffect(() => {
    if (open) return;
    setQ("");
    setAt(0);
    setFailed(null);
  }, [open, setFailed]);
  if (!open) return null;
  const words = q.trim();
  const groups = groupsOf(words.toLowerCase(), words, chats, ions);
  const items = groups.flatMap((g) => g.items);
  const onKey = (e: KeyboardEvent) => {
    // Review of Plan 21 Task 4: Search's keys stay in Search (no double-Esc Stop, no ⌘B behind it); ⌘K still closes.
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (e.key === "Escape" || hit("search", e)) close();
    // ⌘↵ asks ion from its row only (none: an empty box asks nothing).
    else if (e.key === "Enter") pick(e.metaKey || e.ctrlKey ? items.find((i) => i.ask) : items[at]);
    else if (step) setAt((at + step + items.length) % Math.max(1, items.length));
    else if (e.key !== "Tab") return;
    e.preventDefault();
  };
  const onQ = (next: string) => {
    setQ(next);
    setAt(0);
    setFailed(null);
  };
  return (
    <div className="pal" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="pbox" role="dialog" aria-modal="true" aria-label="Search">
        <Box q={q} onQ={onQ} onKey={onKey} />
        {failed && <div className="perr">{failed}</div>}
        <div className="pres" id="pres" role="listbox" aria-label="Results">
          <Results groups={groups} at={Math.min(at, items.length - 1)} onPick={pick} onAt={setAt} />
        </div>
        <Foot />
      </div>
    </div>
  );
}
