import type { IonClient } from "@ion/client/browser";
import { FileText, type LucideIcon, Plug, Sparkles, SquareTerminal, X } from "@ion/design-system";
import type { Commands, PickInfo, Picks } from "@ion/schema";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

/**
 * "/" and "@" in a message box (the user, 2026-11-21): "/" lists the agent's own skills and commands and ion's, "@" its
 * servers. Typing filters, Enter (or Tab) picks, Escape closes; a pick leaves the text and shows as a chip, and the
 * message goes with its names.
 */
export type Picked = { skills: string[]; mentions: string[] };
const NONE: Picked = { skills: [], mentions: [] };
const SHOWN = 8;

const ICON: Record<PickInfo["kind"], LucideIcon> = {
  skill: Sparkles,
  command: SquareTerminal,
  server: Plug,
  resource: FileText,
};
const KIND: Record<PickInfo["kind"], string> = {
  skill: "Skill",
  command: "Command",
  server: "Connection",
  resource: "Resource",
};

/** The "/" or "@" word being typed at the caret, and where it starts; null when there's none. */
export function wordAt(text: string, caret: number): { mark: "/" | "@"; query: string; start: number } | null {
  const m = /(^|\s)([/@])([^\s/@]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { mark: m[2] as "/" | "@", query: m[3] ?? "", start: caret - (m[3]?.length ?? 0) - 1 };
}

/** What a word matches: names that start with it first, then names or lines that hold it. */
export function matching(items: PickInfo[], query: string): PickInfo[] {
  const q = query.toLowerCase();
  const starts = items.filter((i) => i.name.toLowerCase().startsWith(q));
  const holds = items.filter(
    (i) => !starts.includes(i) && `${i.name} ${i.description}`.toLowerCase().includes(q),
  );
  return [...starts, ...holds].slice(0, SHOWN);
}

/** Picks for a box, read once per box (and again when its agent changes); none when ion can't say. */
function usePickList(client: IonClient, args: Commands["tools.picks"]["args"], wanted: boolean): Picks | null {
  const key = JSON.stringify(args);
  const [got, setGot] = useState<{ key: string; picks: Picks } | null>(null);
  const have = got?.key;
  useEffect(() => {
    if (!wanted || have === key) return;
    let live = true;
    client
      .call("tools.picks", JSON.parse(key) as Commands["tools.picks"]["args"])
      .then((picks) => live && setGot({ key, picks }))
      .catch(() => live && setGot({ key, picks: { skills: [], servers: [] } }));
    return () => {
      live = false;
    };
  }, [client, key, wanted, have]);
  return got?.key === key ? got.picks : null;
}

/**
 * The picker for one box: what's picked, the menu (its word, its matches, the one Enter picks), and the box's key
 * handler (it takes arrows, Enter, Tab and Escape while the menu is open).
 */
export function usePicker(o: {
  client: IonClient;
  args: Commands["tools.picks"]["args"];
  text: string;
  setText: (t: string) => void;
}) {
  const [picked, setPicked] = useState<Picked>(NONE);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState<string | null>(null);
  const word = wordAt(o.text, caret);
  const open = word && closed !== `${word.start}${word.mark}` ? word : null;
  const list = usePickList(o.client, o.args, Boolean(open));
  const pool = open && list ? (open.mark === "/" ? list.skills : list.servers) : [];
  const shown = open ? matching(pool, open.query) : [];
  const ref = useRef(shown);
  ref.current = shown;
  useEffect(() => setActive(0), [open?.mark, open?.query]);
  const pick = (item: PickInfo) => {
    if (!open) return;
    const k = item.kind === "skill" || item.kind === "command" ? "skills" : "mentions";
    const name = item.kind === "resource" && item.server ? `${item.server}:${item.name}` : item.name;
    if (!picked[k].includes(name)) setPicked({ ...picked, [k]: [...picked[k], name] });
    o.setText(o.text.slice(0, open.start) + o.text.slice(caret).replace(/^\S*/, ""));
    setCaret(open.start);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === "Escape") {
      setClosed(`${open.start}${open.mark}`);
      e.preventDefault();
      return true;
    }
    const n = ref.current.length;
    if (!n) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      e.preventDefault();
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      pick(ref.current[Math.min(active, n - 1)]!);
      e.preventDefault();
      return true;
    }
    return false;
  };
  const drop = (k: keyof Picked, name: string) => setPicked({ ...picked, [k]: picked[k].filter((x) => x !== name) });
  return {
    picked,
    clear: () => setPicked(NONE),
    /** The caret moved (typing, a click): the word at it may have changed. */
    track: (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length),
    onKey,
    menu: open ? { mark: open.mark, items: shown, active, loading: !list, pick } : null,
    drop,
  };
}

/** What a message sends of its picks: only the ones there are. */
export const pickArgs = (p: Picked) => ({
  ...(p.skills.length ? { skills: p.skills } : {}),
  ...(p.mentions.length ? { mentions: p.mentions } : {}),
});

type Menu = NonNullable<ReturnType<typeof usePicker>["menu"]>;

/** The menu above the box: each match with its icon (its kind on hover), name and one line. */
export function PickMenu({ menu }: { menu: Menu }) {
  if (!menu.items.length) return null;
  return (
    <div className="pmenu smenu" role="listbox" aria-label={menu.mark === "/" ? "Skills" : "Connections"}>
      {menu.items.map((item, i) => {
        const Icon = ICON[item.kind];
        return (
          <button
            key={`${item.kind}:${item.server ?? ""}:${item.name}`}
            type="button"
            role="option"
            aria-selected={i === menu.active}
            className={i === menu.active ? "act" : undefined}
            // Picked on mouse down, so the box keeps its focus.
            onMouseDown={(e) => {
              e.preventDefault();
              menu.pick(item);
            }}
          >
            <span title={KIND[item.kind]} style={{ display: "flex" }}>
              <Icon />
            </span>
            <span className="nm">{item.name}</span>
            {item.description && <span className="ds">{item.description}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The picks as chips: a skill's or command's, a server's; each with its remove button. */
export function PickChips(p: { picked: Picked; onDrop?: (k: keyof Picked, name: string) => void }) {
  const all = [
    ...p.picked.skills.map((name) => ({ k: "skills" as const, name, Icon: Sparkles })),
    ...p.picked.mentions.map((name) => ({ k: "mentions" as const, name, Icon: Plug })),
  ];
  if (!all.length) return null;
  return (
    <div className="catt">
      {all.map(({ k, name, Icon }) => (
        <span key={`${k}:${name}`} className="chip pick">
          <Icon />
          {name}
          {p.onDrop && (
            <button type="button" aria-label={`Remove ${name}`} onClick={() => p.onDrop?.(k, name)}>
              <X />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
