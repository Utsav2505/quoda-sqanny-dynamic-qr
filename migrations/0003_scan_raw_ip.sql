-- Raw client IP on scans.
--
-- ADDITIVE ONLY: a single ADD COLUMN with no primary-key change, so this cannot
-- break the scan_daily upsert the way a key rebuild does. Safe to apply
-- independently of any code deploy.
--
-- PRIVACY — READ BEFORE DEPLOYING
-- This reverses an earlier deliberate decision. `ip_hash` existed precisely so
-- that a raw address was never persisted. With this column the `scans` table
-- now contains directly identifying personal data and is in scope for GDPR:
-- you owe the data subject a lawful basis, a retention window, and a privacy
-- notice. The hash is retained alongside it because it is the only field that
-- can still detect repeat scanners once this column is dropped or anonymised.
--
-- The `/privacy` link in the footer still resolves to a 404. Fix that before
-- this ships.
ALTER TABLE scans ADD COLUMN ip TEXT;

-- The raw-scan table on the QR detail page is ordered newest-first and filtered
-- by qr_id; the existing (qr_id, ts) index already serves both.
