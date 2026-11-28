import type { IonClient } from "@ion/client/browser";
import { NOTIFY_DEFAULTS as D, type ProjectInfo, type SettingsInfo, type ToolsInfo } from "@ion/schema";
import { useEffect, useState } from "react";
import type { SettingsData } from "./data.js";
import type { SettingsPage } from "./pages.js";

/**
 * Plan 21 Task 4 (the user, 2026-11-24: advanced things appear when they matter): what makes a tucked part of Settings
 * "used", so it shows without More. Each reads what you've set, never what you've looked at.
 */

/** A project's ion has something of yours: a routine, its chats' own agent, a profile, or not shared with ion. */
const ionUsed = (p: ProjectInfo) =>
  !!p.routines?.length || !!p.harness || !!p.model || !!p.effort || !!p.profile || p.shareWithIon === false;

/** ion's own tools you added: a connection, a hook or a skill in ion's folder. */
const toolsUsed = (t: Partial<ToolsInfo> | null) =>
  !!t?.mcp?.length || !!t?.hooks?.some((g) => g.hooks?.length) || !!t?.skills?.some((s) => s.whose === "ion");

/** Notifications not as they start: the briefing or quiet hours changed, or a project not at "Needs me". */
function notificationsUsed(n: SettingsInfo["notifications"] | undefined): boolean {
  if (!n) return false;
  const { briefing: b, quiet: q } = n;
  if (b.on !== D.briefing.on || b.at !== D.briefing.at) return true;
  if (q.on !== D.quiet.on || q.from !== D.quiet.from || q.to !== D.quiet.to) return true;
  return Object.values(n.projects ?? {}).some((l) => l !== D.level);
}

/** ion's own tools, read once for whether Tools is used. */
function useToolsUsed(client: IonClient): boolean {
  const [used, setUsed] = useState(false);
  useEffect(() => {
    let gone = false;
    void client.call("tools.list", {}).then(
      (t) => !gone && setUsed(toolsUsed(t)),
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [client]);
  return used;
}

/** The tucked pages you've used (Shortcuts never is: it only lists keys). */
export function useUsedPages(client: IonClient, data: SettingsData): Set<SettingsPage> {
  const tools = useToolsUsed(client);
  const used = new Set<SettingsPage>();
  if (data.projects.some(ionUsed)) used.add("ions");
  if (tools) used.add("tools");
  if (notificationsUsed(data.settings?.notifications)) used.add("notifications");
  return used;
}
