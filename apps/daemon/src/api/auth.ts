import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const TOKEN_PREFIX = "ion.token.";

const digest = (x: string) => createHash("sha256").update(x).digest();

/**
 * A fresh token and a check for WebSocket handshakes. The token travels as a subprotocol
 * ("ion.token.<token>"): browsers can set it, and it stays out of URLs. Compared in constant time.
 */
export function createAuth(): { token: string; isAuthorized(req: IncomingMessage): boolean } {
  const token = randomBytes(24).toString("base64url");
  const expected = digest(token);
  return {
    token,
    isAuthorized(req) {
      const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",");
      return offered.some((raw) => {
        const p = raw.trim();
        return p.startsWith(TOKEN_PREFIX) && timingSafeEqual(digest(p.slice(TOKEN_PREFIX.length)), expected);
      });
    },
  };
}
