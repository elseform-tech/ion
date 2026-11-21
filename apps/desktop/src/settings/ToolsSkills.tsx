import { BookOpen } from "@ion/design-system";
import type { HarnessInfo, SkillInfo } from "@ion/schema";
import { useCallError } from "../callError.js";
import type { SettingsData } from "./data.js";
import { Switch } from "./Switch.js";
import { type Part, partOf, stateOf, type TabProps, ToolRow } from "./tools-parts.js";
import { Faces, type Merged, merge, OwnRow, offIn, type Whose, whoseRows } from "./tools-own.js";

const about = (s: SkillInfo) => (
  <span className="clamp" title={s.description}>
    {s.description}
  </span>
);

/** One of ion's skills (ion passes it to Claude Code when on): who has it, by face, and its switch. */
function SkillRow(p: { s: SkillInfo; r: Merged<SkillInfo>; part: Part; agents: HarnessInfo[] }) {
  const { s, part } = p;
  const [error, run] = useCallError();
  const ion = Object.values(s.support).includes("ion");
  const state = ion ? stateOf(s, part.locked) : null;
  const chip = state ?? (p.r.differs ? "Differs" : null);
  return (
    <>
      <ToolRow
        icon={BookOpen}
        name={s.name}
        chip={chip}
        {...(chip === "Differs" && p.r.differs ? { chipTitle: p.r.differs } : {})}
        {...(s.origin ? { origin: s.origin } : {})}
        at={part.at === s.name}
        mid={<Faces who={p.r.agents} agents={p.agents} />}
        line={about(s)}
        end={
          ion ? (
            <Switch
              label={s.name}
              on={s.on}
              onPick={(on) => run(part.client.call("tools.setOn", { kind: "skill", id: s.id, on }), part.set)}
            />
          ) : null
        }
      />
      {error && <div className="perr">{error}</div>}
    </>
  );
}

/**
 * Settings → Tools → Skills: ion's (on or off) and each agent's own (read-only), one row per skill several have with
 * the same files. `at`: the skill a chat's link opened.
 */
export function Skills(p: TabProps & { data: SettingsData; whose: Whose }) {
  const part = partOf(p);
  const agents = p.data.harnesses;
  const items = p.info.skills.map((s) => ({ agent: s.own ?? "ion", name: s.name, key: s.hash, item: s }));
  const rows = whoseRows(merge(items, "Different files"), p.whose);
  if (!rows.length) return null;
  const first = (r: Merged<SkillInfo>) =>
    p.info.skills.find((s) => s.name === r.name && r.agents.includes(s.own ?? "ion"));
  return (
    <div className="group">
      {rows.map((r, i) => {
        const s = first(r);
        if (r.ion) return <SkillRow key={r.ion.id} s={r.ion} r={r} part={part} agents={agents} />;
        return (
          <OwnRow
            key={`${r.name}:${i}`}
            icon={BookOpen}
            r={r}
            agents={agents}
            off={offIn(r, p.info.own)}
            line={s ? about(s) : null}
          />
        );
      })}
    </div>
  );
}
