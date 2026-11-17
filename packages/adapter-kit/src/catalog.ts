import type { Capabilities } from "@ion/schema";

export type Model = { id: string; label: string };
export type Catalog = { models: Model[]; defaultModel: string | null };

const TTL_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;

/**
 * A harness's model list, read from the harness itself and kept for 10 minutes. A load that fails or takes
 * longer than 10 s gives the fallback (`live: false`) and is tried again a minute later.
 */
export function cachedCatalog(
  load: () => Promise<Catalog>,
  o: { fallback: Catalog; timeoutMs?: number; now?: () => number },
): () => Promise<Catalog & { live: boolean }> {
  const now = o.now ?? Date.now;
  let cached: { value: Catalog & { live: boolean }; until: number } | null = null;
  let pending: Promise<Catalog & { live: boolean }> | null = null;
  const fetchOnce = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), o.timeoutMs ?? TIMEOUT_MS);
    });
    try {
      const value = { ...(await Promise.race([load(), timeout])), live: true };
      cached = { value, until: now() + TTL_MS };
    } catch {
      cached = { value: { ...o.fallback, live: false }, until: now() + RETRY_MS };
    } finally {
      clearTimeout(timer);
      pending = null;
    }
    return cached.value;
  };
  return () => {
    if (cached && now() < cached.until) return Promise.resolve(cached.value);
    pending ??= fetchOnce();
    return pending;
  };
}

/** A harness's capabilities: its fixed ones, plus its model list from the catalog. */
export function capabilitiesWith(
  base: Omit<Capabilities, "models" | "defaultModel" | "modelsLive">,
  catalog: () => Promise<Catalog & { live: boolean }>,
): () => Promise<Capabilities> {
  return async () => {
    const { live, ...c } = await catalog();
    return { ...base, ...c, modelsLive: live };
  };
}
