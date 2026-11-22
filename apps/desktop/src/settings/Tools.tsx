import type { IonClient } from "@ion/client/browser";
import { BookOpen, FileCog, type LucideIcon, PlugZap, Puzzle, Webhook } from "@ion/design-system";
import { useState } from "react";
import type { ToolsAt } from "../goto.js";
import type { ToolsInfo } from "@ion/schema";
import { type Run, useCallError } from "../callError.js";
import { CANT_OPEN } from "../opener.js";
import { IconTabs } from "./IconTabs.js";
import { OpenPath } from "./OpenPath.js";
import type { SettingsData } from "./data.js";
import { Plugins, type Whose, WhoseChips } from "./tools-own.js";
import { type ImportData, useImports, useTools } from "./tools-data.js";
import { Connections } from "./ToolsConnections.js";
import { ImportAll, ImportLines } from "./ToolsImport.js";
import { Hooks } from "./ToolsHooks.js";
import { Skills } from "./ToolsSkills.js";

type Tab = "mcp" | "skills" | "plugins" | "hooks";
/** By kind (the user, 2026-11-21): Connections, Skills, Plugins, then Hooks (ion's own). */
const TABS: [Tab, string, LucideIcon][] = [
  ["mcp", "Connections", PlugZap],
  ["skills", "Skills", BookOpen],
  ["plugins", "Plugins", Puzzle],
  ["hooks", "Hooks", Webhook],
];

/** Connections: what Import would bring in, a call that failed, then the servers. */
function McpTab(p: {
  client: IonClient;
  data: SettingsData;
  info: ToolsInfo | null;
  set: (t: ToolsInfo) => void;
  at: string | null;
  imports: ImportData;
  run: Run;
  error: string | null;
  whose: Whose;
}) {
  return (
    <>
      {p.error && <div className="perr">{p.error}</div>}
      <ImportLines data={p.imports} run={p.run} />
      {p.info && (
        <Connections
          client={p.client}
          agents={p.data.harnesses}
          info={p.info}
          set={p.set}
          at={p.at}
          whose={p.whose}
        />
      )}
    </>
  );
}

const TAB_OF: Record<ToolsAt["kind"], Tab> = { mcp: "mcp", hook: "hooks", skill: "skills" };

/**
 * Settings → Tools, as the lab's renderTools: Connections, Skills, Plugins and Hooks; under them (Hooks are ion's) chips
 * for whose. `at`: the
 * row a chat's link opened (its tab first).
 */
export function Tools({ client, data, at }: { client: IonClient; data: SettingsData; at?: ToolsAt | null }) {
  const { info, set } = useTools(client);
  const imports = useImports(client, set);
  const [importError, runImport] = useCallError();
  const [tab, setTab] = useState<Tab>(at ? TAB_OF[at.kind] : "mcp");
  const atName = (kind: ToolsAt["kind"]) => (at?.kind === kind ? at.name : null);
  const [cantOpen, setCantOpen] = useState(false);
  const [whose, setWhose] = useState<Whose>("all");
  return (
    <div>
      <div className="tabs2">
        <IconTabs label="Tools" tabs={TABS} tab={tab} onPick={setTab} />
        {tab === "mcp" && info && (
          <>
            <ImportAll data={imports} />
            <OpenPath path={info.mcpFile} name="Open config file" icon={FileCog} onFail={setCantOpen} />
          </>
        )}
      </div>
      {tab !== "hooks" && <WhoseChips whose={whose} agents={data.harnesses} onPick={setWhose} />}
      {tab === "mcp" && (
        <McpTab
          client={client}
          data={data}
          info={info}
          set={set}
          at={atName("mcp")}
          imports={imports}
          run={runImport}
          error={cantOpen ? CANT_OPEN : importError}
          whose={whose}
        />
      )}
      {info && tab === "hooks" && <Hooks client={client} info={info} set={set} at={atName("hook")} />}
      {info && tab === "skills" && (
        <Skills client={client} info={info} set={set} at={atName("skill")} data={data} whose={whose} />
      )}
      {info && tab === "plugins" && <Plugins info={info} agents={data.harnesses} whose={whose} />}
    </div>
  );
}
