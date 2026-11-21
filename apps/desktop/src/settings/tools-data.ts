import { ApiCallError, type IonClient } from "@ion/client/browser";
import { EV, type ImportInfo, type ToolsInfo } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";

/** What the daemon's Tools events mean here: read the list again. */
const REREAD: string[] = [EV.toolSignedIn, EV.toolNeedsSignIn, EV.hookRan];

export type ToolsData = {
  info: ToolsInfo | null;
  /** Shows what a change answered (every tools.* change answers the whole list). */
  set: (info: ToolsInfo) => void;
};

/**
 * Settings → Tools, read when it opens, again when the window gets focus (you may have saved mcp.json in your
 * editor: the daemon reads it on each call), and when a sign-in finishes or a hook runs.
 */
export function useTools(client: IonClient): ToolsData {
  const [info, set] = useState<ToolsInfo | null>(null);
  const read = useCallback(() => {
    void client.call("tools.list", {}).then(set, () => {});
  }, [client]);
  useEffect(() => {
    let gone = false;
    let stop: (() => void) | undefined;
    read();
    window.addEventListener("focus", read);
    void client
      .subscribe({ fromNow: true }, (e) => {
        if (REREAD.includes(e.type)) read();
      })
      .then(
        (s) => {
          if (gone) s();
          else stop = s;
        },
        () => {},
      );
    return () => {
      gone = true;
      stop?.();
      window.removeEventListener("focus", read);
    };
  }, [client, read]);
  return { info, set };
}

export type ImportData = {
  imports: ImportInfo | null;
  /** The servers shown before they come in (by name); null: none shown. */
  shown: string[] | null;
  show: (names: string[] | null) => void;
  /** Imports these servers (by name; one in a project's own file with that file), then reads the list again. */
  bring: (names: string[], repo?: string) => Promise<void>;
  dismiss: (agent?: string) => Promise<void>;
};

/**
 * Import: the servers in your agents' own configs, read only when Tools opens (the daemon reads the files then, and
 * never on focus), and after an import or a dismiss. Nothing comes in before it's been shown.
 */
export function useImports(client: IonClient, set: (info: ToolsInfo) => void): ImportData {
  const [imports, setImports] = useState<ImportInfo | null>(null);
  const [shown, show] = useState<string[] | null>(null);
  const read = useCallback(() => client.call("tools.importable", {}).then(setImports, () => {}), [client]);
  useEffect(() => {
    void read();
  }, [read]);
  const bring = async (names: string[], repo?: string) => {
    const r = await client.call("tools.import", { names, ...(repo ? { repo } : {}) });
    show(null);
    await Promise.all([client.call("tools.list", {}).then(set), read()]);
    // What didn't come in, and why (task review, 2026-11-21: it was never said).
    if (r.skipped.length)
      throw new ApiCallError("invalid", r.skipped.map((x) => `${x.name}: ${x.why}`).join("\n"));
  };
  const dismiss = (agent?: string) =>
    client.call("tools.dismissImport", agent ? { agent } : {}).then(setImports);
  return { imports, shown, show, bring, dismiss };
}
