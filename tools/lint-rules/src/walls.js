import { builtinModules } from "node:module";
import { posix } from "node:path";
import { isTest, onImports, repoPath } from "./paths.js";

/** Which @ion packages each package may import (docs/architecture/contract.md). */
const ALLOW = {
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
/** The daemon loads adapters in exactly one file, so the set of harnesses is visible in one place. */
const REGISTRY = "apps/daemon/src/adapters/registry.ts";
const TEST_EXTRA = { "apps/daemon": ["client"], "apps/cli": ["daemon"] };

/** "@ion/adapter-codex" → "adapters", "@ion/client" → "client", anything else → null. */
function ionPackage(source) {
  const m = source.match(/^@ion\/([^/]+)/);
  if (!m) return null;
  return m[1].startsWith("adapter-") && m[1] !== "adapter-kit" ? "adapters" : m[1];
}

/** True when a relative import from file `p` lands outside its package root. */
function escapes(p, source, root) {
  const target = posix.normalize(posix.join(posix.dirname(p), source));
  return !`${target}/`.startsWith(`${root}/`);
}

const isNodeBuiltin = (source) => source.startsWith("node:") || builtinModules.includes(source);

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
      registryOnly: "Import adapters only in src/adapters/registry.ts.",
    },
    schema: [],
  },
  create(ctx) {
    const p = repoPath(ctx.filename);
    const from = owner(p);
    if (!from) return {};
    const allowed = new Set([...(ALLOW[from] ?? []), ...(isTest(p) ? (TEST_EXTRA[from] ?? []) : [])]);
    const root = packageRoot(p);
    return onImports((node, source) => {
      const to = ionPackage(source);
      if (to && !allowed.has(to)) ctx.report({ node, messageId: "wall", data: { from, to } });
      else if (to === "adapters" && from === "apps/daemon" && p !== REGISTRY)
        ctx.report({ node, messageId: "registryOnly" });
      else if (source.startsWith(".") && root && escapes(p, source, root))
        ctx.report({ node, messageId: "escape" });
      else if (from === "apps/desktop" && isNodeBuiltin(source)) ctx.report({ node, messageId: "nodeInUi" });
    });
  },
};
