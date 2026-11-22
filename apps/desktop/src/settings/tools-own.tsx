import { Avatar, Layers, Puzzle } from "@ion/design-system";
import type { HarnessInfo, OwnPluginInfo, PluginBundles, ToolsInfo } from "@ion/schema";
import { ToolRow } from "./tools-parts.js";

/**
 * Each agent's own tools beside ion's (the user, 2026-11-21: agents bring their own servers, skills and plugins). One row
 * per thing several have (matched by name and setup), every face on it, ion's too; the same name set up differently is
 * a row each, marked Differs. A row is read-only unless it's ion's.
 */

/** Where a row came from, beside its name (a repo's file, a project's skills): not yours. */
export const fromOf = (source: string) => ({ by: "you" as const, source, at: "" });

/** Whose rows are shown: everyone's, ion's, or one agent's. */
export type Whose = "all" | string;

/** One row: its name, who has it (ion first, then agents), ion's own entry if ion has it, and why it differs. */
export type Merged<T> = { name: string; agents: string[]; ion?: T; differs?: string; fresh?: true };

/** `fresh`: an agent's own that appeared since ion last listed them (New, once). */
type Item<T> = { agent: string; name: string; key: string; item?: T; fresh?: true };

/** Merges what each has: by name, then by setup (`key`); a name with more than one setup marks each `differs`. */
export function merge<T>(items: Item<T>[], differs: string): Merged<T>[] {
  const byName = new Map<string, Map<string, Item<T>[]>>();
  for (const x of items) {
    const setups = byName.get(x.name) ?? new Map<string, Item<T>[]>();
    setups.set(x.key, [...(setups.get(x.key) ?? []), x]);
    byName.set(x.name, setups);
  }
  return [...byName].flatMap(([name, setups]) =>
    [...setups.values()].map((xs) => {
      const ion = xs.find((x) => x.agent === "ion")?.item;
      const agents = [...new Set(xs.map((x) => x.agent))];
      const fresh = xs.some((x) => x.fresh) ? { fresh: true as const } : {};
      return { name, agents, ...(ion ? { ion } : {}), ...(setups.size > 1 ? { differs } : {}), ...fresh };
    }),
  );
}

/** The rows a chip shows: all of them, or those this one has. */
export const whoseRows = <T,>(rows: Merged<T>[], whose: Whose) =>
  whose === "all" ? rows : rows.filter((r) => r.agents.includes(whose));

/** The kinds a switch turns off. */
export type Kind = "servers" | "skills" | "plugins";

/**
 * A row's state in ion when its agents' own tools are off (task review, 2026-11-21): "off" when every agent on it has
 * its switch off and that switch really turns this kind off; "also" when one of them has it off but loads this kind
 * anyway; else none. ion's own rows are never either.
 */
export function offIn(r: { agents: string[] }, own: ToolsInfo["own"], kind: Kind, agents: HarnessInfo[]) {
  if (r.agents.includes("ion")) return null;
  const off = r.agents.filter((a) => own.agents[a] === false);
  if (!off.length) return null;
  const turnsOff = (a: string) => agents.find((h) => h.id === a)?.ownOff?.[kind] ?? true;
  if (off.length === r.agents.length && off.every(turnsOff)) return "off" as const;
  return off.some((a) => !turnsOff(a)) ? ("also" as const) : null;
}

/** ion's face, or an agent's. */
const Face = ({ id }: { id: string }) => (id === "ion" ? <Avatar ion="chief" /> : <Avatar harness={id} />);

const labelOf = (agents: HarnessInfo[], id: string) => agents.find((h) => h.id === id)?.label ?? id;

/** The faces of who has it: ion's, then each agent's ("From Claude Code"), as elsewhere. */
export function Faces({ who, agents }: { who: string[]; agents: HarnessInfo[] }) {
  return who.map((id) => (
    <span key={id} title={id === "ion" ? "ion" : `From ${labelOf(agents, id)}`}>
      <Face id={id} />
    </span>
  ));
}

/** Under the tabs (Hooks stay ion's): All, ion, then each agent, by face, named on hover. */
export function WhoseChips(p: { whose: Whose; agents: HarnessInfo[]; onPick: (w: Whose) => void }) {
  const chips: [Whose, string][] = [
    ["all", "All"],
    ["ion", "ion"],
    ...p.agents.map((h): [Whose, string] => [h.id, h.label]),
  ];
  return (
    <span className="seg sm whose" role="group" aria-label="Whose">
      {chips.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={p.whose === id ? "on" : ""}
          title={label}
          aria-label={label}
          onClick={() => p.onPick(id)}
        >
          {id === "all" ? <Layers /> : <Face id={id} />}
        </button>
      ))}
    </span>
  );
}

const STATE = { off: "Off in ion", also: "Also loads its own" } as const;

/**
 * A row that isn't ion's: who has it, why it differs, and "Off in ion" (dimmed) when its agents' switches turn it off,
 * or "Also loads its own" when one is off but its agent loads it anyway.
 */
export function OwnRow(p: {
  icon: Parameters<typeof ToolRow>[0]["icon"];
  r: Merged<unknown>;
  line?: React.ReactNode;
  agents: HarnessInfo[];
  off: "off" | "also" | null;
}) {
  return (
    <ToolRow
      icon={p.icon}
      name={p.r.name}
      chip={chipOf(p.r)}
      {...(p.r.differs && !p.r.fresh ? { chipTitle: p.r.differs } : {})}
      line={p.line}
      dim={p.off === "off"}
      mid={<Faces who={p.r.agents} agents={p.agents} />}
      end={p.off ? <span className="s">{STATE[p.off]}</span> : null}
    />
  );
}

/** New (it appeared since ion last listed them) before Differs. */
function chipOf(r: Merged<unknown>): string | null {
  if (r.fresh) return "New";
  return r.differs ? "Differs" : null;
}

/** "4 skills, 1 server": what a plugin brings, in small words. */
function bundled(b: PluginBundles): string {
  const parts: [number, string][] = [
    [b.skills, "skill"],
    [b.servers, "server"],
    [b.commands, "command"],
    [b.agents, "agent"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`)
    .join(", ");
}

const HOOKS = { off: "Its hooks don't run in ion", run: "Its hooks run too" } as const;
const HOOKS_SHORT = { off: "don't run in ion", run: "run too" } as const;

/** Its hooks, for every agent on the row: one line when they agree, else each agent's (task review, 2026-11-21). */
function hooksLine(plugins: OwnPluginInfo[], agents: HarnessInfo[]): string {
  const said = plugins.filter((x) => x.hooks);
  const kinds = [...new Set(said.map((x) => x.hooks!))];
  if (kinds.length < 2) return kinds[0] ? HOOKS[kinds[0]] : "";
  const each = said.map(
    (x) => `${HOOKS_SHORT[x.hooks!]} (${agents.find((h) => h.id === x.agent)?.label ?? x.agent})`,
  );
  return `Its hooks ${each.join(", ")}`;
}

/** Settings → Tools → Plugins: each agent's installed plugins, read-only, with what each brings. */
export function Plugins(p: { info: ToolsInfo; agents: HarnessInfo[]; whose: Whose }) {
  // Matched by name and version; one with no version by what's in it (task review, 2026-11-21).
  const items = p.info.own.plugins.map((x) => ({
    agent: x.agent,
    name: x.name,
    key: x.version ?? x.hash ?? "",
    item: x,
  }));
  const rows = whoseRows(merge(items, "Another version"), p.whose);
  if (!rows.length) return null;
  return (
    <div className="group">
      {rows.map((r, i) => {
        const all = p.info.own.plugins.filter((y) => y.name === r.name && r.agents.includes(y.agent));
        const what = all[0] ? [bundled(all[0].bundles), hooksLine(all, p.agents)].filter(Boolean) : [];
        return (
          <OwnRow
            key={`${r.name}:${i}`}
            icon={Puzzle}
            r={r}
            agents={p.agents}
            off={offIn(r, p.info.own, "plugins", p.agents)}
            line={what.map((w) => (
              <span key={w} className="part">
                {w}
              </span>
            ))}
          />
        );
      })}
    </div>
  );
}
