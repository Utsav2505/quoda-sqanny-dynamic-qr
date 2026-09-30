# Plan — Rich Scan Data Collection (zero-latency redirect)

Branch: `data-collection`
Status: proposed, not yet implemented

## Goal

Collect device type, OS, browser, country, city, hashed IP, screen resolution,
language and geolocation (if already permitted) on every dynamic QR scan —
without adding a single millisecond to the `/r/:code` redirect.

## Hard constraint: the redirect must not get slower

The redirect is the product. A QR code is scanned in a queue, in a shop, with
one bar of signal. Every millisecond we add is felt.

The mechanism that protects this is `ctx.waitUntil` (src/routes/redirect.ts:27).
The response is already sent before `logScan` runs. So the rule is:

> **All new server-side capture happens inside the existing `waitUntil`.**
> **Zero new `await`s are added before `c.redirect()`.**

Concretely, the only new *synchronous* work on the hot path is one
`crypto.randomUUID()` and one `Set-Cookie` header, both sub-microsecond and
requiring no I/O. The cookie is the correlation token that lets the async
client-side enrichment attach itself to the correct scan row.

Verification gate: `tests/redirect.test.ts` must assert the redirect resolves
without awaiting any D1/KV write for the new fields, and we add a test that the
enrichment payload is not required for the row to be written.

## The hard limitation (read this before scoping)

**The client-side tracker only runs on `/p/:slug` pages we host.**

The QR encodes `/r/<short_code>`, which 302s to `qr.destination`. If that
destination is an external URL, the browser lands on someone else's server and
none of our JavaScript ever runs. There is no interstitial (rejected — it adds a
hop and a visible flash), so client-only fields are simply unavailable there.

| Field | External destination | `/p/:slug` hosted page |
| --- | --- | --- |
| IP hash, country, city, device, OS, browser, language, referer | Yes | Yes |
| Screen res, viewport, DPR, color depth, touch points | No | Yes |
| Timezone, hardware concurrency, device memory | No | Yes |
| Geolocation (if previously granted) | No | Yes |

This is not fixable without an interstitial or a JS-injected destination. It is
a hard physical limit of HTTP redirects. Do not let anyone "fix" it later by
adding a hop.

## Data model

### Migration `0002_scan_analytics.sql`

Add columns to `scans`:

| Column | Type | Source |
| --- | --- | --- |
| `ip_hash` | TEXT | HMAC-SHA256(ip + daily salt), 16 hex chars |
| `continent` | TEXT | `cf.continent` |
| `region` | TEXT | `cf.region` |
| `postal_code` | TEXT | `cf.postalCode` |
| `latitude` | REAL | `cf.latitude` (city-level, CF-derived) |
| `longitude` | REAL | `cf.longitude` |
| `as_org` | TEXT | `cf.asOrganization` (mobile carrier / ISP) |
| `os` | TEXT | UA parse |
| `os_version` | TEXT | UA parse |
| `browser` | TEXT | UA parse |
| `browser_version` | TEXT | UA parse |
| `language` | TEXT | `Accept-Language` header, primary subtag |
| `screen_w` | INTEGER | client enrichment |
| `screen_h` | INTEGER | client enrichment |
| `viewport_w` | INTEGER | client enrichment |
| `viewport_h` | INTEGER | client enrichment |
| `dpr` | REAL | client enrichment |
| `color_depth` | INTEGER | client enrichment |
| `touch_points` | INTEGER | client enrichment |
| `timezone` | TEXT | client enrichment |
| `hardware_concurrency` | INTEGER | client enrichment |
| `device_memory` | REAL | client enrichment |
| `latitude_precise` | REAL | client geolocation, only if already granted |
| `longitude_precise` | REAL | client geolocation, only if already granted |
| `geo_precision_m` | INTEGER | client geolocation accuracy |

`scan_daily` needs its primary key widened to
`(qr_id, day, country, device, os, browser)` so the dashboard can break down by
OS and browser. NULLs defeat `ON CONFLICT`, so migration creates the new table,
copies, drops, renames — the standard SQLite rebuild.

Index: `CREATE INDEX idx_scans_qr_ip ON scans(qr_id, ip_hash)` for unique-visitor
counts, and `idx_scans_qr_ts` already exists.

### New binding

`SCAN_HASH_SECRET` — Worker secret (`wrangler secret put SCAN_HASH_SECRET`).
Never in `wrangler.jsonc`. Used as the HMAC key. Add to `.dev.vars.example` as a
commented placeholder and to `Bindings` in src/types.ts.

## Implementation order

1. `src/lib/ua.ts` — pure `parseUA(ua) -> { device, os, osVersion, browser,
   browserVersion }`. Must be a table of ordered regexes, not a chain of ifs;
   order matters (Edge before Chrome, Chrome OS before Linux, iPad before
   mobile). Pure, no I/O, unit-testable.
2. `src/lib/iphash.ts` — `hashIp(ip, day, secret)`. HMAC-SHA256 over
   `secret + day + ip`, hex, sliced to 16 chars. Daily salt rotation means
   hashes are not linkable across days, so this enables per-day unique visitors
   without storing an address. If `SCAN_HASH_SECRET` is unset, return `null`
   and skip — never fall back to storing a raw IP.
3. Migration `0002_scan_analytics.sql`.
4. Extend `logScan` (src/lib/analytics.ts:31) — same `waitUntil`, same
   best-effort try/catch. Writes the new server-side columns. Cookie token
   correlation added.
5. `src/routes/redirect.ts` — add the `Set-Cookie` correlation header. This is
   the only hot-path change and it is header-only.
6. `src/routes/api/enrich.ts` — `POST /api/enrich`, public, no auth. Reads the
   correlation cookie, validates it, updates that one `scans` row with the
   client fields. Must be strictly idempotent and rate-limited per IP
   (reuse the fixed-window pattern from src/routes/api/preview.ts:59).
   Returns 204, never blocks anything.
7. `src/client/enrich.ts` + build entry — the tracker script, injected into
   `Layout` (src/ui/layout.tsx:13) so it runs on `/p/:slug`. Uses
   `navigator.sendBeacon` so it never delays page unload. Wrapped in
   `requestIdleCallback` with a `setTimeout` fallback.
   - **Geolocation without prompting:** `navigator.permissions.query({name:
     'geolocation'})`. If `state === 'granted'`, call `getCurrentPosition` —
     no prompt appears. If `'prompt'` or unsupported, skip silently. Never call
     `getCurrentPosition` first; that is what triggers the dialog.
8. `getBreakdown` / `getDaily` extensions — add `os`, `browser`, `language`,
   `city` breakdowns and a `uniques` count.
9. `src/routes/api/analytics.ts` — pass the new breakdowns through.
10. `src/client/charts.ts` — render the new breakdowns in the existing
    `renderBars` idiom. Reuse `renderBars`; do not invent a chart type.
11. Tests.

## Client tracker: what it must not do

- No fingerprinting. No canvas hash, no audio hash, no font enumeration, no
  battery/API-surface probing. The moment this file grows a canvas read it has
  become a tracking script and the privacy story is gone.
- No cookies of its own. The correlation cookie is set by the redirect and
  deleted by the handler after use.
- `SameSite=Lax`, `Secure`, `HttpOnly` where possible. If the client script must
  read it to post the value, it cannot be `HttpOnly` — so instead the script
  posts nothing and the server reads the cookie itself, which keeps `HttpOnly`
  on. The script only sends measurements; the cookie rides along on the
  `sendBeacon` request automatically.

That last point is the reason the correlation works at all: the beacon is a
same-origin request, so the browser attaches the `HttpOnly` cookie without the
script ever touching it.

## Tests

- `tests/ua.test.ts` — parse table. iPadOS-as-desktop, Chrome OS, Edge, Samsung
  Internet, Firefox, and the "no UA" fallback.
- `tests/iphash.test.ts` — stable within a day, differs across days, differs
  across IPs, returns `null` without a secret, never returns the raw IP.
- `tests/analytics.test.ts` — new columns land; `ip_hash` is stored hashed;
  `scan_daily` upsert keys on the widened PK.
- `tests/redirect.test.ts` — the new cookie is set; the redirect still 302s to
  the same destination; the row is written without any client data present.
- `tests/enrich.test.ts` — rejects a missing/invalid/foreign correlation token;
  updates only the addressed row; is idempotent; is rate-limited; ignores
  unknown JSON keys; clamps field lengths.

## Explicitly out of scope

User chose "neither, analytics only":

- **No retention enforcement.** `analyticsRetentionDays` (30/365) stays
  unenforced, so these new columns accumulate forever. The hash salt rotates
  daily, which caps the damage, but rows still grow unbounded. Flagged, not
  fixed.
- **No `/privacy` page.** src/ui/components/footer.tsx:37 still links to a 404.
  Now worse than before: we collect more personal data and still have no policy
  page. Worth revisiting before this ships publicly.

## Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Extra `cf` fields increase the `scans` row size | Low | All text columns capped at 64 chars; integers only |
| `scan_daily` PK widening multiplies aggregate rows | Low | Bounded by real dimension cardinality (~250 countries x 10 OS x 15 browsers) |
| Public `/api/enrich` is an abuse vector | Medium | Per-IP fixed-window rate limit, strict token validation, idempotent single-row update |
| Enrichment row writes contend with `logScan` | Low | Both best-effort inside `waitUntil`; the redirect never awaits either |
| UA parser drift as browsers change | Low | Pure function, table-driven, exhaustively unit-tested |
| Dashboard query slows as `scans` grows | Medium | New breakdowns read `scan_daily`, not `scans`, wherever possible |
