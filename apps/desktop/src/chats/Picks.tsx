import type { IonClient } from "@ion/client/browser";
import { FileText, type LucideIcon, Plug, Sparkles, SquareTerminal, X } from "@ion/design-system";
import type { Commands, PickInfo, Picks } from "@ion/schema";
import {
  type KeyboardEvent,
  type Ref,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";

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
function wordAt(text: string, caret: number): { mark: "/" | "@"; query: string; start: number } | null {
  const m = /(^|\s)([/@])([^\s/@]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { mark: m[2] as "/" | "@", query: m[3] ?? "", start: caret - (m[3]?.length ?? 0) - 1 };
}

/** What a word matches: names that start with it first, then names or lines that hold it. */
function matching(items: PickInfo[], query: string): PickInfo[] {
  const q = query.toLowerCase();
  const starts = items.filter((i) => i.name.toLowerCase().startsWith(q));
  const holds = items.filter(
    (i) => !starts.includes(i) && `${i.name} ${i.description}`.toLowerCase().includes(q),
  );
  return [...starts, ...holds].slice(0, SHOWN);
}

/** Picks for a box, read once per box (and again when its agent changes); none when ion can't say. */
function usePickList(
  client: IonClient,
  args: Commands["tools.picks"]["args"],
  wanted: boolean,
): Picks | null {
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

/** What a key does while the menu is open: close it, move by n, pick, or nothing (null: the box takes it). */
function menuKey(key: string, shift: boolean, n: number): "close" | "pick" | number | null {
  if (key === "Escape") return "close";
  if (!n) return null;
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return n - 1;
  return (key === "Enter" && !shift) || key === "Tab" ? "pick" : null;
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
  const pool = (open?.mark === "/" ? list?.skills : list?.servers) ?? [];
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
    const did = menuKey(e.key, e.shiftKey, ref.current.length);
    if (did === "close") setClosed(`${open.start}${open.mark}`);
    else if (typeof did === "number") setActive((a) => (a + did) % ref.current.length);
    else if (did === "pick") pick(ref.current[Math.min(active, ref.current.length - 1)]!);
    if (did !== null) e.preventDefault();
    return did !== null;
  };
  const drop = (k: keyof Picked, name: string) =>
    setPicked({ ...picked, [k]: picked[k].filter((x) => x !== name) });
  return {
    picked,
    clear: () => setPicked(NONE),
    /** Arguments with what you picked (the picks leave the box). */
    take: <T extends object>(a: T) => {
      setPicked(NONE);
      return { ...a, ...pickArgs(picked) };
    },
    /** The caret moved (typing, a click): the word at it may have changed. */
    track: (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length),
    onKey,
    menu: open ? { mark: open.mark, items: shown, active, loading: !list, pick } : null,
    drop,
  };
}

/** What a message sends of its picks: only the ones there are. */
const pickArgs = (p: Picked) => ({
  ...(p.skills.length ? { skills: p.skills } : {}),
  ...(p.mentions.length ? { mentions: p.mentions } : {}),
});

type Menu = NonNullable<ReturnType<typeof usePicker>["menu"]>;

/** The menu above the box: each match with its icon (its kind on hover), name and one line. */
function PickMenu({ menu }: { menu: Menu }) {
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

/**
 * A message box's text area with "/" and "@": the menu above it, the picks as chips, and its keys (the menu's first,
 * then the box's own).
 */
export function PickedBox(p: {
  pk: ReturnType<typeof usePicker>;
  box: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "onKeyDown"> & {
    ref: Ref<HTMLTextAreaElement>;
  };
  onEdit: (text: string) => void;
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const { pk } = p;
  return (
    <>
      {pk.menu && <PickMenu menu={pk.menu} />}
      <PickChips picked={pk.picked} onDrop={pk.drop} />
      <textarea
        {...p.box}
        onChange={(e) => {
          p.onEdit(e.target.value);
          pk.track(e.target);
        }}
        onSelect={(e) => pk.track(e.currentTarget)}
        onKeyDown={(e) => pk.onKey(e) || p.onKey(e)}
      />
    </>
  );
}
