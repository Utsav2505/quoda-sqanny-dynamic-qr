import type { Bindings } from "../types";

/** Requests allowed per IP per fixed window. */
const RATE_LIMIT_MAX = 30;
/** Fixed window length in seconds. */
const RATE_WINDOW_SECONDS = 60;

/**
 * Fixed-window rate limiter keyed by `prefix:ip`, for public endpoints.
 *
 * KV has no atomic increment, so this is a read-modify-write; a small amount of
 * slop under heavy concurrency is acceptable for an abuse guard.
 *
 * Extracted from the copy that was inline in routes/api/preview.ts so new
 * public endpoints do not each grow their own variant.
 */
export async function withinRateLimit(
  env: Bindings,
  prefix: string,
  ip: string,
  max = RATE_LIMIT_MAX,
  windowSeconds = RATE_WINDOW_SECONDS,
): Promise<boolean> {
  const windowId = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `${prefix}:${ip}:${windowId}`;
  const current = Number(await env.RATE_LIMIT.get(key)) || 0;
  if (current >= max) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), {
    // Expire shortly after the window closes so keys never accumulate.
    expirationTtl: windowSeconds * 2,
  });
  return true;
}
