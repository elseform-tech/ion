import { Import, PlugZap, X } from "@ion/design-system";
import type { ImportableServer, ImportPrompt } from "@ion/schema";
import type { Run } from "../callError.js";
import type { ImportData } from "./tools-data.js";
import { short, ToolRow } from "./tools-parts.js";

/** What both get: Import's state and calls, and how a call's failure is shown (one line under the tabs). */
type Props = { data: ImportData; run: Run };

/** "Claude Code, Codex and Grok Build". */
const listed = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * One agent: "3 servers in Claude Code" the first time, later "New in Claude Code: github". More than one (tour,
 * 2026-11-21: a boxed line each): one line, "10 servers in Claude Code, Codex and Grok Build".
 */
function promptOf(ps: ImportPrompt[]): { text: string; names: string[]; agent?: string } | null {
  const [p] = ps;
  if (!p) return null;
  const names = ps.flatMap((x) => x.names);
  const count = `${names.length} ${names.length === 1 ? "server" : "servers"}`;
  if (ps.length > 1) return { text: `${count} in ${listed(ps.map((x) => x.from))}`, names };
  const text = p.first ? `${count} in ${p.from}` : `New in ${p.from}: ${p.names.join(", ")}`;
  return { text, names, agent: p.agent };
}

/** Import beside Open config file: shows every server your agents have that mcp.json doesn't, before any comes in. */
export function ImportAll({ data }: { data: ImportData }) {
  const some = (data.imports?.servers.length ?? 0) > 0;
  const name = some ? "Import" : "Nothing to import";
  return (
    <button
      className="ib"
      type="button"
      title={name}
      aria-label={name}
      disabled={!some}
      onClick={() => data.show(data.shown ? null : (data.imports?.servers ?? []).map((x) => x.name))}
    >
      <Import />
    </button>
  );
}

/**
 * Above Connections: one line for the servers in your agents ion hasn't shown you (Import or dismiss), and a config
 * ion couldn't read. Nothing here runs or contacts a server.
 */
export function ImportLines({ data, run }: Props) {
  const i = data.imports;
  if (!i) return null;
  const p = promptOf(i.prompts);
  return (
    <>
      {p && (
        <div className="srow imp">
          <span className="g">{p.text}</span>
          <button className="btn" type="button" onClick={() => data.show(p.names)}>
            Import
          </button>
          <button
            className="ib"
            type="button"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => run(data.dismiss(p.agent))}
          >
            <X />
          </button>
        </div>
      )}
      <Shown data={data} run={run} />
      {i.problems.map((line) => (
        <div key={line} className="perr">
          {line}
        </div>
      ))}
    </>
  );
}

/** Where a server is from: your agent, or a project's own file (the repo wrote it, not you). */
const sourceOf = (s: ImportableServer) =>
  s.repo ? `From ${s.repo.project}'s ${s.repo.file}` : `From ${s.from}`;

/** One server before it comes in: what it runs (or its host) and the keys it'll need; a repo's has its own Import. */
function ShownRow({ s, data, run }: Props & { s: ImportableServer }) {
  return (
    <ToolRow
      icon={PlugZap}
      name={s.name}
      chip={sourceOf(s)}
      line={s.transport === "stdio" ? <code title={s.line}>{short(s.line)}</code> : s.line}
      end={
        <>
          {s.keys.map((k) => (
            <span key={k} className="chip" title="Needs a key">
              {k}
            </span>
          ))}
          {s.repo && (
            <button
              className="btn"
              type="button"
              aria-label={`Import ${s.name}`}
              onClick={() => run(data.bring([s.name], `${s.repo?.project}:${s.repo?.file}`))}
            >
              Import
            </button>
          )}
        </>
      }
    />
  );
}

/**
 * What Import would bring in, shown before anything comes in (security review, 2026-11-21): yours together with
 * Import these, each from a project's own file on its own.
 */
function Shown({ data, run }: Props) {
  const servers = (data.imports?.servers ?? []).filter((s) => data.shown?.includes(s.name));
  if (!data.shown || !servers.length) return null;
  const yours = servers.filter((s) => !s.repo).map((s) => s.name);
  return (
    <div className="group">
      {servers.map((s) => (
        <ShownRow key={`${s.agent}:${s.name}`} s={s} data={data} run={run} />
      ))}
      {(data.imports?.skipped ?? []).map((s) => (
        <ToolRow key={`${s.agent}:${s.name}`} icon={PlugZap} name={s.name} line={s.why} />
      ))}
      <div className="srow">
        <span className="g" />
        {yours.length > 0 && (
          <button className="btn" type="button" onClick={() => run(data.bring(yours))}>
            Import these
          </button>
        )}
        <button className="ib" type="button" title="Close" aria-label="Close" onClick={() => data.show(null)}>
          <X />
        </button>
      </div>
    </div>
  );
}
