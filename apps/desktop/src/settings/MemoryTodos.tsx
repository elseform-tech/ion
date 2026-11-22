import type { IonClient } from "@ion/client/browser";
import { Check, ChevronDown, ChevronRight } from "@ion/design-system";
import type { MemoryInfo, ProjectInfo } from "@ion/schema";
import { useState } from "react";
import type { Run } from "../callError.js";
import { dueOf, scopeOf } from "./memory-data.js";
import { ForgetAsk, ForgetButton, IconButton, Nothing, TypeIcon } from "./memory-parts.js";

/** Open to-dos by date (the soonest first, those without one last), then by name. */
const byDue = (a: MemoryInfo, b: MemoryInfo) =>
  (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.name.localeCompare(b.name);

type RowProps = { m: MemoryInfo; projects: ProjectInfo[]; client: IonClient; run: Run };

/** A to-do: its name, its date in words and whose; Done (open ones) and Forget (asked first, in its own line). */
function TodoRow({ m, projects, client, run }: RowProps) {
  const [asking, setAsking] = useState(false);
  const whose = scopeOf(m);
  const project = projects.find((p) => p.id === whose);
  const due = m.due && m.status !== "done" ? dueOf(m.due) : null;
  return (
    <>
      <div className={`trow${m.status === "done" ? " done" : ""}`}>
        <TypeIcon m={m} />
        <div>
          <span className="tname">{m.name}</span>
          <div className="s">
            <span className="mby">
              {due && (
                <>
                  <span className={due.late ? "late" : ""}>{due.text}</span>
                  {" · "}
                </>
              )}
              {whose === "you" ? "You" : (project?.name ?? whose)}
            </span>
          </div>
        </div>
        <span className="hsup" />
        <div className="acts2">
          {m.status !== "done" && (
            <IconButton
              name="Done"
              icon={Check}
              onClick={() => run(client.call("todo.done", { name: m.memoryId }))}
            />
          )}
          <ForgetButton onClick={() => setAsking(true)} />
        </div>
      </div>
      {asking && (
        <ForgetAsk
          name={m.name}
          onCancel={() => setAsking(false)}
          onForget={() => run(client.call("memory.forget", { memoryId: m.memoryId }))}
        />
      )}
    </>
  );
}

/** Settings → Memory → To-dos: yours and every project's, open ones first by date; done ones folded under them. */
export function MemoryTodos(p: {
  files: MemoryInfo[];
  projects: ProjectInfo[];
  client: IonClient;
  run: Run;
}) {
  const [showDone, setShowDone] = useState(false);
  const todos = p.files.filter((m) => m.type === "todo");
  const open = todos.filter((m) => m.status !== "done").sort(byDue);
  const done = todos.filter((m) => m.status === "done");
  const row = (m: MemoryInfo) => (
    <TodoRow key={m.memoryId} m={m} projects={p.projects} client={p.client} run={p.run} />
  );
  if (!todos.length) return <Nothing text="No to-dos" />;
  return (
    <div className="group">
      {open.map(row)}
      {done.length > 0 && (
        <div className="srow">
          <button
            className="mfold"
            type="button"
            aria-expanded={showDone}
            onClick={() => setShowDone(!showDone)}
          >
            {showDone ? <ChevronDown /> : <ChevronRight />}
            {` Done · ${done.length}`}
          </button>
        </div>
      )}
      {showDone && done.map(row)}
    </div>
  );
}
