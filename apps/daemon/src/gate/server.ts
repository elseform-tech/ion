import type { IncomingMessage, ServerResponse } from "node:http";
import type { Grants, IonScope, RunScope } from "../mcp/index.js";

const MAX_BODY = 1024 * 1024;

export type GateAnswer = { decision: "allow" | "deny"; reason?: string };

const send = (res: ServerResponse, status: number, body: GateAnswer | string) => {
  const json = typeof body !== "string";
  res
    .writeHead(status, { "content-type": json ? "application/json" : "text/plain" })
    .end(json ? JSON.stringify(body) : body);
};

export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Settles exactly once, however the request ends: done, failed, torn down for being too large.
    let settled = false;
    const settle = (v: unknown) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        settle(undefined);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        settle(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        settle(undefined);
      }
    });
    req.on("error", () => settle(undefined));
    req.on("close", () => settle(undefined));
  });
}

/**
 * ion's gate: `POST /gate/<key>` with the harness's hook payload, answered `{decision, reason?}`. The key is in
 * the path because hooks can't always set headers; it only answers for its own run, or its own ion's turn (`ion`;
 * without it an ion's key is unknown here). No browser (any Origin). A call ion can't read is a 400 with a deny,
 * so a hook that fails closed blocks it.
 */
export function createGateHandler(d: {
  grants: Grants;
  decide: (scope: RunScope, payload: unknown) => Promise<GateAnswer | null>;
  ion?: (scope: IonScope, payload: unknown) => Promise<GateAnswer | null>;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.origin !== undefined) return send(res, 403, "Forbidden");
    const key = /^\/gate\/([0-9a-f]{64})$/.exec((req.url ?? "").split("?")[0]!)?.[1];
    const scope = key ? d.grants.check(key, "gate") : null;
    if (!scope || (scope.kind === "ion" && !d.ion)) return send(res, 401, "Unknown key");
    if (req.method !== "POST") return send(res, 405, "Use POST");
    const payload = await readJson(req);
    const answer = scope.kind === "run" ? await d.decide(scope, payload) : await d.ion!(scope, payload);
    if (!answer) return send(res, 400, { decision: "deny", reason: "ion couldn't read this tool call" });
    send(res, 200, answer);
  };
}
