import type { Command } from "commander";
import type { HarnessInfo } from "@ion/schema";
import { withClient } from "../connect.js";
import { type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

const status = (h: HarnessInfo) => {
  if (!h.installed) return "Not installed";
  return h.signedIn ? "Signed in" : "Not signed in";
};

/** `<id>  <status>  <model (default), model, …>` */
const row = (h: HarnessInfo) => {
  const models = h.models.map((m) => (m.id === h.defaultModel ? `${m.id} (default)` : m.id)).join(", ");
  return [h.id, status(h), models].filter(Boolean).map(clean).join("  ");
};

export function harnessesCommand(program: Command, out: () => Out) {
  program
    .command("harnesses")
    .description("Coding agents and their models")
    .action(async () => {
      const list = await withClient((c) => c.call("harnesses.list", {}));
      print(out(), list.map(row).join("\n"), list);
    });
}
