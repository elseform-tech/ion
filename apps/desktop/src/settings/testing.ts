import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { SettingsInfo } from "@ion/schema";
import { vi } from "vitest";

/** For tests: every setting, as the daemon reads them by default. */
export const settings: SettingsInfo = {
  quick: "grok-build",
  effort: null,
  maxRuns: "auto",
  autoRuns: 4,
  notifications: {
    briefing: { on: true, at: "08:30" },
    quiet: { on: true, from: "22:00", to: "08:00" },
    projects: { shop: "needs" },
  },
  ownTools: { "claude-code": true, "grok-build": true },
  dream: { mode: "off", agent: null },
  memory: { on: true, projects: { shop: true } },
  agentOrder: ["opencode", "grok-build", "codex", "claude-code"],
  onLimit: "ask",
  byUsage: false,
};

/** A daemon that answers Settings; `refuse`: settings.set says no with this reason. */
export function settingsClient(o: { now?: SettingsInfo; refuse?: string } = {}) {
  const call = vi.fn(async (cmd: string) => {
    if (cmd === "settings.get") return o.now ?? settings;
    if (cmd === "settings.set") {
      if (o.refuse) throw new ApiCallError("invalid", o.refuse);
      return o.now ?? settings;
    }
    if (cmd === "projects.list") return [{ id: "shop", name: "Shop", path: "/p/shop", starred: true }];
    return [];
  });
  return { call, subscribe: vi.fn(async () => () => {}) } as unknown as IonClient & { call: typeof call };
}
