import type { Bindings } from "../../types";
import {
  createSession,
  getSessionRow,
  deleteSession,
  getUserById,
} from "../../db/queries";

export const SESSION_COOKIE = "sqanny_session";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_TTL_S = SESSION_TTL_MS / 1000;

interface CachedSession {
  userId: string;
  expiresAt: number;
}

function cacheKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * Whether to mark cookies Secure. Always on for https (production); off for a
 * plain-http APP_URL so local dev works when reached over a LAN IP too
 * (browsers special-case localhost but not 192.168.x.x over http).
 */
function isSecure(env: Bindings): boolean {
  return env.APP_URL.startsWith("https://");
}

/** Build the Set-Cookie value for a live session. */
function sessionCookie(sessionId: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** Build the Set-Cookie value that immediately expires the session cookie. */
function expiredCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=0`;
}

/** Read a named cookie from a request's Cookie header. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/**
 * Create a 30-day session in D1, cache it in KV for fast reads, and return the
 * Set-Cookie value to attach to the response.
 */
export async function startSession(
  env: Bindings,
  userId: string,
  ua?: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;

  await createSession(env.DB, { id, userId, expiresAt, ua: ua ?? null });

  const cached: CachedSession = { userId, expiresAt };
  await env.SESSION_CACHE.put(cacheKey(id), JSON.stringify(cached), {
    expirationTtl: SESSION_TTL_S,
  });

  return sessionCookie(id, SESSION_TTL_S, isSecure(env));
}

/**
 * Resolve the authenticated user from a request. Checks the KV cache first,
 * falling back to D1, and validates the session has not expired.
 */
export async function getUserFromRequest(
  env: Bindings,
  request: Request,
): Promise<{
  id: string;
  email: string;
  plan_id: string;
  onboarded_at: number | null;
} | null> {
  const sessionId = readCookie(request, SESSION_COOKIE);
  if (!sessionId) return null;

  const now = Date.now();
  let userId: string | null = null;

  // Fast path: KV cache. A cache read failure is non-fatal — fall through to D1.
  try {
    const cachedRaw = await env.SESSION_CACHE.get(cacheKey(sessionId));
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw) as CachedSession;
      if (cached.expiresAt > now) {
        userId = cached.userId;
      } else {
        await env.SESSION_CACHE.delete(cacheKey(sessionId)).catch(() => {});
      }
    }
  } catch {
    // Corrupt cache entry or transient KV error — ignore and use D1.
  }

  // Slow path: D1. A storage failure here means we cannot verify the session;
  // treat as unauthenticated rather than throwing a 500 on every request.
  try {
    if (!userId) {
      const row = await getSessionRow(env.DB, sessionId);
      if (!row) return null;
      if (row.expires_at <= now) return null;
      userId = row.user_id;
      const ttl = Math.max(1, Math.floor((row.expires_at - now) / 1000));
      await env.SESSION_CACHE.put(
        cacheKey(sessionId),
        JSON.stringify({ userId, expiresAt: row.expires_at } satisfies CachedSession),
        { expirationTtl: ttl },
      ).catch(() => {});
    }

    const user = await getUserById(env.DB, userId);
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      plan_id: user.plan_id,
      onboarded_at: user.onboarded_at,
    };
  } catch (err) {
    console.error("[session] lookup failed:", err);
    return null;
  }
}

/**
 * Destroy the session referenced by the request's cookie (D1 + KV) and return
 * a Set-Cookie value that clears it in the browser.
 */
export async function endSession(
  env: Bindings,
  request: Request,
): Promise<string> {
  const sessionId = readCookie(request, SESSION_COOKIE);
  if (sessionId) {
    await Promise.all([
      deleteSession(env.DB, sessionId),
      env.SESSION_CACHE.delete(cacheKey(sessionId)),
    ]);
  }
  return expiredCookie(isSecure(env));
}
