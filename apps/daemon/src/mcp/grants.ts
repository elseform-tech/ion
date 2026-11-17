import { createHash, randomBytes } from "node:crypto";

/** What a run's key may see: its own project (and chat, as the default for history). */
export type Scope = { projectId: string; chatId: string; runId: string };

export type Grants = {
  /** A fresh key for one run; it works until the run's grants are revoked. */
  create(scope: Scope): string;
  revoke(runId: string): void;
  check(key: string): Scope | null;
};

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

/** Keys are kept only as hashes, so looking one up takes the same time whatever its first characters. */
export function createGrants(): Grants {
  const byHash = new Map<string, Scope>();
  return {
    create(scope) {
      const key = randomBytes(32).toString("hex");
      byHash.set(hash(key), scope);
      return key;
    },
    revoke(runId) {
      for (const [h, s] of byHash) if (s.runId === runId) byHash.delete(h);
    },
    check: (key) => byHash.get(hash(key)) ?? null,
  };
}
