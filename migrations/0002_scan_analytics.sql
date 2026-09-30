-- Rich scan analytics.
--
-- Two changes:
--   1. `scans` gains the dimensions collected at redirect time (server-side)
--      and by the optional async client enrichment pass.
--   2. `scan_daily`'s primary key is widened so the dashboard can break scans
--      down by OS and browser, not just country and device.
--
-- PRIVACY: `ip_hash` is a truncated HMAC of the request IP with a secret key and
-- a DAILY-ROTATING salt (see src/lib/iphash.ts). A raw address is never stored
-- and hashes are not correlatable across days.

ALTER TABLE scans ADD COLUMN ip_hash TEXT;
ALTER TABLE scans ADD COLUMN continent TEXT;
ALTER TABLE scans ADD COLUMN region TEXT;
ALTER TABLE scans ADD COLUMN postal_code TEXT;
ALTER TABLE scans ADD COLUMN latitude REAL;
ALTER TABLE scans ADD COLUMN longitude REAL;
ALTER TABLE scans ADD COLUMN as_org TEXT;
ALTER TABLE scans ADD COLUMN os TEXT;
ALTER TABLE scans ADD COLUMN os_version TEXT;
ALTER TABLE scans ADD COLUMN browser TEXT;
ALTER TABLE scans ADD COLUMN browser_version TEXT;
ALTER TABLE scans ADD COLUMN language TEXT;

-- Client-side enrichment. Always NULL for scans whose destination is an
-- external URL — our JS only runs on hosted /p/:slug pages.
ALTER TABLE scans ADD COLUMN screen_w INTEGER;
ALTER TABLE scans ADD COLUMN screen_h INTEGER;
ALTER TABLE scans ADD COLUMN viewport_w INTEGER;
ALTER TABLE scans ADD COLUMN viewport_h INTEGER;
ALTER TABLE scans ADD COLUMN dpr REAL;
ALTER TABLE scans ADD COLUMN color_depth INTEGER;
ALTER TABLE scans ADD COLUMN touch_points INTEGER;
ALTER TABLE scans ADD COLUMN timezone TEXT;
ALTER TABLE scans ADD COLUMN hardware_concurrency INTEGER;
ALTER TABLE scans ADD COLUMN device_memory REAL;

-- Precise geolocation, populated ONLY when the browser already holds a granted
-- geolocation permission (navigator.permissions.query, which never prompts).
-- Users who were never asked, or who declined, leave these NULL forever.
ALTER TABLE scans ADD COLUMN geo_lat REAL;
ALTER TABLE scans ADD COLUMN geo_lon REAL;
ALTER TABLE scans ADD COLUMN geo_accuracy_m REAL;

-- Supports per-day unique-visitor counts: COUNT(DISTINCT ip_hash).
CREATE INDEX idx_scans_qr_ip ON scans (qr_id, ip_hash);

-- ---------------------------------------------------------------------------
-- scan_daily rebuild.
--
-- The primary key must widen to include os + browser + language, which SQLite
-- cannot do with ALTER. NULLs are also distinct in a PRIMARY KEY under SQLite's
-- non-WITHOUT-ROWID quirk, so the values are COALESCEd to '' on insert (see
-- logScan) to keep upserts stable. Rebuild to change the key.
--
-- `city` is deliberately NOT aggregated here: it has thousands of distinct
-- values, so including it would multiply rows without bound. The dashboard
-- reads top cities from `scans` instead.
-- ---------------------------------------------------------------------------
CREATE TABLE scan_daily_new (
  qr_id TEXT NOT NULL,
  day TEXT NOT NULL,                  -- YYYY-MM-DD
  country TEXT,
  device TEXT,
  os TEXT,
  browser TEXT,
  language TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (qr_id, day, country, device, os, browser, language)
);

-- Preserve existing aggregates. The new dimensions are unknown for historical
-- rows, so they coalesce to '' rather than NULL to satisfy the key.
INSERT INTO scan_daily_new (qr_id, day, country, device, os, browser, language, count)
SELECT qr_id, day, country, device, '', '', '', count FROM scan_daily;

DROP TABLE scan_daily;
ALTER TABLE scan_daily_new RENAME TO scan_daily;
