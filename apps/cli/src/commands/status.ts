import type { Command } from "commander";
import { connect } from "../connect.js";
import { type Out, print } from "../output.js";

export function statusCommand(program: Command, out: () => Out) {
  program
    .command("status")
    .description("Is ion running, and how many projects")
    .action(async () => {
      // Inside a hook or a chat's run, with its key and ION_PORT (daemon.json is out of reach there).
      const c = await connect();
      const s = await c.call("status", {});
      c.close();
      const n = `${s.projects} project${s.projects === 1 ? "" : "s"}`;
      const lines = [`ion is running · ${n}`];
      if (s.configError) lines.push(s.configError);
      for (const n of s.notes ?? []) lines.push(n);
      print(out(), lines.join("\n"), s);
    });
}
