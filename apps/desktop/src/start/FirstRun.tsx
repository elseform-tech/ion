import type { IonClient } from "@ion/client/browser";
import type { HarnessInfo, ProjectInfo } from "@ion/schema";
import { type ReactNode, useState } from "react";
import { Composer } from "../chats/Composer.js";
import { AgentSteps } from "./AgentSteps.js";
import { PickFolder } from "./PickFolder.js";
import { EXAMPLES } from "./steps.js";

type Props = {
  client: IonClient;
  harnesses: HarnessInfo[];
  onReload: () => void;
  onSent: (chatId: string) => void;
};

/** A first message you picked, put in the box (`n` counts picks, so the same one picked again goes in again). */
type Seed = { text: string; n: number } | null;

/** One step: its number and name, then what it holds. */
const Step = ({ n, name, children }: { n: number; name: string; children: ReactNode }) => (
  <div className="fstep">
    <div className="fh2">
      <span className="n">{n}</span>
      {name}
    </div>
    {children}
  </div>
);

/** Three first messages; one picked goes in the box. */
function Examples({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="fex">
      {EXAMPLES.map((text) => (
        <button key={text} className="chip" type="button" onClick={() => onPick(text)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Step 3: the message box, in the folder you picked (else `default`), with three first messages. */
function Ask(p: Props & { project: ProjectInfo | null }) {
  // `default` picked back in the project pill (null: the folder you picked, else `default`).
  const [chosen, setChosen] = useState<string | null>(null);
  const [seed, setSeed] = useState<Seed>(null);
  const { project } = p;
  const options = [
    { id: "default", name: "default" },
    ...(project ? [{ id: project.id, name: project.name ?? project.id }] : []),
  ];
  const projectId = chosen ?? project?.id ?? "default";
  return (
    <>
      <Composer
        client={p.client}
        harnesses={p.harnesses}
        onBrainOpen={p.onReload}
        to={{ projectId: projectId === "default" ? null : projectId }}
        running={null}
        project={{ value: projectId, options, onChange: setChosen }}
        onSent={p.onSent}
        agentsAbove
        seed={seed}
      />
      <Examples onPick={(text) => setSeed((s) => ({ text, n: (s?.n ?? 0) + 1 }))} />
    </>
  );
}

/**
 * The first run (Plan 21; the lab's `first` screen): with no projects and no chats, three steps on one screen, no
 * wizard pages: your agents, pick a folder, then the message box with three first messages. Your first message opens
 * its chat, and ion's usual screens take over.
 */
export function FirstRun(p: Props) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  return (
    <>
      <header className="head" data-tauri-drag-region>
        <span className="sp" />
      </header>
      <div className="first">
        <div className="inner">
          <h3>Start here</h3>
          <div className="fstep">
            <AgentSteps client={p.client} harnesses={p.harnesses} onReload={p.onReload} n={1} />
          </div>
          <Step n={2} name="Pick a folder">
            <PickFolder
              add={(path, confirm) =>
                p.client.call("projects.add", { path, ...(confirm ? { confirm } : {}) })
              }
              onAdded={setProject}
            />
          </Step>
          <Step n={3} name="Ask">
            {/* A new folder starts the box anew, on that folder. */}
            <Ask key={project?.id ?? "default"} {...p} project={project} />
          </Step>
        </div>
      </div>
    </>
  );
}
