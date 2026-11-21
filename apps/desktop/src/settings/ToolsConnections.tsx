import { ApiCallError, type IonClient } from "@ion/client/browser";
import { Copy, PlugZap } from "@ion/design-system";
import type { HarnessInfo, McpToolInfo, OwnServerInfo, ToolsInfo } from "@ion/schema";
import { useState } from "react";
import { useCallError } from "../callError.js";
import { CANT_OPEN, openLink } from "../opener.js";
import { Switch } from "./Switch.js";
import { short, stateOf, ToolRow } from "./tools-parts.js";
import { Faces, fromOf, type Merged, merge, OwnRow, offIn, type Whose, whoseRows } from "./tools-own.js";

type Part = {
  client: IonClient;
  agents: HarnessInfo[];
  set: (t: ToolsInfo) => void;
  locked: boolean;
  /** The connection a chat's link opened. */
  at?: string | null;
};

/** What a server runs, or where it connects (no query): the same setup reads the same, whoever has it. */
function launchOf(s: McpToolInfo): string {
  if (s.transport === "stdio") return [s.command, ...s.args].join(" ");
  try {
    const u = new URL(s.url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return s.url;
  }
}

/** An agent's own server's line: what it runs, or its host. */
function ownLine(launch: string) {
  if (!/^https?:\/\//.test(launch)) return <code title={launch}>{short(launch)}</code>;
  return new URL(launch).host;
}

/** Where it connects (the host, never the path or a value) or what it runs (one line; all of it on hover). */
function whereOf(s: McpToolInfo) {
  if (s.transport === "stdio") {
    const run = [s.command, ...s.args].join(" ");
    return <code title={run}>{short(run)}</code>;
  }
  try {
    return new URL(s.url).host;
  } catch {
    return short(s.url);
  }
}

/** A daemon refusal that means the server can't register ion: it needs a client ID from you. */
const NEEDS_CLIENT = /needs a client ID/;

/**
 * Boxes saved together on Enter, masked where they hold a secret. What you typed stays until it's saved (then it's
 * gone from here for good: the daemon keeps it in the keychain); `onSave` says whether it was.
 */
function Fields(p: {
  names: { name: string; masked: boolean }[];
  onSave: (v: Record<string, string>) => Promise<boolean>;
}) {
  const [v, setV] = useState<Record<string, string>>({});
  return (
    <div className="srow">
      {p.names.map(({ name, masked }) => (
        <input
          key={name}
          className="fin mono"
          type={masked ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          aria-label={name}
          placeholder={name}
          value={v[name] ?? ""}
          onChange={(e) => setV({ ...v, [name]: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            void p.onSave(v).then((saved) => saved && setV({}));
          }}
        />
      ))}
    </div>
  );
}

type Given = { clientId: string; clientSecret?: string };

/** A server that can't register ion: your client ID for it (and its secret, if it has one, masked). */
function ClientFields({ onSave }: { onSave: (g: Given) => Promise<boolean> }) {
  const names = [
    { name: "Client ID", masked: false },
    { name: "Client secret", masked: true },
  ];
  return (
    <Fields
      names={names}
      onSave={async (v) => {
        const clientId = v["Client ID"]?.trim();
        if (!clientId) return false;
        return onSave({ clientId, ...(v["Client secret"] ? { clientSecret: v["Client secret"] } : {}) });
      }}
    />
  );
}

/** A sign-in page on this computer (plain http): never opened by the app; its address, to copy into your browser. */
function LocalPage({ url }: { url: string }) {
  return (
    <div className="srow">
      <code className="g">{url}</code>
      <button
        className="ib"
        type="button"
        title="Copy"
        aria-label="Copy"
        onClick={() => void navigator.clipboard?.writeText(url).catch(() => {})}
      >
        <Copy />
      </button>
    </div>
  );
}

/** Sign in, Sign in again, or Add key: what a server needs before it can be used. */
function Needs(p: { s: McpToolInfo; onSignIn: () => void; onKey: () => void }) {
  const { needs } = p.s;
  if (needs === "sign in" || needs === "sign in again")
    return (
      <button className="btn" type="button" onClick={p.onSignIn}>
        {needs === "sign in" ? "Sign in" : "Sign in again"}
      </button>
    );
  if (needs === "key")
    return (
      <button className="btn" type="button" onClick={p.onKey}>
        Add key
      </button>
    );
  return null;
}

type Open = null | "key" | "client" | { local: string };

/** Signing in and keys for one server: what's open under its row, why the last try failed, and the calls. */
function useServer(s: McpToolInfo, part: Part) {
  const [error, run, clear] = useCallError();
  const [open, setOpen] = useState<Open>(null);
  const failed = (message: string) => run(Promise.reject(new ApiCallError("invalid", message)));
  const signIn = (given?: Given): Promise<boolean> =>
    part.client.call("tools.signIn", { id: s.id, ...given }).then(
      ({ url }) => {
        clear();
        if (url.startsWith("https://")) {
          setOpen(null);
          openLink(url).catch(() => failed(CANT_OPEN));
        } else setOpen({ local: url });
        return true;
      },
      (e: unknown) => {
        run(Promise.reject(e));
        if (e instanceof Error && NEEDS_CLIENT.test(e.message)) setOpen("client");
        return false;
      },
    );
  const saveKeys = async (v: Record<string, string>): Promise<boolean> => {
    const given = Object.entries(v).filter(([, key]) => key);
    try {
      for (const [name, key] of given)
        part.set(await part.client.call("tools.setKey", { id: s.id, name, key }));
      clear();
      return given.length > 0;
    } catch (e) {
      run(Promise.reject(e));
      return false;
    }
  };
  return { error, run, open, setOpen, signIn, saveKeys };
}

function ServerRow({ s, part, r }: { s: McpToolInfo; part: Part; r: Merged<McpToolInfo> }) {
  const { error, run, open, setOpen, signIn, saveKeys } = useServer(s, part);
  const state = s.needs === "can't reach" ? "Can't reach" : stateOf(s, part.locked);
  const chip = state ?? (r.differs ? "Differs" : null);
  const missing = s.missing ?? [];
  return (
    <>
      <ToolRow
        icon={PlugZap}
        name={s.name}
        chip={chip}
        {...(chip === "Differs" && r.differs ? { chipTitle: r.differs } : {})}
        line={whereOf(s)}
        {...(s.origin ? { origin: s.origin } : {})}
        at={part.at === s.name}
        mid={<Faces who={r.agents} agents={part.agents} />}
        end={
          <>
            <Needs
              s={s}
              onSignIn={() => void signIn()}
              onKey={() => setOpen(open === "key" ? null : "key")}
            />
            <Switch
              label={s.name}
              on={s.on}
              onPick={(on) => run(part.client.call("tools.setOn", { kind: "mcp", id: s.id, on }), part.set)}
            />
          </>
        }
      />
      {open === "key" && missing.length > 0 && (
        <Fields names={missing.map((name) => ({ name, masked: true }))} onSave={saveKeys} />
      )}
      {open === "client" && <ClientFields onSave={signIn} />}
      {typeof open === "object" && open && <LocalPage url={open.local} />}
      {error && <div className="perr">{error}</div>}
    </>
  );
}

/** Your mcp.json's servers (ion's) and each agent's own, one row per setup. */
function rowsOf(info: ToolsInfo): Merged<McpToolInfo>[] {
  // Matched by what makes a setup the same (task review, 2026-11-21: env, header and query names too): ion's hash.
  const ion = info.mcp.map((s) => ({ agent: "ion", name: s.name, key: s.match ?? launchOf(s), item: s }));
  const own = info.own.servers
    .filter((s) => !s.repo)
    .map((s) => ({ agent: s.agent, name: s.name, key: s.match }));
  return merge<McpToolInfo>([...ion, ...own], "Runs something else");
}

/**
 * A server in a project's own file (security review, 2026-11-21: the repo wrote it, not you): its switch, off until you
 * turn it on, which is consent to exactly what it runs; one that runs code from the repo has none: ion asks in each chat.
 */
function RepoRow({ s, part }: { s: OwnServerInfo; part: Part }) {
  const [error, run] = useCallError();
  const repo = s.repo!;
  return (
    <>
      <ToolRow
        icon={PlugZap}
        name={s.name}
        chip={repo.asks ? null : stateOf(repo, part.locked)}
        origin={fromOf(`From ${repo.project}'s ${repo.file}`)}
        line={
          <>
            {/* As the repo wrote it, whole (a URL's query too): it's yours to judge. */}
            <code title={s.launch}>{short(s.launch)}</code>
            {repo.headers && <span className="part">Headers: {repo.headers.join(", ")}</span>}
            {repo.env && <span className="part">Env: {repo.env.join(", ")}</span>}
          </>
        }
        mid={<Faces who={[s.agent]} agents={part.agents} />}
        end={
          repo.asks ? (
            <span className="s">Asks in each chat</span>
          ) : (
            <Switch
              label={s.name}
              on={repo.on}
              onPick={(on) =>
                run(part.client.call("tools.setOn", { kind: "repo", id: repo.id, on }), part.set)
              }
            />
          )
        }
      />
      {error && <div className="perr">{error}</div>}
    </>
  );
}

/**
 * Settings → Tools → Connections: each server in your mcp.json (what it needs, and on or off), and each agent's own
 * (read-only: they're the agent's), filtered by whose.
 */
export function Connections(p: {
  client: IonClient;
  agents: HarnessInfo[];
  info: ToolsInfo;
  set: (t: ToolsInfo) => void;
  at?: string | null;
  whose: Whose;
}) {
  const { info } = p;
  const part: Part = { ...p, locked: !!info.keychainProblem, at: p.at ?? null };
  const rows = whoseRows(rowsOf(info), p.whose);
  const launch = new Map(info.own.servers.map((s) => [`${s.agent}:${s.name}`, s.launch]));
  const leftOut = p.whose === "all" || p.whose === "ion" ? info.leftOut : [];
  const repos = info.own.servers.filter((s) => s.repo && (p.whose === "all" || p.whose === s.agent));
  return (
    <>
      {info.mcpProblem && <div className="perr">{info.mcpProblem}</div>}
      {info.keychainProblem && <div className="perr">{info.keychainProblem}</div>}
      {(rows.length > 0 || leftOut.length > 0 || repos.length > 0) && (
        <div className="group">
          {rows.map((r, i) =>
            r.ion ? (
              <ServerRow key={`ion:${r.ion.id}`} s={r.ion} part={part} r={r} />
            ) : (
              <OwnRow
                key={`${r.name}:${i}`}
                icon={PlugZap}
                r={r}
                agents={p.agents}
                off={offIn(r, info.own, "servers", p.agents)}
                line={ownLine(launch.get(`${r.agents[0]}:${r.name}`) ?? "")}
              />
            ),
          )}
          {repos.map((s) => (
            <RepoRow key={s.repo?.id} s={s} part={part} />
          ))}
          {leftOut.map((l) => (
            <ToolRow key={l.name} icon={PlugZap} name={l.name} line={l.why} />
          ))}
        </div>
      )}
    </>
  );
}
