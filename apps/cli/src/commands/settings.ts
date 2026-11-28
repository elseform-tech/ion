import type { NotifyLevel, SettingsInfo, SettingsPatch } from "@ion/schema";
import type { Command } from "commander";
import { withClient } from "../connect.js";
import { fail, type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

/**
 * `ion settings …` (review of Plan 21 Task 4, 2026-11-28): what the app keeps in Settings → Notifications and each
 * agent's switches, so nothing the app tucks under More is out of the CLI's reach.
 */

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const LEVELS: Record<NotifyLevel, string> = {
  all: "All",
  needs: "Needs me",
  digest: "Digest",
  muted: "Muted",
};

/** Saves `patch` (none: reads), then prints what `line` says of the settings. */
const save = (out: () => Out, patch: SettingsPatch | null, line: (s: SettingsInfo) => string) =>
  withClient((c) => (patch ? c.call("settings.set", { patch }) : c.call("settings.get", {}))).then((s) =>
    print(out(), line(s), s),
  );

/** "on" or "off" as a switch; undefined: none given. */
function onOff(word: string | undefined, say: string): boolean | undefined {
  if (word === undefined) return undefined;
  if (word !== "on" && word !== "off") fail(say);
  return word === "on";
}

function briefingCommand(s: Command, out: () => Out) {
  s.command("briefing [when]")
    .description("ion's daily briefing: on, off, or a time (08:30)")
    .action((when?: string) => {
      if (when !== undefined && !TIME.test(when) && when !== "on" && when !== "off")
        fail("Say on, off or 08:30");
      let briefing: { on: boolean; at?: string } | null = null;
      if (when !== undefined) briefing = TIME.test(when) ? { on: true, at: when } : { on: when === "on" };
      return save(out, briefing && { notifications: { briefing } }, (x) => {
        const b = x.notifications.briefing;
        return `Briefing: ${b.on ? b.at : "off"}`;
      });
    });
}

function quietCommand(s: Command, out: () => Out) {
  s.command("quiet [hours]")
    .description("Quiet hours: on, off, or from-to (22:00-08:00)")
    .action((hours?: string) => {
      const [from, to] = (hours ?? "").split("-");
      const span = !!from && !!to && TIME.test(from) && TIME.test(to);
      if (hours !== undefined && !span && hours !== "on" && hours !== "off")
        fail("Say on, off or 22:00-08:00");
      let quiet: { on: boolean; from?: string; to?: string } | null = null;
      if (hours !== undefined) quiet = span ? { on: true, from, to } : { on: hours === "on" };
      return save(out, quiet && { notifications: { quiet } }, (x) => {
        const q = x.notifications.quiet;
        return q.on ? `Quiet hours: ${q.from}–${q.to}` : "Quiet hours: off";
      });
    });
}

function notifyCommand(s: Command, out: () => Out) {
  s.command("notify <project> [level]")
    .description("How much a project notifies: all, needs, digest or muted")
    .action((project: string, level?: string) => {
      if (level !== undefined && !(level in LEVELS)) fail("Say all, needs, digest or muted");
      const patch = level ? { notifications: { projects: { [project]: level as NotifyLevel } } } : null;
      return save(out, patch, (x) => {
        const l = x.notifications.projects[project];
        if (!l) fail(`Unknown project: ${project}`);
        return `${clean(project)}: ${LEVELS[l]}`;
      });
    });
}

/** `ion settings avoid|own-tools <agent> [on|off]`: an agent's two switches in Settings → Agents. */
function agentSwitches(s: Command, out: () => Out) {
  const say = "Say on or off";
  s.command("avoid <agent> [on|off]")
    .description("Avoid an agent unless you ask for it")
    .action((agent: string, word?: string) => {
      const on = onOff(word, say);
      const patch = on === undefined ? null : { avoid: { [agent]: on } };
      return save(
        out,
        patch,
        (x) => `${clean(agent)} · Avoid unless I ask: ${x.avoid[agent] ? "on" : "off"}`,
      );
    });
  s.command("own-tools <agent> [on|off]")
    .description("Let an agent use its own tools too (on by default)")
    .action((agent: string, word?: string) => {
      const on = onOff(word, say);
      const patch = on === undefined ? null : { ownTools: { [agent]: on } };
      return save(
        out,
        patch,
        (x) => `${clean(agent)} · Use its own tools: ${x.ownTools[agent] === false ? "off" : "on"}`,
      );
    });
}

export function settingsCommands(program: Command, out: () => Out) {
  const s = program.command("settings").description("Notifications and each agent's switches");
  briefingCommand(s, out);
  quietCommand(s, out);
  notifyCommand(s, out);
  agentSwitches(s, out);
}
