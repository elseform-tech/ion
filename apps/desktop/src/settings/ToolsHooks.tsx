import { Ellipsis, Plus, ShieldCheck, Trash2, Webhook } from "@ion/design-system";
import type { HookGroup, HookInfo, HookLast } from "@ion/schema";
import { useRef, useState } from "react";
import { useCallError } from "../callError.js";
import { useDismiss } from "../chats/dismiss.js";
import { relTime } from "../chats/live.js";
import { Switch } from "./Switch.js";
import { type Part, partOf, short, stateOf, type TabProps, ToolRow } from "./tools-parts.js";

/** A hook's last run, in a few words: "Ran 2m ago", "Failed: exit 1", "Took too long". */
function lastOf(last: HookLast, now = new Date()): string {
  if (!last.ok) return last.code === null ? "Took too long" : `Failed: exit ${last.code}`;
  const when = relTime(last.at, now);
  if (when === "now") return "Ran just now";
  return /^\d/.test(when) && /[mh]$/.test(when) ? `Ran ${when} ago` : `Ran ${when}`;
}

/** A hook's menu: Remove. */
function HookMenu({ name, onRemove }: { name: string; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(open, wrap, () => setOpen(false));
  return (
    <div className="tmore" ref={wrap}>
      <button
        className="ib"
        type="button"
        title="More"
        aria-label={`More for ${name}`}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis />
      </button>
      {open && (
        <div className="pmenu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            <Trash2 />
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

function HookRow({ h, part }: { h: HookInfo; part: Part }) {
  const [error, run] = useCallError();
  const { client, set } = part;
  return (
    <>
      <ToolRow
        icon={Webhook}
        name={h.name}
        chip={stateOf(h, part.locked)}
        line={<code title={h.run}>{short(h.run)}</code>}
        {...(h.origin ? { origin: h.origin } : {})}
        at={part.at === h.name}
        end={
          <>
            {h.last && <span className="s">{lastOf(h.last)}</span>}
            <Switch
              label={h.name}
              on={h.on}
              onPick={(on) => run(client.call("tools.setOn", { kind: "hook", id: h.id, on }), set)}
            />
            <HookMenu
              name={h.name}
              onRemove={() => run(client.call("tools.removeHook", { id: h.id }), set)}
            />
          </>
        }
      />
      {error && <div className="perr">{error}</div>}
    </>
  );
}

/** A new hook on this event: its name and command, added on Enter. */
function AddHook({ g, part, onDone }: { g: HookGroup; part: Part; onDone: () => void }) {
  const [error, run] = useCallError();
  const [name, setName] = useState("");
  const [cmd, setCmd] = useState("");
  const add = () =>
    run(part.client.call("tools.addHook", { name: name.trim(), event: g.event, run: cmd.trim() }), (t) => {
      part.set(t);
      onDone();
    });
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") add();
    if (e.key === "Escape") onDone();
  };
  return (
    <>
      <div className="srow">
        <input
          className="fin"
          aria-label="Name"
          placeholder="Name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={keys}
        />
        <input
          className="fin mono"
          aria-label="Command"
          placeholder="Command"
          spellCheck={false}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={keys}
        />
      </div>
      {error && <div className="perr">{error}</div>}
    </>
  );
}

/** One event: its plain name and Add, ion's own hook on it (Auto-approval: built in, nothing to change), yours. */
function Event({ g, part }: { g: HookGroup; part: Part }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="srow ev">
        <div className="g">{g.name}</div>
        <button
          className="ib"
          type="button"
          title="Add"
          aria-label={`Add to ${g.name}`}
          onClick={() => setAdding(!adding)}
        >
          <Plus />
        </button>
      </div>
      {g.builtIn && <ToolRow icon={ShieldCheck} name={g.builtIn.name} chip="Built in" />}
      {g.hooks.map((h) => (
        <HookRow key={h.id} h={h} part={part} />
      ))}
      {adding && <AddHook g={g} part={part} onDone={() => setAdding(false)} />}
    </>
  );
}

/** Settings → Tools → Hooks: every ion event, with or without hooks. `at`: the hook a chat's link opened. */
export function Hooks(p: TabProps) {
  const part = partOf(p);
  return (
    <div className="group">
      {p.info.hooks.map((g) => (
        <Event key={g.event} g={g} part={part} />
      ))}
    </div>
  );
}
