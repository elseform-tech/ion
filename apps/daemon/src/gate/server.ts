import type { IncomingMessage, ServerResponse } from "node:http";
import type { Grants, Scope } from "../mcp/index.js";

const MAX_BODY = 1024 * 1024;

export type GateAnswer = { decision: "allow" | "deny"; reason?: string };

const send = (res: ServerResponse, status: number, body: GateAnswer | string) => {
  const json = typeof body !== "string";
  res
    .writeHead(status, { "content-type": json ? "application/json" : "text/plain" })
    .end(json ? JSON.stringify(body) : body);
};

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

/**
 * ion's gate: `POST /gate/<key>` with the harness's hook payload, answered `{decision, reason?}`. The key is in
 * the path because hooks can't always set headers; it only answers for its own run. No browser (any Origin).
 * A call ion can't read is a 400 with a deny, so a hook that fails closed blocks it.
 */
export function createGateHandler(d: {
  grants: Grants;
  decide: (scope: Scope, payload: unknown) => Promise<GateAnswer | null>;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.origin !== undefined) return send(res, 403, "Forbidden");
    const key = /^\/gate\/([0-9a-f]{64})$/.exec((req.url ?? "").split("?")[0]!)?.[1];
    const scope = key ? d.grants.check(key, "gate") : null;
    if (!scope) return send(res, 401, "Unknown key");
    if (req.method !== "POST") return send(res, 405, "Use POST");
    const answer = await d.decide(scope, await readJson(req));
    if (!answer) return send(res, 400, { decision: "deny", reason: "ion couldn't read this tool call" });
    send(res, 200, answer);
  };
}
