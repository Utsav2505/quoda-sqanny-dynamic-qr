import type { Bindings } from "../types";
import { parseUA, primaryLanguage } from "./ua";
import { clientIp, hashRequestIp } from "./iphash";

export type Device = "mobile" | "tablet" | "desktop";

/** Current UTC date as YYYY-MM-DD. */
function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Classify a user-agent into a coarse device bucket. */
export function deviceFromUA(ua: string | null | undefined): Device {
  return parseUA(ua).device;
}

interface CfLike {
  country?: string | null;
  city?: string | null;
  continent?: string | null;
  region?: string | null;
  postalCode?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  asOrganization?: string | null;
}

/** Clamp free-text dimensions so a hostile header cannot bloat the row. */
function clip(v: string | null | undefined, max = 64): string | null {
  if (!v) return null;
  const s = v.slice(0, max);
  return s.length ? s : null;
}

// ---------------------------------------------------------------------------
// Scan correlation cookie
//
// The redirect stamps the freshly-minted scan id into a short-lived HttpOnly
// cookie. The hosted landing page's enrichment beacon is a SAME-ORIGIN request,
// so the browser attaches this cookie by itself — the client script never reads
// it, which is what lets it stay HttpOnly (unreadable by injected JS).
// ---------------------------------------------------------------------------

export const SCAN_COOKIE = "sqanny_scan";

/** Ten minutes: long enough to survive a page load, short enough to not litter. */
const SCAN_COOKIE_TTL_S = 600;

/** Build the Set-Cookie value carrying the scan correlation id. */
export function scanCookie(scanId: string, secure: boolean): string {
  return `${SCAN_COOKIE}=${scanId}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${SCAN_COOKIE_TTL_S}`;
}

/** Build the Set-Cookie value that expires the correlation cookie after use. */
export function clearedScanCookie(secure: boolean): string {
  return `${SCAN_COOKIE}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Whether a destination points at a landing page WE host (/p/<slug>).
 *
 * Only those can ever run the client-side enrichment script, so the redirect
 * only sets the correlation cookie for them — external destinations get a
 * byte-for-byte identical response to before. The origin is compared too, so a
 * third-party URL that merely contains "/p/" is not treated as hosted.
 */
export function isHostedDestination(destination: string, appUrl: string): boolean {
  // Cheap pre-check: the overwhelming majority of destinations are external
  // URLs that never contain "/p/", so this skips two URL parses on the hot path.
  if (!destination.includes("/p/")) return false;
  try {
    const d = new URL(destination);
    return d.origin === new URL(appUrl).origin && d.pathname.startsWith("/p/");
  } catch {
    return false;
  }
}

/** Coerce a Cloudflare numeric-as-string field to a finite number, or null. */
function num(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Whether SCAN_LOG_IP debug logging is switched on. */
function ipLoggingOn(env: Bindings): boolean {
  const v = env.SCAN_LOG_IP?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Emit a one-line, greppable summary of a scan. DEBUG ONLY — this is the one
 * place a raw IP is ever visible, it is never persisted to D1, and it is
 * gated behind SCAN_LOG_IP because Cloudflare retains console output whenever
 * observability is enabled.
 */
function logScanDebug(
  env: Bindings,
  qrId: string,
  ip: string | null,
  cf: CfLike | undefined,
  ua: ReturnType<typeof parseUA>,
  language: string | null,
  ref: string | null,
): void {
  console.log(
    `[scan] qr=${qrId} ip=${ip ?? "unknown"} ` +
      `geo=${cf?.city || "?"},${cf?.country || "?"} ` +
      `device=${ua.device} os=${ua.os}${ua.osVersion ? ` ${ua.osVersion}` : ""} ` +
      `browser=${ua.browser}${ua.browserVersion ? ` ${ua.browserVersion}` : ""} ` +
      `lang=${language ?? "?"} ref=${ref ?? "-"}`,
  );
}

/**
 * Log a single scan: bump KV counters, write a raw scans row, and upsert the
 * daily aggregate. Designed to run inside ctx.waitUntil so it never blocks the
 * redirect response.
 *
 * `scanId` is supplied by the caller so the redirect can stamp the same value
 * into a correlation cookie BEFORE responding; the optional client-side
 * enrichment pass later reads that cookie to attach screen/locale data to this
 * exact row. A default is kept so direct callers and tests need not thread it.
 */
export async function logScan(
  env: Bindings,
  qr: { id: string },
  request: Request,
  scanId: string = crypto.randomUUID(),
): Promise<void> {
  // Analytics is best-effort and runs inside ctx.waitUntil — a transient KV/D1
  // failure must NEVER surface or break the redirect (the "never breaks"
  // promise. Swallow and log; the scan total may be off by one, that's all.
  try {
    const cf = (request as Request & { cf?: CfLike }).cf;
    const country = clip(cf?.country, 8);
    const city = clip(cf?.city, 64);
    const referer =
      request.headers.get("referer") ?? request.headers.get("referrer") ?? null;
    const ts = Date.now();
    const day = utcDay(ts);

    const ua = parseUA(request.headers.get("user-agent"));
    const language = primaryLanguage(request.headers.get("accept-language"));
    const ip = clientIp(request);
    const ipHash = await hashRequestIp(request, env.SCAN_HASH_SECRET, ts);

    if (ipLoggingOn(env)) {
      logScanDebug(env, qr.id, ip, cf, ua, language, referer);
    }

    const totalKey = `qr:${qr.id}:total`;
    const dayKey = `qr:${qr.id}:${day}`;

    // KV counters: read-modify-write (KV has no atomic increment).
    const [curTotal, curDay] = await Promise.all([
      env.SCAN_COUNTERS.get(totalKey),
      env.SCAN_COUNTERS.get(dayKey),
    ]);
    await Promise.all([
      env.SCAN_COUNTERS.put(totalKey, String((Number(curTotal) || 0) + 1)),
      env.SCAN_COUNTERS.put(dayKey, String((Number(curDay) || 0) + 1)),
    ]);

    // Raw scan row. Client-side enrichment columns are intentionally omitted
    // (NULL): they are filled in later by the optional /api/enrich pass, and
    // only for scans landing on a page we host.
    //
    // `ip` is the raw client address, stored deliberately (migration 0003);
    // `ip_hash` is the daily-rotating pseudonym that survives anonymisation.
    await env.DB.prepare(
      `INSERT INTO scans (
         id, qr_id, ts, country, city, device, referer,
         ip, ip_hash, continent, region, postal_code, latitude, longitude, as_org,
         os, os_version, browser, browser_version, language
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        scanId,
        qr.id,
        ts,
        country,
        city,
        ua.device,
        clip(referer, 512),
        ip,
        ipHash,
        clip(cf?.continent, 32),
        clip(cf?.region, 64),
        clip(cf?.postalCode, 16),
        num(cf?.latitude),
        num(cf?.longitude),
        clip(cf?.asOrganization, 64),
        ua.os,
        ua.osVersion,
        ua.browser,
        ua.browserVersion,
        language,
      )
      .run();

    // Daily aggregate. country/os/browser are part of the PK and can be NULL;
    // SQLite treats NULL as distinct in UNIQUE/PK, so we coalesce to '' for
    // stable upserts. The conflict target MUST match the widened primary key in
    // migrations/0002 — a mismatch fails silently inside this try/catch and
    // stops the dashboard aggregate from ever incrementing.
    await env.DB.prepare(
      `INSERT INTO scan_daily (qr_id, day, country, device, os, browser, language, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(qr_id, day, country, device, os, browser, language)
         DO UPDATE SET count = count + 1`,
    )
      .bind(qr.id, day, country ?? "", ua.device, ua.os, ua.browser, language ?? "")
      .run();
  } catch (err) {
    console.error(`[analytics] logScan failed for qr ${qr.id}:`, err);
  }
}

/** Total scans for a QR (from the KV fast counter). */
export async function getTotals(env: Bindings, qrId: string): Promise<number> {
  const v = await env.SCAN_COUNTERS.get(`qr:${qrId}:total`);
  return Number(v) || 0;
}

/** Daily scan counts for the last `days` days, oldest-first. */
export async function getDaily(
  env: Bindings,
  qrId: string,
  days = 30,
): Promise<Array<{ day: string; count: number }>> {
  const since = utcDay(Date.now() - days * 86_400_000);
  const { results } = await env.DB.prepare(
    `SELECT day, SUM(count) AS count
       FROM scan_daily
      WHERE qr_id = ? AND day >= ?
      GROUP BY day
      ORDER BY day ASC`,
  )
    .bind(qrId, since)
    .all<{ day: string; count: number }>();
  return (results ?? []).map((r) => ({ day: r.day, count: Number(r.count) }));
}

/** Collapse aggregate rows into a label -> count map, folding empty keys
 *  (SQLite's NULL stand-in) into "unknown" so the UI always has a label. */
function toCountMap<T>(
  results: T[] | undefined,
  pick: (row: T) => { label: string | null; count: number },
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of results ?? []) {
    const { label, count } = pick(row);
    const k = label && label !== "" ? label : "unknown";
    out[k] = (out[k] ?? 0) + Number(count ?? 0);
  }
  return out;
}

/**
 * Reduce a stored referer to `host/short-path` for display.
 *
 * A referer routinely carries session tokens, search queries and campaign ids.
 * The owner rarely needs those, but does need to know which site or app drove
 * the scan, so the query string and fragment are dropped rather than rendered.
 */
export function refererLabel(referer: string | null | undefined): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    const path = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean).slice(0, 2).join("/");
    return path ? `${u.hostname}/${path}` : u.hostname;
  } catch {
    // Not a parseable URL (some apps send opaque strings). Show a clipped
    // prefix rather than dropping the signal entirely.
    return referer.slice(0, 48);
  }
}

export interface ScanDetail {
  id: string;
  ts: number;
  ip: string | null;
  ipHash: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  device: string | null;
  os: string | null;
  osVersion: string | null;
  browser: string | null;
  browserVersion: string | null;
  language: string | null;
  referer: string | null;
  screenW: number | null;
  screenH: number | null;
  dpr: number | null;
  timezone: string | null;
  geoLat: number | null;
  geoLon: number | null;
  geoAccuracyM: number | null;
  /** True once the async client pass has attached display data to this row. */
  enriched: boolean;
}

/** Hard ceiling on rows one request may return. */
const MAX_SCAN_ROWS = 200;

/**
 * Individual scans for a QR, newest first, for the raw-scan table.
 *
 * `limit` is clamped to MAX_SCAN_ROWS so a crafted query string cannot ask the
 * database for the entire table.
 */
export async function getScans(
  env: Bindings,
  qrId: string,
  limit = 50,
  offset = 0,
): Promise<ScanDetail[]> {
  const capped = Math.max(1, Math.min(MAX_SCAN_ROWS, Math.floor(limit) || 50));
  const from = Math.max(0, Math.floor(offset) || 0);

  const { results } = await env.DB.prepare(
    `SELECT id, ts, ip, ip_hash, country, city, region, device,
            os, os_version, browser, browser_version, language, referer,
            screen_w, screen_h, dpr, timezone, geo_lat, geo_lon, geo_accuracy_m
       FROM scans
      WHERE qr_id = ?
      ORDER BY ts DESC, id DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(qrId, capped, from)
    .all<Record<string, unknown>>();

  return (results ?? []).map((r) => ({
    id: String(r.id),
    ts: Number(r.ts),
    ip: r.ip == null ? null : String(r.ip),
    ipHash: r.ip_hash == null ? null : String(r.ip_hash),
    country: r.country == null ? null : String(r.country),
    city: r.city == null ? null : String(r.city),
    region: r.region == null ? null : String(r.region),
    device: r.device == null ? null : String(r.device),
    os: r.os == null ? null : String(r.os),
    osVersion: r.os_version == null ? null : String(r.os_version),
    browser: r.browser == null ? null : String(r.browser),
    browserVersion: r.browser_version == null ? null : String(r.browser_version),
    language: r.language == null ? null : String(r.language),
    referer: refererLabel(r.referer == null ? null : String(r.referer)),
    screenW: r.screen_w == null ? null : Number(r.screen_w),
    screenH: r.screen_h == null ? null : Number(r.screen_h),
    dpr: r.dpr == null ? null : Number(r.dpr),
    timezone: r.timezone == null ? null : String(r.timezone),
    geoLat: r.geo_lat == null ? null : Number(r.geo_lat),
    geoLon: r.geo_lon == null ? null : Number(r.geo_lon),
    geoAccuracyM: r.geo_accuracy_m == null ? null : Number(r.geo_accuracy_m),
    // The client pass only runs for scans landing on a hosted /p/ page, so this
    // is what tells the table apart from rows that simply have no such data.
    enriched: r.screen_w != null || r.timezone != null || r.geo_lat != null,
  }));
}

export interface Breakdown {
  country: Record<string, number>;
  device: Record<string, number>;
  os: Record<string, number>;
  browser: Record<string, number>;
  language: Record<string, number>;
  /** Top cities by scan count. Read from `scans`, not scan_daily: city has
   *  thousands of distinct values and would explode the aggregate. */
  city: Array<{ name: string; count: number }>;
}

interface DimensionRow {
  country: string | null;
  device: string | null;
  os: string | null;
  browser: string | null;
  language: string | null;
  count: number;
}

/**
 * Dimension breakdowns aggregated across all time.
 *
 * Deliberately ONE grouped query rather than one per dimension: the row count
 * is bounded by the number of real dimension combinations (a few hundred even
 * for a busy code), so a single pass is far cheaper than five separate scans of
 * scan_daily. City is excluded here for cardinality reasons and read separately.
 */
export async function getBreakdown(env: Bindings, qrId: string): Promise<Breakdown> {
  const [{ results }, city] = await Promise.all([
    env.DB.prepare(
      `SELECT country, device, os, browser, language, SUM(count) AS count
         FROM scan_daily WHERE qr_id = ?
        GROUP BY country, device, os, browser, language`,
    )
      .bind(qrId)
      .all<DimensionRow>(),
    getTopCities(env, qrId, 6),
  ]);

  const rows = results ?? [];
  return {
    country: toCountMap(rows, (r) => ({ label: r.country, count: r.count })),
    device: toCountMap(rows, (r) => ({ label: r.device, count: r.count })),
    os: toCountMap(rows, (r) => ({ label: r.os, count: r.count })),
    browser: toCountMap(rows, (r) => ({ label: r.browser, count: r.count })),
    language: toCountMap(rows, (r) => ({ label: r.language, count: r.count })),
    city,
  };
}

/** Top `limit` cities by raw scan count, excluding rows with no city. */
export async function getTopCities(
  env: Bindings,
  qrId: string,
  limit = 6,
): Promise<Array<{ name: string; count: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT city AS name, COUNT(*) AS count
       FROM scans
      WHERE qr_id = ? AND city IS NOT NULL AND city != ''
      GROUP BY city
      ORDER BY count DESC, name ASC
      LIMIT ?`,
  )
    .bind(qrId, limit)
    .all<{ name: string; count: number }>();
  return (results ?? []).map((r) => ({ name: r.name, count: Number(r.count) }));
}

/**
 * Distinct scanners, by counting distinct ip_hash values.
 *
 * The hash salt rotates daily (see lib/iphash.ts), so the same person scanning
 * on two different days yields two unrelated hashes. That makes `total` an
 * all-time distinct ACROSS DAYS, which UNDER-counts anyone who scanned on more
 * than one day — it is a floor, not a true unique-visitor number. `daily` is
 * exact within each day. Callers should present an average over active days
 * rather than `total` as "unique people".
 *
 * Returns zeros when SCAN_HASH_SECRET is unset, since no hashes are written.
 */
export async function getUniques(
  env: Bindings,
  qrId: string,
  days = 30,
): Promise<{ total: number; daily: Array<{ day: string; count: number }> }> {
  const sinceTs = Date.now() - days * 86_400_000;

  const [allTime, byDay] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(DISTINCT ip_hash) AS n
         FROM scans WHERE qr_id = ? AND ip_hash IS NOT NULL`,
    )
      .bind(qrId)
      .first<{ n: number }>(),
    env.DB.prepare(
      // `scans` stores a millisecond epoch, not a day string, so the UTC day
      // is derived here. This must agree with utcDay() above (toISOString on a
      // UTC timestamp) or the same scan lands in two different buckets.
      `SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(DISTINCT ip_hash) AS n
         FROM scans
        WHERE qr_id = ? AND ip_hash IS NOT NULL AND ts >= ?
        GROUP BY day
        ORDER BY day ASC`,
    )
      .bind(qrId, sinceTs)
      .all<{ day: string; n: number }>(),
  ]);

  return {
    total: Number(allTime?.n ?? 0),
    daily: (byDay.results ?? []).map((r) => ({ day: r.day, count: Number(r.n) })),
  };
}
