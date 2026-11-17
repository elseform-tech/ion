import { isTest, onImports, repoPath } from "./paths.js";

/** Which @ion packages each package may import (docs/architecture/contract.md). */
export const ALLOW = {
  "packages/schema": [],
  "packages/config": [],
  "packages/client": ["schema"],
  "packages/policy": ["schema"],
  "packages/adapter-kit": ["schema"],
  "packages/adapters": ["schema", "adapter-kit"],
  "packages/design-system": [],
  "apps/daemon": ["schema", "config", "policy", "adapter-kit", "adapters"],
  "apps/cli": ["schema", "config", "client"],
  "apps/desktop": ["schema", "client", "design-system"],
  "tools/lint-rules": ["schema"],
};
/** Extra packages a test file may use (e.g. the daemon's api tests drive it through the client). */
const TEST_EXTRA = { "apps/daemon": ["client"], "apps/cli": ["daemon"] };

function owner(p) {
  const m = p.match(/^(apps\/[^/]+|packages\/adapters|packages\/[^/]+|tools\/[^/]+)\//);
  return m ? m[1] : null;
}
function packageRoot(p) {
  const m = p.match(/^(apps\/[^/]+|packages\/adapters\/[^/]+|packages\/[^/]+|tools\/[^/]+)\//);
  return m ? m[1] : null;
}

export default {
  meta: {
    type: "problem",
    messages: {
      wall: "{{from}} may not import @ion/{{to}}. See the walls in AGENTS.md.",
      escape: "Don't reach into another package with a relative path. Import it by name.",
      nodeInUi: "The desktop UI only displays state: no Node APIs. Use @ion/client.",
    },
    schema: [],
  },
  create(ctx) {
    const p = repoPath(ctx.filename);
    const from = owner(p);
    if (!from) return {};
    const allowed = new Set([...(ALLOW[from] ?? []), ...(isTest(p) ? (TEST_EXTRA[from] ?? []) : [])]);
    const root = packageRoot(p);
    const depth = p.split("/").length - 1;
    return onImports((node, source) => {
      const m = source.match(/^@ion\/([^/]+)/);
      if (m) {
        const to = m[1].startsWith("adapter-") && m[1] !== "adapter-kit" ? "adapters" : m[1];
        if (!allowed.has(to)) ctx.report({ node, messageId: "wall", data: { from, to } });
        return;
      }
      if (source.startsWith(".")) {
        const parts = [...p.split("/").slice(0, depth)];
        for (const seg of source.split("/")) {
          if (seg === "..") parts.pop();
          else if (seg !== ".") parts.push(seg);
        }
        if (root && !`${parts.join("/")}/`.startsWith(`${root}/`)) ctx.report({ node, messageId: "escape" });
        return;
      }
      if (from === "apps/desktop" && /^node:|^(fs|path|os|child_process|net|http)$/.test(source))
        ctx.report({ node, messageId: "nodeInUi" });
    });
  },
};
