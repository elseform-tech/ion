import type { Command } from "commander";
import { ionPaths } from "@ion/config";
import { reach, startDaemon, stopDaemon } from "../daemon-control.js";
import { fail, NOT_RUNNING, type Out, print } from "../output.js";

export function daemonCommands(program: Command, out: () => Out) {
  const d = program.command("daemon").description("Start, stop or check the ion service");
  d.command("start").action(async () => {
    const r = await startDaemon(ionPaths().dataDir);
    if (r === "failed") fail("ion didn't start. See daemon.log in the data folder.");
    print(out(), r === "already" ? "Already running" : "Started", { status: r });
  });
  d.command("stop").action(async () => {
    const r = await stopDaemon(ionPaths().dataDir);
    print(out(), r === "stopped" ? "Stopped" : "Not running", { status: r });
  });
  d.command("status").action(async () => {
    const up = await reach(ionPaths().dataDir);
    if (!up) fail(NOT_RUNNING, 2);
    up.client.close();
    print(out(), `Running · pid ${up.info.pid} · port ${up.info.port}`, {
      pid: up.info.pid,
      port: up.info.port,
    });
  });
}
