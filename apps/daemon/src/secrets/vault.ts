import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Secrets } from "./index.js";

/** The keychain item that holds the vault's key (32 random bytes, hex): small enough for any keychain. */
const KEY_ACCOUNT = "vault-key";
const IV = 12;
const TAG = 16;

/**
 * Values too big for the keychain (OAuth tokens), kept in ion's data folder instead: one file per account,
 * AES-256-GCM with the account as additional data, under a key that lives only in the keychain. Files are 0600 in a
 * 0700 folder and written whole (a temp file, then renamed), so a failed write leaves the last good one.
 */
export function createVault(o: { dir: string; keychain: Secrets }): Secrets {
  let key: Promise<Buffer> | null = null;
  const fileOf = (account: string) =>
    join(o.dir, `${createHash("sha256").update(account).digest("hex").slice(0, 32)}.vault`);

  /** The vault's key, made once and kept in the keychain. */
  const keyOf = (): Promise<Buffer> => {
    key ??= (async () => {
      const kept = await o.keychain.get(KEY_ACCOUNT);
      if (kept && /^[0-9a-f]{64}$/.test(kept)) return Buffer.from(kept, "hex");
      const made = randomBytes(32);
      await o.keychain.set(KEY_ACCOUNT, made.toString("hex"));
      return made;
    })();
    // A keychain that couldn't answer is asked again next time.
    key.catch(() => (key = null));
    return key;
  };

  return {
    async get(account) {
      let raw: Buffer;
      try {
        raw = readFileSync(fileOf(account));
      } catch {
        return null;
      }
      return open(await keyOf(), account, raw);
    },
    async set(account, value) {
      const sealed = seal(await keyOf(), account, value);
      mkdirSync(o.dir, { recursive: true, mode: 0o700 });
      chmodSync(o.dir, 0o700);
      const file = fileOf(account);
      writeFileSync(`${file}.tmp`, sealed, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
    async remove(account) {
      rmSync(fileOf(account), { force: true });
    },
  };
}

function seal(key: Buffer, account: string, value: string): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(account, "utf8"));
  const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

/** The value, or null when it was sealed for another account or under another key, or was changed. */
function open(key: Buffer, account: string, raw: Buffer): string | null {
  if (raw.length < IV + TAG) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV));
    d.setAAD(Buffer.from(account, "utf8"));
    d.setAuthTag(raw.subarray(IV, IV + TAG));
    return Buffer.concat([d.update(raw.subarray(IV + TAG)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
