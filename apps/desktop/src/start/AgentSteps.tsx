import type { IonClient } from "@ion/client/browser";
import { CircleCheck, Copy, RotateCw } from "@ion/design-system";
import type { AgentStep, HarnessInfo } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";
import { useAgentSignIn, useSignInsWaiting } from "../settings/AgentSignIn.js";

/** A command to type, and its Copy. */
function Command({ text }: { text: string }) {
  return (
    <>
      <code>{text}</code>
      <button
        className="ib"
        type="button"
        title="Copy"
        aria-label="Copy"
        onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}
      >
        <Copy />
      </button>
    </>
  );
}

/** An agent ion can sign in itself (Plan 20/#35): its Sign in, and the page and code once it's going. */
function SignIn({ client, h, reload }: { client: IonClient; h: HarnessInfo; reload: () => void }) {
  const { action, panel } = useAgentSignIn(client, h, reload);
  return (
    <>
      <span className="sp" />
      {action}
      {panel}
    </>
  );
}

/** What a step's row says before its command. */
const SAYS: Record<AgentStep["state"], string> = {
  ready: "Ready",
  install: "Install:",
  signIn: "Sign in:",
  checking: "Checking",
};

/** One agent: Ready, or "Install:" / "Sign in:" with the command to copy (and ion's own Sign in where it can). */
function AgentRow(p: { client: IonClient; step: AgentStep; h: HarnessInfo | undefined; reload: () => void }) {
  const { step, h } = p;
  return (
    <div className="farow">
      <span className="nm">{step.label}</span>
      {step.state === "ready" ? (
        <span className="ok">
          <CircleCheck />
          Ready
        </span>
      ) : (
        <>
          <span className="g">{SAYS[step.state]}</span>
          {step.command && <Command text={step.command} />}
          {step.inApp && h && <SignIn client={p.client} h={h} reload={p.reload} />}
        </>
      )}
    </div>
  );
}

/**
 * Each agent's step, as ion says it (`start.status`; review of Plan 21 Task 2, 2026-11-23: the app had its own copy
 * of the rules): read again when the agents change, and now with `fresh` (Check again).
 */
function useSteps(client: IonClient, harnesses: HarnessInfo[]) {
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const read = useCallback(
    (fresh: boolean) =>
      client.call("start.status", fresh ? { fresh } : {}).then(
        (s) => setSteps(s?.agents ?? []),
        () => {},
      ),
    [client],
  );
  // The agents changing (one installed or signed in) is what asks again.
  const known = harnesses.map((h) => `${h.id}:${h.installed}:${h.signedIn}`).join();
  useEffect(() => {
    if (known !== undefined) void read(false);
  }, [read, known]);
  return { steps, read };
}

/**
 * Your agents, one row each, and Check again (Plan 21): the first run's step 1, and what a message box with no agent
 * ready shows instead of a Send that silently stays grey. Check again reads every agent again now; `onReload` reads
 * the app's list of agents (after Check again, and while a sign-in ion started is going).
 */
export function AgentSteps(p: {
  client: IonClient;
  harnesses: HarnessInfo[];
  onReload?: () => void;
  title?: string;
  n?: number;
}) {
  const [checking, setChecking] = useState(false);
  const reload = p.onReload ?? (() => {});
  const { steps, read } = useSteps(p.client, p.harnesses);
  useSignInsWaiting(p.harnesses, reload);
  const check = () => {
    setChecking(true);
    void read(true).finally(() => {
      setChecking(false);
      reload();
    });
  };
  return (
    <>
      <div className="fh2">
        {p.n !== undefined && <span className="n">{p.n}</span>}
        {p.title ?? "Your agents"}
        <span className="sp" />
        <button className="ib" type="button" title="Check again" aria-label="Check again" onClick={check}>
          {checking ? <i className="spin" /> : <RotateCw />}
        </button>
      </div>
      {steps.length ? (
        <div className="fagents">
          {steps.map((step) => (
            <AgentRow
              key={step.id}
              client={p.client}
              step={step}
              h={p.harnesses.find((h) => h.id === step.id)}
              reload={reload}
            />
          ))}
        </div>
      ) : (
        // The tour, 2026-11-23: a fresh ion reads opencode for 30 s, and the box stood empty meanwhile.
        <div className="fwait">
          <i className="spin" />
          Checking your agents
        </div>
      )}
    </>
  );
}
