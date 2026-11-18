import { describe, expect, it } from "vitest";
import { table } from "./output.js";

// UX tour: `ion chats` printed its columns ragged.
describe("table", () => {
  it("lines up each column, the last left unpadded", () => {
    expect(
      table([
        ["chat_1", "edit", "storefront"],
        ["chat_22", "a longer title", "default"],
      ]),
    ).toBe("chat_1   edit            storefront\nchat_22  a longer title  default");
  });
});
