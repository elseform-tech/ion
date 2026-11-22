import { FileText, type LucideIcon, Plug, Sparkles, SquareTerminal } from "@ion/design-system";
import type { PickInfo } from "@ion/schema";
import type { Picked } from "./Picks.js";
import { type InlinePick, piecesOf, type Span, spansOf } from "./pickText.js";

/** Each kind of pick's icon (the menu's) and name (on hover, and for screen readers). */
export const ICON: Record<PickInfo["kind"], LucideIcon> = {
  skill: Sparkles,
  command: SquareTerminal,
  server: Plug,
  resource: FileText,
};
export const KIND: Record<PickInfo["kind"], string> = {
  skill: "Skill",
  command: "Command",
  server: "Connection",
  resource: "Resource",
};

/** A chip's kind: as picked, else read from the name (a message's picks come back as names). */
function kindOf(picked: Picked, k: "skills" | "mentions", name: string): PickInfo["kind"] {
  const known = picked.kinds?.[name];
  if (known) return known;
  if (k === "skills") return "skill";
  return name.includes(" resource ") ? "resource" : "server";
}

/** A chip's icon: the menu's for its kind. */
function ChipIcon(p: { picked: Picked; k: "skills" | "mentions"; name: string }) {
  const Icon = ICON[kindOf(p.picked, p.k, p.name)];
  return <Icon />;
}

/** A chip's words: what the menu showed; a resource's mention without that shows its server and URI. */
const chipWords = (picked: Picked, name: string) => picked.labels?.[name] ?? name.replace(" resource ", ": ");

/** Picks a message's text doesn't hold (sent before picks stayed in place, a resource's): chips above it. */
function PickChips(p: { picked: Picked }) {
  const all = [
    ...p.picked.skills.map((name) => ({ k: "skills" as const, name })),
    ...p.picked.mentions.map((name) => ({ k: "mentions" as const, name })),
  ];
  if (!all.length) return null;
  return (
    <div className="catt">
      {all.map(({ k, name }) => (
        <span key={`${k}:${name}`} className="chip pick">
          <ChipIcon picked={p.picked} k={k} name={name} />
          {chipWords(p.picked, name)}
        </span>
      ))}
    </div>
  );
}

/** A pick in the sentence: its token as a chip, its kind and name for screen readers and on hover. */
function InlineChip({ s }: { s: Span }) {
  const label = `${KIND[s.pick.kind]}: ${s.pick.token.slice(1)}`;
  return (
    <span className="chip pick inl" title={KIND[s.pick.kind]} aria-label={label}>
      {s.pick.token}
    </span>
  );
}

/** Text with its picks drawn in place as chips. */
export const Pieces = ({ text, spans }: { text: string; spans: Span[] }) =>
  piecesOf(text, spans).map((x, i) => (typeof x === "string" ? x : <InlineChip key={i} s={x} />));

/** A sent message's text, each pick drawn as a chip where it was typed; picks it doesn't hold above it. */
export function PickedText({ text, picked }: { text: string; picked: Picked | undefined }) {
  const picks: InlinePick[] = [
    ...(picked?.skills ?? []).map((name) => ({
      name,
      k: "skills" as const,
      kind: "skill" as const,
      token: `/${name}`,
    })),
    ...(picked?.mentions ?? [])
      .filter((m) => !m.includes(" resource "))
      .map((name) => ({ name, k: "mentions" as const, kind: "server" as const, token: `@${name}` })),
  ];
  const spans = spansOf(text, picks);
  const inline = new Set(spans.map((s) => s.pick.name));
  const rest = picked && {
    skills: picked.skills.filter((n) => !inline.has(n)),
    mentions: picked.mentions.filter((n) => !inline.has(n)),
  };
  return (
    <>
      {rest && <PickChips picked={rest} />}
      <Pieces text={text} spans={spans} />
    </>
  );
}
