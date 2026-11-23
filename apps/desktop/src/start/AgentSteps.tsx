import type { IonClient } from "@ion/client/browser";
import { CircleCheck, Copy, RotateCw } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { useState } from "react";
import { useAgentSignIn, useSignInsWaiting } from "../settings/AgentSignIn.js";
import { stepOf } from "./steps.js";

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

/** One agent: Ready, or "Install:" / "Sign in:" with the command to copy (and ion's own Sign in where it can). */
function AgentRow({ client, h, reload }: { client: IonClient; h: HarnessInfo; reload: () => void }) {
  const step = stepOf(h);
  return (
    <div className="farow">
      <span className="nm">{h.label}</span>
      {step.state === "ready" ? (
        <span className="ok">
          <CircleCheck />
          Ready
        </span>
      ) : (
        <>
          <span className="g">{step.state === "install" ? "Install:" : "Sign in:"}</span>
          {step.command && <Command text={step.command} />}
          {step.state === "signIn" && h.signIn?.inApp && <SignIn client={client} h={h} reload={reload} />}
        </>
      )}
    </div>
  );
}

/**
 * Your agents, one row each, and Check again (Plan 21): the first run's step 1, and what a message box with no agent
 * ready shows instead of a Send that silently stays grey. `onCheck` reads every agent again now; `onReload` reads
 * what ion knows (while a sign-in ion started is going).
 */
export function AgentSteps(p: {
  client: IonClient;
  harnesses: HarnessInfo[];
  onCheck: () => Promise<unknown> | void;
  onReload?: () => void;
  title?: string;
  n?: number;
}) {
  const [checking, setChecking] = useState(false);
  const reload = p.onReload ?? (() => void p.onCheck());
  useSignInsWaiting(p.harnesses, reload);
  const check = () => {
    setChecking(true);
    void Promise.resolve(p.onCheck()).finally(() => setChecking(false));
  };
  return (
    <>
      <div className="fh2">
        {p.n && <span className="n">{p.n}</span>}
        {p.title ?? "Your agents"}
        <span className="sp" />
        <button className="ib" type="button" title="Check again" aria-label="Check again" onClick={check}>
          {checking ? <i className="spin" /> : <RotateCw />}
        </button>
      </div>
      {p.harnesses.length ? (
        <div className="fagents">
          {p.harnesses.map((h) => (
            <AgentRow key={h.id} client={p.client} h={h} reload={reload} />
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
