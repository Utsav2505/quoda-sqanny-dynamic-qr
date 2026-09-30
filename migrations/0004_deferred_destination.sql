-- Deferred-destination ("set it later") QR codes.
--
-- A code can now be printed before its destination is known. `qr_codes.destination`
-- already permits NULL, so no data-shape change is needed — only the audit trail
-- and the auth round-trip.
--
-- ADDITIVE ONLY: three ADD COLUMPs, no primary-key change, so this cannot break
-- the scan_daily upsert the way a key rebuild does.

-- Who claimed an unconfigured code, and when. Any signed-in account may claim
-- one (Quoda is self-hostable, so for a single-tenant deploy that is the
-- operator's own staff). These columns exist so the original owner can always
-- audit and reclaim; the printed code itself carries no owner credential.
ALTER TABLE qr_codes ADD COLUMN destination_claimed_by TEXT;
ALTER TABLE qr_codes ADD COLUMN destination_claimed_at INTEGER;

-- Carries a return path through the magic-link round trip. A visitor who scans
-- an unconfigured code must be able to sign in and land back on the claim page
-- rather than being dumped on the dashboard. Stored server-side rather than in
-- the URL so it cannot be tampered with between issuing and consuming.
ALTER TABLE magic_links ADD COLUMN next_path TEXT;
