import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Grants, Scope } from "./grants.js";
import { type IonDeps, registerIonTools } from "./ion-tools.js";
import { registerTools } from "./tools.js";

const MAX_BODY = 1024 * 1024;

const reply = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, { "content-type": "text/plain" }).end(message);
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy(new Error("Too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Who's calling: a live run or ion key in the Authorization header, and no browser (any Origin header) at all. */
function authorize(req: IncomingMessage, grants: Grants): { status: number; scope?: Scope } {
  if (req.headers.origin !== undefined) return { status: 403 };
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
  const scope = m ? grants.check(m[1]!) : null;
  return scope ? { status: 200, scope } : { status: 401 };
}

/**
 * ion's MCP server over HTTP (stateless: one small server per request). Only `/mcp`, only from a run or an ion's
 * turn that holds a live key, and only what that key may see: a run its project, an ion its projects.
 */
export function createMcpHandler(d: IonDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const auth = authorize(req, d.grants);
    if (!auth.scope) return reply(res, auth.status, auth.status === 403 ? "Forbidden" : "Unknown key");
    let body: unknown;
    try {
      body = req.method === "POST" ? await readBody(req) : undefined;
    } catch {
      return reply(res, 400, "Bad request");
    }
    const server = new McpServer({ name: "ion", version: "0.0.0" });
    if (auth.scope.kind === "run") registerTools(server, auth.scope, d);
    else registerIonTools(server, auth.scope, d);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
