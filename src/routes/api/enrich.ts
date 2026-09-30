import { Hono } from "hono";
import type { Bindings } from "../../types";
import { readCookie } from "../../lib/auth/session";
import { clientIp } from "../../lib/iphash";
import { withinRateLimit } from "../../lib/ratelimit";
import { SCAN_COOKIE, clearedScanCookie, isHostedDestination } from "../../lib/analytics";

/**
 * POST /api/enrich — attach client-side measurements to a scan.
 *
 * This is the only UNAUTHENTICATED WRITE surface in the app, so it is built to
 * assume the caller is hostile:
 *
 *   - It never trusts the body. A fixed allowlist of columns is validated and
 *     clamped, and anything unrecognised is ignored. Column names are never
 *     taken from the request.
 *   - It updates exactly one row, addressed only by the HttpOnly correlation
 *     cookie the redirect set. The script cannot read or forge that cookie, and
 *     it must correspond to a scan whose QR points at a page WE host.
 *   - `SameSite=Lax` means a cross-site POST never carries the cookie, and the
 *     JSON content type forces a preflight. Together those close CSRF without
 *     a token round trip.
 *   - It is idempotent: repeating a call writes the same values, and the row
 *     is capped to a recent window so a stale cookie cannot rewrite history.
 *   - The response is 204 and never blocks a page render.
 */
export const enrichApi = new Hono<{ Bindings: Bindings }>();

/** Only scans this recent may be enriched, so an old cookie is inert. */
const MAX_SCAN_AGE_MS = 30 * 60 * 1000;

/** A scan id is a UUID; anything else is not one we issued. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Coerce a JSON number into an integer clamped to [min, max]. */
function intIn(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Coerce a JSON number into a float clamped to [min, max]. */
function floatIn(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

/** Coerce a JSON string into a trimmed, length-capped value. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max);
  return s.length ? s : null;
}

/**
 * Validate a client payload into a column -> value map.
 *
 * Every field is independently optional; an absent or invalid one is simply
 * omitted so the column keeps its previous value rather than being nulled.
 */
function validated(payload: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const put = (k: string, v: string | number | null) => {
    if (v !== null) out[k] = v;
  };

  put("screen_w", intIn(payload.screen_w, 0, 20000));
  put("screen_h", intIn(payload.screen_h, 0, 20000));
  put("viewport_w", intIn(payload.viewport_w, 0, 20000));
  put("viewport_h", intIn(payload.viewport_h, 0, 20000));
  put("dpr", floatIn(payload.dpr, 0, 100));
  put("color_depth", intIn(payload.color_depth, 1, 64));
  put("touch_points", intIn(payload.touch_points, 0, 20));
  put("hardware_concurrency", intIn(payload.hardware_concurrency, 1, 256));
  put("device_memory", floatIn(payload.device_memory, 0, 64));

  // Timezone: shape-checked, because this column is the one most likely to be
  // used to fingerprint a locale.
  const tz = text(payload.timezone, 64);
  if (tz && /^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+){0,2}$/.test(tz)) {
    out.timezone = tz;
  }

  // Precise geolocation. Only ever populated when the browser already held a
  // granted permission; see the client tracker for why no prompt is shown.
  const lat = floatIn(payload.geo_lat, -90, 90);
  const lon = floatIn(payload.geo_lon, -180, 180);
  if (lat !== null && lon !== null) {
    out.geo_lat = lat;
    out.geo_lon = lon;
    const acc = floatIn(payload.geo_accuracy_m, 0, 100_000);
    if (acc !== null) out.geo_accuracy_m = acc;
  }

  return out;
}

/** Reject an Origin that is not us, when the browser sent one at all. */
function originAllowed(req: Request, appUrl: string): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser client; CSRF is not the threat here
  try {
    return new URL(origin).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

enrichApi.post("/api/enrich", async (c) => {
  const env = c.env;
  const secure = env.APP_URL.startsWith("https://");
  const ip = clientIp(c.req.raw) ?? "unknown";

  if (!originAllowed(c.req.raw, env.APP_URL)) {
    return c.text("Forbidden", 403);
  }
  if (!(await withinRateLimit(env, "enrich", ip))) {
    return c.text("Too Many Requests", 429);
  }

  const scanId = readCookie(c.req.raw, SCAN_COOKIE);
  if (!scanId || !UUID_RE.test(scanId)) {
    return c.text("No scan token", 400);
  }

  // The row must exist, be recent, and belong to a QR pointing at a page we
  // host. The last check is what stops a forged cookie from attaching client
  // data to a scan whose destination is an external site.
  const row = await env.DB.prepare(
    `SELECT q.destination
       FROM scans s
       JOIN qr_codes q ON q.id = s.qr_id
      WHERE s.id = ? AND s.ts > ?`,
  )
    .bind(scanId, Date.now() - MAX_SCAN_AGE_MS)
    .first<{ destination: string | null }>();
  if (!row?.destination || !isHostedDestination(row.destination, env.APP_URL)) {
    return c.text("Unknown scan", 404);
  }

  let payload: Record<string, unknown> = {};
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed or empty body is not an error: the token is still consumed
    // and the cookie cleared so the client does not retry forever.
  }

  const fields = validated(payload);
  if (Object.keys(fields).length) {
    // Column names come from `fields`, which is built solely from the literals
    // above — never from request data — so this interpolation is safe.
    const sets = Object.keys(fields).map((c2) => `${c2} = ?`).join(", ");
    await env.DB.prepare(`UPDATE scans SET ${sets} WHERE id = ?`)
      .bind(...Object.values(fields), scanId)
      .run();
  }

  // One token, one enrichment. Expiring the cookie stops a stale value from
  // being replayed and keeps the client from re-sending on every navigation.
  c.header("Set-Cookie", clearedScanCookie(secure));
  return c.body(null, 204);
});
