/**
 * Pseudonymous IP hashing for scan analytics.
 *
 * A raw IP address is personal data under GDPR. Storing one would make Quoda a
 * honeypot for exactly the kind of traffic it exists to measure. So the address
 * is never persisted: it is HMAC'd with a secret key and a DAILY-ROTATING salt,
 * then truncated.
 *
 * What this buys:
 *   - "how many distinct people scanned this code today" is answerable, because
 *     equal addresses produce equal hashes within a day.
 *   - The address cannot be recovered from the hash, and cannot be correlated
 *     with a real-world IP list without the secret.
 *   - Because the salt rotates daily, hashes are NOT linkable across days. A
 *     user cannot be tracked over time. This bounds the damage of a breach to
 *     "everyone who scanned on the 14th".
 *
 * The cost is deliberate: no per-visitor journey across days. For QR analytics
 * — which cares about counts, geography and device mix, not attribution — that
 * trade is strongly favourable.
 */

/** Truncated hash length in hex chars (16 chars = 64 bits). */
const HASH_HEX_LEN = 16;

/** Current UTC date as YYYY-MM-DD. */
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Best-effort client IP from a request.
 *
 * `cf-connecting-ip` is set by Cloudflare and cannot be spoofed by the client
 * on a proxied route. `x-forwarded-for` is the self-hosted fallback and IS
 * client-spoofable, so it is only trusted when Cloudflare did not set the
 * header. Returns null when neither is present.
 */
export function clientIp(req: Request): string | null {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!ip) return null;
  // Basic shape check so junk in a forwarded header is never hashed.
  return /^[\w.:a-fA-F]{3,45}$/.test(ip) ? ip : null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash an IP into a stable, non-reversible, per-day pseudonym.
 *
 * Returns null — never the raw address — when:
 *   - the IP is missing or malformed, or
 *   - `SCAN_HASH_SECRET` is not configured.
 *
 * The secret being absent is a supported state (local dev, misconfigured
 * deploy). It degrades to "no unique-visitor counting", which is strictly
 * better than silently persisting identifiers.
 */
export async function hashIp(
  ip: string | null,
  secret: string | undefined,
  ts = Date.now(),
): Promise<string | null> {
  if (!ip || !secret) return null;
  const message = `${utcDay(ts)}:${ip}`;
  return (await hmacHex(secret, message)).slice(0, HASH_HEX_LEN);
}

/**
 * Hash a request's IP, resolving the address first. Convenience wrapper that
 * keeps the call site in `logScan` to a single line.
 */
export function hashRequestIp(
  req: Request,
  secret: string | undefined,
  ts = Date.now(),
): Promise<string | null> {
  return hashIp(clientIp(req), secret, ts);
}
