import type { IonClient } from "@ion/client/browser";
import type { HarnessInfo, IonInfo, IonSettings, ProjectInfo } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";

export type SettingsData = {
  harnesses: HarnessInfo[];
  settings: IonSettings | null;
  ions: IonInfo[];
  projects: ProjectInfo[];
  /** Reads everything again (after a change made here). */
  reload: () => void;
};

/** What Settings shows, read when it opens and again after each change. */
export function useSettingsData(client: IonClient): SettingsData {
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [settings, setSettings] = useState<IonSettings | null>(null);
  const [ions, setIons] = useState<IonInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const reload = useCallback(() => {
    const quiet = () => {};
    void client.call("harnesses.list", {}).then(setHarnesses, quiet);
    void client.call("settings.get", {}).then(setSettings, quiet);
    void client.call("ions.list", {}).then(setIons, quiet);
    void client.call("projects.list", {}).then(setProjects, quiet);
  }, [client]);
  useEffect(reload, [reload]);
  return { harnesses, settings, ions, projects, reload };
}

/** Ready: installed and signed in. */
export const ready = (h: HarnessInfo) => h.installed && h.signedIn;
