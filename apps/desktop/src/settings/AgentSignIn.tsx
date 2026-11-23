import { ApiCallError, type IonClient } from "@ion/client/browser";
import { Copy, ExternalLink, LogOut, X } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { type ReactNode, useEffect, useState } from "react";
import { why } from "../callError.js";
import { CANT_OPEN, openLink } from "../opener.js";
import { ready } from "./data.js";

/** What's open under an agent's row: ion's question before it goes on, a command to type, or why the last try failed. */
type Open = null | { ask: string; go: () => Promise<unknown> } | { command: string } | { error: string };

/** How often Settings reads the agents again while one of their sign-ins is going. */
const WAITING_MS = 2000;

/** Reads the agents again every two seconds while ion waits on one's sign-in (its row turns Signed in by itself). */
export function useSignInsWaiting(harnesses: HarnessInfo[], reload: () => void): void {
  const waiting = harnesses.some((h) => h.signingIn);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(reload, WAITING_MS);
    return () => clearInterval(t);
  }, [waiting, reload]);
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      className="ib"
      type="button"
      title="Copy"
      aria-label="Copy"
      onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}
    >
      <Copy />
    </button>
  );
}

/** The sign-in ion is waiting on: its page (open, copy) and its code (copy). */
function Waiting(p: { h: HarnessInfo; onError: (e: string) => void }) {
  const { url, code } = p.h.signingIn ?? { url: null, code: null };
  return (
    <div className="hsign">
      <i className="spin" />
      <span>Finish signing in in your browser</span>
      {url && (
        <span className="hpart">
          <button
            className="ib"
            type="button"
            title="Open"
            aria-label="Open sign-in page"
            onClick={() => openLink(url).catch(() => p.onError(CANT_OPEN))}
          >
            <ExternalLink />
          </button>
          <CopyButton text={url} />
        </span>
      )}
      {code && (
        <span className="hpart">
          <code className="hcode">{code}</code>
          <CopyButton text={code} />
        </span>
      )}
    </div>
  );
}

/** ion's question (sign out: it signs the agent out on this Mac), a command to copy, or what went wrong. */
function Panel(p: { open: NonNullable<Open>; onClose: () => void; onYes: () => void; yes: string }) {
  const o = p.open;
  if ("error" in o) return <div className="hsign perr">{o.error}</div>;
  if ("command" in o)
    return (
      <div className="hsign">
        <code>{o.command}</code>
        <CopyButton text={o.command} />
      </div>
    );
  return (
    <div className="hsign">
      <span className="g">{o.ask}</span>
      <button className="btn" type="button" onClick={p.onClose}>
        Cancel
      </button>
      <button className="btn pri" type="button" onClick={p.onYes}>
        {p.yes}
      </button>
    </div>
  );
}

/** Sign out (its icon) for an agent that's ready; Sign in for one installed and signed out; Cancel while it waits. */
function Action(p: { h: HarnessInfo; onSignIn: () => void; onSignOut: () => void; onCancel: () => void }) {
  const { h } = p;
  if (ready(h))
    return (
      <button
        className="ib"
        type="button"
        title="Sign out"
        aria-label={`Sign out of ${h.label}`}
        onClick={p.onSignOut}
      >
        <LogOut />
      </button>
    );
  if (h.signingIn)
    return (
      <button className="ib" type="button" title="Cancel" aria-label="Cancel sign-in" onClick={p.onCancel}>
        <X />
      </button>
    );
  if (!h.installed) return null;
  return (
    <button className="btn" type="button" onClick={p.onSignIn}>
      Sign in
    </button>
  );
}

/**
 * Signing in and out of one agent (the user, 2026-11-23): its own login and logout. ion asks first where the daemon
 * does (a sign-out signs the agent out on this Mac; Codex's sign-in clears the one it has), and shows the command to
 * type where the agent's own needs a terminal.
 */
export function useAgentSignIn(client: IonClient, h: HarnessInfo, reload: () => void) {
  const [open, setOpen] = useState<Open>(null);
  /** A call ion may answer with a question: asked under the row, then made again with your yes. */
  const ask = (call: (confirm: boolean) => Promise<{ kind: string; command?: string }>) => {
    const done = (r: { kind: string; command?: string }) => {
      setOpen(r.kind === "command" && r.command ? { command: r.command } : null);
      reload();
    };
    const failed = (e: unknown) => {
      setOpen({ error: why(e) });
      reload();
    };
    call(false).then(done, (e: unknown) => {
      if (e instanceof ApiCallError && e.code === "confirm")
        setOpen({ ask: e.message, go: () => call(true).then(done, failed) });
      else failed(e);
    });
  };
  const signIn = () => ask((confirm) => client.call("harness.login", { id: h.id, confirm }));
  const signOut = () => ask((confirm) => client.call("harness.logout", { id: h.id, confirm }));
  const cancel = () => void client.call("harness.cancelLogin", { id: h.id }).then(reload, reload);
  const action = <Action h={h} onSignIn={signIn} onSignOut={signOut} onCancel={cancel} />;
  let panel: ReactNode = null;
  if (h.signingIn) panel = <Waiting h={h} onError={(error) => setOpen({ error })} />;
  else if (open)
    panel = (
      <Panel
        open={open}
        yes={ready(h) ? "Sign out" : "Sign in"}
        onClose={() => setOpen(null)}
        onYes={() => "go" in open && void open.go()}
      />
    );
  return { action, panel };
}
