import { createHash, randomBytes } from "node:crypto";

/** What a run's key may see: its own project (and chat, as the default for history). */
export type RunScope = { kind: "run"; projectId: string; chatId: string; runId: string };

/** What an ion's key may see for one turn: the projects it looks after (ion chief: those shared with it). */
/** An ion's turn; `report`: a turn the daemon asked for (a thread's report), which writes nothing and starts nothing. */
export type IonScope = { kind: "ion"; ionId: string; projects: string[]; turnId: string; report?: true };

export type Scope = RunScope | IonScope;

/** What a key opens: ion's MCP server, or the gate (where a harness's hook reports tool calls). */
type KeyKind = "mcp" | "gate";

/** What a run or a turn may only do a few times: write memory, start threads. */
type Counted = "write" | "thread";

export type Grants = {
  /** A fresh key for one run or one ion's turn; it works until its grants are revoked. */
  create(scope: Scope, kind?: KeyKind): string;
  /** Revokes the keys of a run (its runId) or of an ion's turn (its turnId). */
  revoke(id: string): void;
  /** The key's scope, only when it's a live key of this kind. */
  check(key: string, kind?: KeyKind): Scope | null;
  /** Counts one memory write for the run or turn; the count goes away when its grants are revoked. */
  noteWrite(id: string): number;
  /** Counts one thread started in the turn (-1 gives a slot back); the count goes away with its grants. */
  noteThread(id: string, by?: 1 | -1): number;
};

const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const idOf = (s: Scope) => (s.kind === "run" ? s.runId : s.turnId);

/** Keys are kept only as hashes, so looking one up takes the same time whatever its first characters. */
export function createGrants(): Grants {
  const byHash = new Map<string, { scope: Scope; kind: KeyKind }>();
  const counts = new Map<string, number>();
  const note = (id: string, what: Counted, by = 1) => {
    const n = (counts.get(`${what}:${id}`) ?? 0) + by;
    counts.set(`${what}:${id}`, n);
    return n;
  };
  return {
    create(scope, kind = "mcp") {
      const key = randomBytes(32).toString("hex");
      byHash.set(hash(key), { scope: structuredClone(scope), kind });
      return key;
    },
    revoke(id) {
      for (const [h, s] of byHash) if (idOf(s.scope) === id) byHash.delete(h);
      counts.delete(`write:${id}`);
      counts.delete(`thread:${id}`);
    },
    noteWrite: (id) => note(id, "write"),
    noteThread: (id, by = 1) => note(id, "thread", by),
    check(key, kind = "mcp") {
      const s = byHash.get(hash(key));
      return s && s.kind === kind ? structuredClone(s.scope) : null;
    },
  };
}
