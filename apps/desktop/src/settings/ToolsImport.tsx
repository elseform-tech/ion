import { Import, PlugZap, X } from "@ion/design-system";
import type { ImportableServer } from "@ion/schema";
import type { Run } from "../callError.js";
import type { ImportData } from "./tools-data.js";
import { short, ToolRow } from "./tools-parts.js";
import { projectsFile } from "../projectName.js";

/** What both get: Import's state and calls, and how a call's failure is shown (one line under the tabs). */
type Props = { data: ImportData; run: Run };

/**
 * Import beside Open config file ("Use on every agent": an agent's own server copied into mcp.json reaches every
 * agent): shows every server your agents have that mcp.json doesn't, before any comes in.
 */
export function ImportAll({ data }: { data: ImportData }) {
  const some = (data.imports?.servers.length ?? 0) > 0;
  const name = some ? "Use on every agent" : "Nothing to import";
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
 * Above Connections: what Import would bring in (once asked), and a config ion couldn't read. Quiet otherwise (the
 * user, 2026-11-21: agents bring their own, so Import is optional): nothing here runs or contacts a server.
 */
export function ImportLines({ data, run }: Props) {
  const i = data.imports;
  if (!i) return null;
  return (
    <>
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
  s.repo ? `From ${projectsFile(s.repo.project, s.repo.file)}` : `From ${s.from}`;

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
