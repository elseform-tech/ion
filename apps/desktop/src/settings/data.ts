import type { IonClient } from "@ion/client/browser";
import type { HarnessInfo, IonInfo, ProjectInfo, SettingsInfo } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";

export type SettingsData = {
  harnesses: HarnessInfo[];
  settings: SettingsInfo | null;
  ions: IonInfo[];
  projects: ProjectInfo[];
  /** Reads everything again (after a change made here). */
  reload: () => void;
};

/** What Settings shows, read when it opens and again after each change. */
export function useSettingsData(client: IonClient): SettingsData {
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [ions, setIons] = useState<IonInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const reload = useCallback(() => {
    const quiet = () => {};
    // Settings again once the agents are known: whom ion's models follow comes from them (PR #36 review, 2026-11-23).
    void client.call("harnesses.list", {}).then((h) => {
      setHarnesses(h);
      void client.call("settings.get", {}).then(setSettings, quiet);
    }, quiet);
    void client.call("settings.get", {}).then(setSettings, quiet);
    void client.call("ions.list", {}).then(setIons, quiet);
    void client.call("projects.list", {}).then(setProjects, quiet);
  }, [client]);
  useEffect(reload, [reload]);
  // Back to the window: read again, so a sign-in or sign-out made elsewhere (the CLI, a terminal) shows (review of
  // #35, 2026-11-23).
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return { harnesses, settings, ions, projects, reload };
}

/** Ready: installed and signed in. */
export const ready = (h: HarnessInfo) => h.installed && h.signedIn;
