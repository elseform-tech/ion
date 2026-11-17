/**
 * Resolved copies of `pkg` in pnpm-lock.yaml's `snapshots:` section that don't carry a patch hash.
 * Returns them as they appear, e.g. ["picomatch@2.3.1", "picomatch: 4.0.6"]; empty means all patched.
 * @param {string} lockText
 * @param {string} pkg
 */
export function unpatched(lockText, pkg) {
  const start = lockText.indexOf("\nsnapshots:");
  if (start === -1) return [];
  const name = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const ref = new RegExp(`(?<![\\w@/-])${name}(@|: )(\\d[^\\s:()]*)(\\(patch_hash=[0-9a-f]+\\))?`, "g");
  const found = [];
  for (const m of lockText.slice(start).matchAll(ref)) {
    if (!m[3]) found.push(`${pkg}${m[1]}${m[2]}`);
  }
  return found;
}
