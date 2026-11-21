import { Avatar, Layers, Puzzle } from "@ion/design-system";
import type { HarnessInfo, PluginBundles, ToolsInfo } from "@ion/schema";
import { ToolRow } from "./tools-parts.js";

/**
 * Each agent's own tools beside ion's (the user, 2026-11-21: agents bring their own servers, skills and plugins). One row
 * per thing several have (matched by name and setup), every face on it, ion's too; the same name set up differently is
 * a row each, marked Differs. A row is read-only unless it's ion's.
 */

/** Whose rows are shown: everyone's, ion's, or one agent's. */
export type Whose = "all" | string;

/** One row: its name, who has it (ion first, then agents), ion's own entry if ion has it, and why it differs. */
export type Merged<T> = { name: string; agents: string[]; ion?: T; differs?: string };

type Item<T> = { agent: string; name: string; key: string; item?: T };

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
      return { name, agents, ...(ion ? { ion } : {}), ...(setups.size > 1 ? { differs } : {}) };
    }),
  );
}

/** The rows a chip shows: all of them, or those this one has. */
export const whoseRows = <T,>(rows: Merged<T>[], whose: Whose) =>
  whose === "all" ? rows : rows.filter((r) => r.agents.includes(whose));

/** Every agent on it is one whose own tools are off in ion (and ion doesn't have it). */
export const offIn = (r: { agents: string[] }, own: ToolsInfo["own"]) =>
  !r.agents.includes("ion") && r.agents.every((a) => own.agents[a] === false);

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

/** A row that isn't ion's: who has it, why it differs, and "Off in ion" (dimmed) when its agents' own are off. */
export function OwnRow(p: {
  icon: Parameters<typeof ToolRow>[0]["icon"];
  r: Merged<unknown>;
  line?: React.ReactNode;
  agents: HarnessInfo[];
  off: boolean;
}) {
  return (
    <ToolRow
      icon={p.icon}
      name={p.r.name}
      chip={p.r.differs ? "Differs" : null}
      {...(p.r.differs ? { chipTitle: p.r.differs } : {})}
      line={p.line}
      dim={p.off}
      mid={<Faces who={p.r.agents} agents={p.agents} />}
      end={p.off ? <span className="s">Off in ion</span> : null}
    />
  );
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

/** Settings → Tools → Plugins: each agent's installed plugins, read-only, with what each brings. */
export function Plugins(p: { info: ToolsInfo; agents: HarnessInfo[]; whose: Whose }) {
  const items = p.info.own.plugins.map((x) => ({
    agent: x.agent,
    name: x.name,
    key: x.version ?? "",
    item: x,
  }));
  const rows = whoseRows(merge(items, "Another version"), p.whose);
  if (!rows.length) return null;
  return (
    <div className="group">
      {rows.map((r, i) => {
        const one = p.info.own.plugins.find((y) => y.name === r.name && r.agents.includes(y.agent));
        const what = one ? [bundled(one.bundles), one.hooks ? HOOKS[one.hooks] : ""].filter(Boolean) : [];
        return (
          <OwnRow
            key={`${r.name}:${i}`}
            icon={Puzzle}
            r={r}
            agents={p.agents}
            off={offIn(r, p.info.own)}
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
