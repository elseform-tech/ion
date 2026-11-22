import type { IonClient } from "@ion/client/browser";
import { Spinner } from "@ion/design-system";
import type { Commands, PickInfo, Picks } from "@ion/schema";
import {
  type KeyboardEvent,
  type Ref,
  type RefObject,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ICON, KIND, Pieces } from "./PickChips.js";
import { chipKey, type InlinePick, inOrder, outOfChip, type Span, spansOf } from "./pickText.js";

/**
 * "/" and "@" in a message box (the user, 2026-11-21): "/" lists the agent's own skills and commands and ion's, "@" its
 * servers. Typing filters, Enter (or Tab) picks, Escape closes. A pick stays in the text where you typed it ("/review"),
 * drawn there as a chip (the user, 2026-11-22), and the message goes with its names in that order.
 */
/** `kinds` and `labels`: what each pick is and how its chip reads (a resource's mention is "<server> resource <uri>"). */
export type Picked = {
  skills: string[];
  mentions: string[];
  kinds?: Record<string, PickInfo["kind"]>;
  labels?: Record<string, string>;
};

/** What a pick sends: a server's or skill's name, or "<server> resource <uri>" for a resource. */
const sentAs = (item: PickInfo) =>
  item.kind === "resource" && item.server && item.uri ? `${item.server} resource ${item.uri}` : item.name;

/** A pick as it sits in the text: "/" and its name for a skill or command, "@" and its name for a connection's. */
function inlineOf(item: PickInfo): InlinePick {
  const skill = item.kind === "skill" || item.kind === "command";
  const token = `${skill ? "/" : "@"}${item.name}`;
  return { name: sentAs(item), k: skill ? "skills" : "mentions", kind: item.kind, token };
}

/** Picks as a message sends them, in their order (with their kinds and chips' words). */
function pickedOf(picks: InlinePick[]): Picked {
  const of = (k: "skills" | "mentions") => picks.filter((p) => p.k === k).map((p) => p.name);
  return {
    skills: of("skills"),
    mentions: of("mentions"),
    kinds: Object.fromEntries(picks.map((p) => [p.name, p.kind])),
    labels: Object.fromEntries(picks.map((p) => [p.name, p.token.slice(1)])),
  };
}
const SHOWN = 8;

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
function menuKey(key: string, shift: boolean, n: number): "close" | "pick" | "wait" | number | null {
  if (key === "Escape") return "close";
  if (!n) return null;
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return n - 1;
  return (key === "Enter" && !shift) || key === "Tab" ? "pick" : null;
}

/** The text with an item picked in place of the word being typed, and where the caret goes (after it and a space). */
function placed(text: string, word: { start: number }, caret: number, token: string) {
  const rest = text.slice(caret).replace(/^\S*/, "");
  const next = `${text.slice(0, word.start)}${token}${rest.startsWith(" ") ? "" : " "}${rest}`;
  return { text: next, caret: word.start + token.length + 1 };
}

/** The caret the picker reads, and where it moves it once the box shows its new text (after a pick or a chip's key). */
function useCaretMove(text: string, setText: (t: string) => void) {
  const [caret, setCaret] = useState(0);
  const [want, setWant] = useState<{ at: number; n: number } | null>(null);
  const moveTo = (next: string, at: number) => {
    if (next !== text) setText(next);
    setCaret(at);
    setWant((w) => ({ at, n: (w?.n ?? 0) + 1 }));
  };
  return { caret, setCaret, want, moveTo };
}

/** A chip's keys (Backspace, Delete, arrows, without modifiers): handled when one is at the caret. */
function chipKeys(
  e: KeyboardEvent<HTMLTextAreaElement>,
  text: string,
  spans: Span[],
  moveTo: MoveTo,
): boolean {
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
  const el = e.currentTarget;
  const did = chipKey(e.key, text, { start: el.selectionStart, end: el.selectionEnd }, spans);
  if (!did) return false;
  e.preventDefault();
  moveTo(did.text, did.caret);
  return true;
}
type MoveTo = (text: string, at: number) => void;

/** The caret moved (typing, a click): a click into a chip goes to its end. */
function tracked(el: HTMLTextAreaElement, spans: Span[]): number {
  const at = el.selectionStart ?? el.value.length;
  const out = el.selectionStart === el.selectionEnd ? outOfChip(at, spans) : at;
  if (out !== at) el.setSelectionRange(out, out);
  return out;
}

/** The menu's word at the caret (not a chip's own token, not one you closed), its matches and the one Enter picks. */
function useMenu(o: PickerOpts, caret: number, spans: Span[]) {
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState<string | null>(null);
  const typed = wordAt(o.text, caret);
  const word = typed && !spans.some((s) => s.start === typed.start) ? typed : null;
  const open = word && closed !== `${word.start}${word.mark}` ? word : null;
  const list = usePickList(o.client, o.args, Boolean(open));
  const pool = (open?.mark === "/" ? list?.skills : list?.servers) ?? [];
  const shown = open ? matching(pool, open.query) : [];
  const ref = useRef(shown);
  ref.current = shown;
  useEffect(() => setActive(0), [open?.mark, open?.query]);
  /** The menu's keys while it's open; `pick` takes the item Enter or Tab chose. */
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>, pick: (item: PickInfo) => void): boolean => {
    if (!open) return false;
    // The list is still coming: Enter waits for it, never sending the "/word" as text.
    const did = !list && e.key === "Enter" ? "wait" : menuKey(e.key, e.shiftKey, ref.current.length);
    if (did === "close") setClosed(`${open.start}${open.mark}`);
    else if (typeof did === "number") setActive((a) => (a + did) % ref.current.length);
    else if (did === "pick") pick(ref.current[Math.min(active, ref.current.length - 1)]!);
    if (did !== null) e.preventDefault();
    return did !== null;
  };
  return { open, shown, active, loading: !list, keys };
}

type PickerOpts = {
  client: IonClient;
  args: Commands["tools.picks"]["args"];
  text: string;
  setText: (t: string) => void;
};

/**
 * The picker for one box: what's picked (the picks its text holds), the menu (its word, its matches, the one Enter
 * picks), and the box's key handler (the menu's keys while it's open, then a chip's: Backspace, Delete, arrows).
 */
export function usePicker(o: PickerOpts) {
  const [chosen, setChosen] = useState<InlinePick[]>([]);
  const { caret, setCaret, want, moveTo } = useCaretMove(o.text, o.setText);
  const id = useId();
  const spans = spansOf(o.text, chosen);
  const m = useMenu(o, caret, spans);
  const pick = (item: PickInfo) => {
    if (!m.open) return;
    const p = inlineOf(item);
    setChosen((c) => [...c.filter((x) => x.token !== p.token), p]);
    const next = placed(o.text, m.open, caret, p.token);
    moveTo(next.text, next.caret);
  };
  const picked = pickedOf(inOrder(spans));
  return {
    picked,
    spans,
    want,
    id,
    /** Arguments with what the text holds of your picks, in order (the box starts afresh). */
    take: <T extends object>(a: T) => {
      setChosen([]);
      return { ...a, ...pickArgs(picked) };
    },
    track: (el: HTMLTextAreaElement) => setCaret(tracked(el, spans)),
    onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => m.keys(e, pick) || chipKeys(e, o.text, spans, moveTo),
    menu: m.open
      ? { mark: m.open.mark, items: m.shown, active: m.active, loading: m.loading, pick, id }
      : null,
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
  // Still coming (a server may be starting to list its resources): a sign it's on its way.
  if (menu.loading)
    return (
      <div className="pmenu smenu" aria-busy="true">
        <Spinner label="Loading" />
      </div>
    );
  if (!menu.items.length) return null;
  return (
    <div
      id={`${menu.id}-list`}
      className="pmenu smenu"
      role="listbox"
      aria-label={menu.mark === "/" ? "Skills" : "Connections"}
    >
      {menu.items.map((item, i) => {
        const Icon = ICON[item.kind];
        return (
          <button
            key={`${item.kind}:${item.server ?? ""}:${item.name}`}
            id={`${menu.id}-${i}`}
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

/** The box as a combobox for screen readers: whether its list is open, which it is, and which option Enter picks. */
const comboOf = (menu: Menu | null) => ({
  role: "combobox",
  "aria-autocomplete": "list" as const,
  "aria-expanded": Boolean(menu?.items.length),
  ...(menu?.items.length
    ? { "aria-controls": `${menu.id}-list`, "aria-activedescendant": `${menu.id}-${menu.active}` }
    : {}),
});

/**
 * A message box's text area with "/" and "@": the menu above it, its picks drawn as chips in place (a copy of its
 * text under it, the box's own letters see-through while it holds one), and its keys (the menu's and a chip's first,
 * then the box's own). It stays a text field: its picks are named for screen readers.
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
  const own = useRef<HTMLTextAreaElement | null>(null);
  const copy = useRef<HTMLDivElement>(null);
  useCaret(own, pk);
  const text = typeof p.box.value === "string" ? p.box.value : "";
  const chips = pk.spans.length > 0;
  return (
    <>
      {pk.menu && <PickMenu menu={pk.menu} />}
      <div className={`cfield${chips ? " inl" : ""}`}>
        {chips && <Mirror text={text} spans={pk.spans} copy={copy} />}
        <textarea
          {...p.box}
          ref={(el) => {
            own.current = el;
            setRef(p.box.ref, el);
          }}
          {...comboOf(pk.menu)}
          {...(chips ? { "aria-describedby": `${pk.id}-picks` } : {})}
          onChange={(e) => {
            p.onEdit(e.target.value);
            pk.track(e.target);
          }}
          onSelect={(e) => pk.track(e.currentTarget)}
          onScroll={(e) => {
            if (copy.current) copy.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={(e) => pk.onKey(e) || p.onKey(e)}
        />
        {chips && <Named id={`${pk.id}-picks`} spans={pk.spans} />}
      </div>
    </>
  );
}

/** The box's text drawn again under it, each pick a chip in place (a last character keeps a trailing new line). */
const Mirror = (p: { text: string; spans: Span[]; copy: RefObject<HTMLDivElement | null> }) => (
  <div className="cmirror" aria-hidden="true" ref={p.copy}>
    <Pieces text={p.text} spans={p.spans} />
    {"\u200b"}
  </div>
);

/** The box's picks in words, for screen readers. */
const Named = (p: { id: string; spans: Span[] }) => (
  <span id={p.id} hidden>
    {p.spans.map((s) => `${KIND[s.pick.kind]}: ${s.pick.token.slice(1)}`).join(", ")}
  </span>
);

/** The caret where a pick or a chip's key put it, once the box shows its new text. */
function useCaret(el: RefObject<HTMLTextAreaElement | null>, pk: ReturnType<typeof usePicker>) {
  const want = pk.want;
  useLayoutEffect(() => {
    if (want && el.current) el.current.setSelectionRange(want.at, want.at);
  }, [want, el]);
}

/** Hands the box to a ref given as a function or an object. */
function setRef(ref: Ref<HTMLTextAreaElement>, el: HTMLTextAreaElement | null) {
  if (typeof ref === "function") ref(el);
  else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el;
}
