import { randomUUID } from "node:crypto";
import { delimiter } from "node:path";
import type { RunSandbox } from "@ion/adapter-kit";
import type { Grants } from "../mcp/index.js";
import { type HookResult, type HookRun, runHook } from "../workspace/hooks.js";

/** How a hook reaches ion from inside its sandbox: ion's port, its keys, and ion's launcher's folder. */
export type HookIon = { port: () => number; grants: Grants; bin?: string };

/** What a hook run gets of ion's: its sandbox, and ion to reach (Automated review, 2026-11-21: hooks run sandboxed). */
export type HookBox = { sandbox?: RunSandbox; ion?: HookIon };

/**
 * Runs a hook in the sandbox (ion's folders denied, agents' configs read-only, the project writable; no global or
 * system git config) with `ion` reachable: ION_PORT and a key made for this one hook run, with a run key's limited
 * rights (ion's commands for tools: nothing turned on, no keys, no settings), revoked when it ends.
 */
export async function runBoxed(
  box: HookBox,
  run: HookRun,
  where: { projectId?: string | null; chatId?: string | null },
): Promise<HookResult> {
  const id = `hook-${randomUUID()}`;
  const scope = {
    kind: "run" as const,
    projectId: where.projectId ?? "",
    chatId: where.chatId ?? "",
    runId: id,
  };
  const key = box.ion?.grants.create(scope, "cli");
  const env: Record<string, string> = {
    ...run.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...(box.ion && key ? { ION_PORT: String(box.ion.port()), ION_RUN_KEY: key } : {}),
    ...(box.ion?.bin ? { PATH: [box.ion.bin, run.env.PATH ?? ""].filter(Boolean).join(delimiter) } : {}),
  };
  try {
    return await runHook({ ...run, env, ...(box.sandbox ? { sandbox: box.sandbox } : {}) });
  } finally {
    box.ion?.grants.revoke(id);
  }
}
