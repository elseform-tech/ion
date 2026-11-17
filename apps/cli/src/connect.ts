import { ApiCallError, type IonClient } from "@ion/client";
import { ionPaths } from "@ion/config";
import { reach } from "./daemon-control.js";
import { fail, NOT_RUNNING } from "./output.js";

/** A client to the running daemon; exits 2 with the start hint when it isn't running. */
export async function connect(): Promise<IonClient> {
  const up = await reach(ionPaths().dataDir);
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
