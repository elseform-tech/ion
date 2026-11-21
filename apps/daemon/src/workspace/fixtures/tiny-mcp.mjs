// A tiny local MCP server for ion's tests (no network): echo, whoami (its pid, parent, folder, environment and args),
// crash (exits), roots (asks its client for roots, a request a server starts), fail (an error with your text),
// sleep (waits; writes `marker` if it's cancelled), big (a text of `size` bytes), flood (100 MB, no newline).
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "tiny", version: "1.0.0" },
  {
    capabilities: {
      tools: { listChanged: true },
      logging: {},
      resources: { subscribe: true, listChanged: true },
    },
  },
);
const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t) }] });
const tools = ["echo", "whoami", "crash", "roots", "fail", "sleep", "big", "flood"].map((name) => ({
  name,
  inputSchema: { type: "object" },
}));

const sleep = (args, signal) =>
  new Promise((resolve) => {
    const start = Date.now();
    const t = setTimeout(() => resolve(text({ start, end: Date.now() })), args.ms ?? 1000);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      if (args.marker) writeFileSync(args.marker, "cancelled");
      resolve(text("cancelled"));
    });
  });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args = {} } = req.params;
  if (name === "echo") return text(String(args.text));
  if (name === "whoami")
    return text({
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      env: process.env,
      argv: process.argv,
    });
  if (name === "crash") process.exit(1);
  if (name === "fail") throw new Error(String(args.text));
  if (name === "sleep") return sleep(args, extra.signal);
  if (name === "big") return text("x".repeat(args.size));
  if (name === "flood") {
    const c = "x".repeat(1 << 20);
    for (let i = 0; i < 100; i++) process.stdout.write(c);
    return new Promise(() => {});
  }
  if (name === "roots") {
    try {
      return text(await server.listRoots());
    } catch (e) {
      return text({ code: e.code, message: e.message });
    }
  }
  throw new Error(`No tool ${name}`);
});

await server.connect(new StdioServerTransport());
