/** Repo-relative path with forward slashes, starting at apps/, packages/ or tools/. */
export function repoPath(filename) {
  const f = filename.replaceAll("\\", "/");
  const m = f.match(/(?:^|\/)((?:apps|packages|tools)\/.*)$/);
  return m ? m[1] : f;
}
export const isTest = (p) => /\.test\.[cm]?[jt]s$/.test(p) || /(^|\/)test\//.test(p);
export const startsWithAny = (p, prefixes) => prefixes.some((x) => p === x || p.startsWith(x));

/** Imports from `import`, `export ... from`, and dynamic `import()`; calls fn(node, source). */
export function onImports(fn) {
  const check = (node) => node.source && typeof node.source.value === "string" && fn(node, node.source.value);
  return {
    ImportDeclaration: check,
    ExportNamedDeclaration: check,
    ExportAllDeclaration: check,
    ImportExpression: check,
  };
}
