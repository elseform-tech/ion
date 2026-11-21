import { BookOpen } from "@ion/design-system";
import type { HarnessInfo, SkillInfo } from "@ion/schema";
import { useCallError } from "../callError.js";
import { ready, type SettingsData } from "./data.js";
import { Switch } from "./Switch.js";
import { type Part, partOf, stateOf, type TabProps, ToolRow, Works } from "./tools-parts.js";

/**
 * A skill: the agents that use it (faces, as Connections shows them; tour, 2026-11-21), and a switch when ion passes
 * it (Claude Code's); the other agents read their own.
 */
function SkillRow({ s, part, agents }: { s: SkillInfo; part: Part; agents: HarnessInfo[] }) {
  const [error, run] = useCallError();
  const ion = Object.values(s.support).includes("ion");
  return (
    <>
      <ToolRow
        icon={BookOpen}
        name={s.name}
        chip={ion ? stateOf(s, part.locked) : null}
        {...(s.origin ? { origin: s.origin } : {})}
        at={part.at === s.name}
        mid={<Works agents={agents} works={(id) => !!s.support[id]} />}
        line={
          <span className="clamp" title={s.description}>
            {s.description}
          </span>
        }
        end={
          <>
            {ion ? (
              <Switch
                label={s.name}
                on={s.on}
                onPick={(on) =>
                  run(part.client.call("tools.setOn", { kind: "skill", id: s.id, on }), part.set)
                }
              />
            ) : (
              <span className="s">Uses its own</span>
            )}
          </>
        }
      />
      {error && <div className="perr">{error}</div>}
    </>
  );
}

/** Settings → Tools → Skills: the skills your agents already have. `at`: the skill a chat's link opened; `data`: whose agents are ready. */
export function Skills(p: TabProps & { data: SettingsData }) {
  const part = partOf(p);
  const agents = p.data.harnesses.filter(ready);
  if (!p.info.skills.length) return null;
  return (
    <div className="group">
      {p.info.skills.map((s) => (
        <SkillRow key={s.id} s={s} part={part} agents={agents} />
      ))}
    </div>
  );
}
