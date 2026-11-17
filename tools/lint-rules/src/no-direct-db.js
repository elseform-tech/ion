import { onImports, repoPath } from "./paths.js";

const DB = /^(better-sqlite3|drizzle-orm)(\/|$)/;

/** Only apps/daemon/src/store touches SQLite. */
export default {
  meta: {
    type: "problem",
    messages: { storeOnly: "Only apps/daemon/src/store may use {{source}}. Append events instead." },
    schema: [],
  },
  create(ctx) {
    if (repoPath(ctx.filename).startsWith("apps/daemon/src/store/")) return {};
    return onImports((node, source) => {
      if (DB.test(source)) ctx.report({ node, messageId: "storeOnly", data: { source } });
    });
  },
};
