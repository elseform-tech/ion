import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Secrets } from "./index.js";

/** Where the consent key is kept (in the vault, whose own key is in the keychain): 32 random bytes, hex. */
const ACCOUNT = "consent-key";

/** A consent record's mark: keyed with this install's secret, so a record written by hand never verifies. */
export type Sign = (text: string) => Promise<string>;

/**
 * Signs what you consent to (a server or hook turned on in the app) with a key only this install has, kept in the
 * vault: anything that can write config.toml can't write a record that turns something on. Made once, when first
 * needed; a vault that can't be read signs nothing (so nothing counts as turned on).
 */
export function createSigner(vault: Secrets): Sign {
  let key: Promise<Buffer> | null = null;
  const keyOf = () => {
    key ??= (async () => {
      const kept = await vault.get(ACCOUNT);
      if (kept && /^[0-9a-f]{64}$/.test(kept)) return Buffer.from(kept, "hex");
      const made = randomBytes(32);
      await vault.set(ACCOUNT, made.toString("hex"));
      return made;
    })();
    // A vault that couldn't answer is asked again next time.
    key.catch(() => (key = null));
    return key;
  };
  return async (text) =>
    createHmac("sha256", await keyOf())
      .update(text)
      .digest("hex")
      .slice(0, 32);
}

/** Whether a record's mark is this one, compared in constant time. */
export function sameMark(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
