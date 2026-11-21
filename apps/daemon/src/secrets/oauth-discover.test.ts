import { describe, expect, it } from "vitest";
import { challengeOf } from "./oauth-discover.js";

// Plan 18, Task 2 (the user, 2026-11-20: "we have to consider mcp that might require oauth"): a 401's
// WWW-Authenticate is read the way RFC 6750 writes it, quoted or not.
describe("challengeOf", () => {
  it("reads resource_metadata and scope, quoted or bare", () => {
    expect(
      challengeOf(
        'Bearer realm="a, b", resource_metadata="https://h.example/.well-known/x", scope="read write"',
      ),
    ).toEqual({ metadata: "https://h.example/.well-known/x", scope: "read write" });
    expect(challengeOf("bearer scope=read,resource_metadata=https://h.example/m")).toEqual({
      metadata: "https://h.example/m",
      scope: "read",
    });
    expect(challengeOf("Bearer")).toEqual({});
  });

  it("isn't a Bearer challenge: none", () => {
    expect(challengeOf('Basic realm="x"')).toBeNull();
    expect(challengeOf(null)).toBeNull();
  });
});
