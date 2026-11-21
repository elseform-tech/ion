import type { IonClient } from "@ion/client/browser";
import { BookOpen, Check, FileCog, type LucideIcon, PlugZap, Webhook } from "@ion/design-system";
import { useState } from "react";
import type { ToolsAt } from "../goto.js";
import type { ToolsInfo } from "@ion/schema";
import { type Run, useCallError } from "../callError.js";
import { CANT_OPEN, openFile } from "../opener.js";
import { ready, type SettingsData } from "./data.js";
import { type ImportData, useImports, useTools } from "./tools-data.js";
import { Connections } from "./ToolsConnections.js";
import { ImportAll, ImportLines } from "./ToolsImport.js";
import { Hooks } from "./ToolsHooks.js";
import { Skills } from "./ToolsSkills.js";

type Tab = "mcp" | "hooks" | "skills";
const TABS: [Tab, string, LucideIcon][] = [
  ["mcp", "Connections", PlugZap],
  ["hooks", "Hooks", Webhook],
  ["skills", "Skills", BookOpen],
];

/** Opens mcp.json in your editor; outside the app it copies the path (and says so with a check). */
function OpenFile({ path, onFail }: { path: string; onFail: (failed: boolean) => void }) {
  const [copied, setCopied] = useState(false);
  const name = copied ? "Path copied" : "Open config file";
  return (
    <button
      className="ib"
      type="button"
      title={name}
      aria-label={name}
      onClick={() =>
        void openFile(path).then((r) => {
          onFail(r === "failed");
          if (r !== "copied") return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check /> : <FileCog />}
    </button>
  );
}

/** Connections: Import's lines, a call that failed, then your servers. */
function McpTab(p: {
  client: IonClient;
  data: SettingsData;
  info: ToolsInfo | null;
  set: (t: ToolsInfo) => void;
  at: string | null;
  imports: ImportData;
  run: Run;
  error: string | null;
}) {
  return (
    <>
      {p.error && <div className="perr">{p.error}</div>}
      <ImportLines data={p.imports} run={p.run} />
      {p.info && (
        <Connections
          client={p.client}
          agents={p.data.harnesses.filter(ready)}
          info={p.info}
          set={p.set}
          at={p.at}
        />
      )}
    </>
  );
}

const TAB_OF: Record<ToolsAt["kind"], Tab> = { mcp: "mcp", hook: "hooks", skill: "skills" };

/**
 * Settings → Tools, as the lab's renderTools: Connections, Hooks and Skills, each an icon named on hover. `at`: the
 * row a chat's link opened (its tab first).
 */
export function Tools({ client, data, at }: { client: IonClient; data: SettingsData; at?: ToolsAt | null }) {
  const { info, set } = useTools(client);
  const imports = useImports(client, set);
  const [importError, runImport] = useCallError();
  const [tab, setTab] = useState<Tab>(at ? TAB_OF[at.kind] : "mcp");
  const atName = (kind: ToolsAt["kind"]) => (at?.kind === kind ? at.name : null);
  const [cantOpen, setCantOpen] = useState(false);
  return (
    <div>
      <div className="tabs2">
        <span className="seg sm" role="group" aria-label="Tools">
          {TABS.map(([id, name, Icon]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "on" : ""}
              title={name}
              aria-label={name}
              onClick={() => setTab(id)}
            >
              <Icon />
            </button>
          ))}
        </span>
        {tab === "mcp" && info && (
          <>
            <ImportAll data={imports} />
            <OpenFile path={info.mcpFile} onFail={setCantOpen} />
          </>
        )}
      </div>
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
        />
      )}
      {info && tab === "hooks" && <Hooks client={client} info={info} set={set} at={atName("hook")} />}
      {info && tab === "skills" && (
        <Skills client={client} info={info} set={set} at={atName("skill")} data={data} />
      )}
    </div>
  );
}
