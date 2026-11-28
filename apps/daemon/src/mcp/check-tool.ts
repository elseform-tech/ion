import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IonScope } from "./grants.js";
import { ok } from "./result.js";

/** The ion id of the nightly check's keys (Plan 21 Task 5): its server has this one tool, nothing of yours. */
export const CHECK_ION = "_check";

/** ion's check tool: it gives back the check's word, so an answer holding it shows ion's tools reached the agent. */
export function registerCheckTool(server: McpServer, scope: IonScope): void {
  server.registerTool(
    "check",
    { description: "ion's check that its tools reach you: returns a word to say back.", inputSchema: {} },
    () => ok(scope.check?.word ?? ""),
  );
}
