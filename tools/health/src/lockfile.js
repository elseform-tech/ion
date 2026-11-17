import { parse } from "yaml";

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/** "picomatch@4.0.7(patch_hash=x)(foo@1)" → { name, ref: "4.0.7(patch_hash=x)(foo@1)" }; handles @scope/names. */
function splitKey(key) {
  const at = key.indexOf("@", 1);
  return at === -1 ? { name: key, ref: "" } : { name: key.slice(0, at), ref: key.slice(at + 1) };
}

/**
 * Resolved copies of `pkg` in pnpm-lock.yaml that don't carry exactly the hash declared under
 * `patchedDependencies`. Parses the YAML structurally and fails closed: throws when there are no
 * snapshots or no copies of `pkg` to check. Empty result means every copy is patched.
 * @param {string} lockText
 * @param {string} pkg
 * @returns {string[]}
 */
export function unpatched(lockText, pkg) {
  const lock = parse(lockText) ?? {};
  const snapshots = lock.snapshots;
  if (!snapshots || typeof snapshots !== "object") throw new Error("Lockfile has no snapshots to check");
  const declared = lock.patchedDependencies ?? {};

  /** True when `ref` is "<version>(patch_hash=<the hash declared for that version>)", optionally followed by peers. */
  const isPatched = (ref) => {
    const m = /^(\d[^()]*)\(patch_hash=([0-9a-f]+)\)/.exec(String(ref));
    if (!m) return false;
    const entry = declared[`${pkg}@${m[1]}`];
    const hash = typeof entry === "string" ? entry : entry?.hash;
    return hash !== undefined && hash === m[2];
  };

  const bad = [];
  let seen = 0;
  for (const [key, snap] of Object.entries(snapshots)) {
    const { name, ref } = splitKey(key);
    if (name === pkg) {
      seen++;
      if (!isPatched(ref)) bad.push(key);
    }
    for (const field of DEP_FIELDS) {
      const deps = snap?.[field] ?? {};
      if (!(pkg in deps)) continue;
      seen++;
      if (!isPatched(deps[pkg])) bad.push(`${key} → ${pkg} ${deps[pkg]}`);
    }
  }
  if (seen === 0) throw new Error(`Lockfile has no ${pkg} to check`);
  return bad;
}
