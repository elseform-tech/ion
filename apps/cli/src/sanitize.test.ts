import { describe, expect, it } from "vitest";
import { clean } from "./sanitize.js";

describe("clean", () => {
  // Regression (security review): need summaries and chat titles come from agents.
  it("strips escapes, control characters, direction marks and line breaks", () => {
    expect(clean("Run \u001b[2Jtests‮\nnow\r")).toBe("Run [2Jtests now");
  });
});
