import { ApiCallError, type IonClient } from "@ion/client";
import { ionPaths } from "@ion/config";
import { reach } from "./daemon-control.js";
import { fail, NOT_RUNNING } from "./output.js";

/**
 * A client to the running daemon; exits 2 with the start hint when it isn't running. Inside a chat (`ION_RUN_KEY`
 * set) it connects with the chat's run key: ion's commands for tools only.
 */
export async function connect(): Promise<IonClient> {
  const runKey = process.env.ION_RUN_KEY || undefined;
  // Inside a chat (its marker is set) without its key: never ion's own token (Task review, 2026-11-21).
  if (!runKey && process.env.ION_CHAT) fail("Run this from ion's own app");
  const up = await reach(ionPaths().dataDir, runKey);
  if (!up) fail(NOT_RUNNING, 2);
  return up.client;
}

/** Runs one call against the daemon: a refused call exits 1 with ion's own message. */
export async function withClient<T>(f: (c: IonClient) => Promise<T>): Promise<T> {
  const c = await connect();
  try {
    return await f(c);
  } catch (e) {
    return fail(e instanceof ApiCallError ? e.message : "Something went wrong");
  } finally {
    c.close();
  }
}
