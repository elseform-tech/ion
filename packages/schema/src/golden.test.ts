import { describe, expect, it } from "vitest";
import { ADAPTER_EVENT_TYPES, COMMANDS, DAEMON_EVENT_TYPES, SCHEMA_VERSION } from "./index.js";

// Golden: the contract every adapter, the daemon and the UI depend on. A diff here is a contract change:
// review it, and bump SCHEMA_VERSION if old events can no longer be read. Update with `vitest -u`.
describe("contract golden", () => {
  it("event types and commands", async () => {
    const contract = {
      version: SCHEMA_VERSION,
      adapter: ADAPTER_EVENT_TYPES,
      daemon: DAEMON_EVENT_TYPES,
      commands: COMMANDS,
    };
    await expect(`${JSON.stringify(contract, null, 2)}\n`).toMatchFileSnapshot("../golden/contract.json");
  });
});
