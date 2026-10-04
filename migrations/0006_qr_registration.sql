-- Physical Sqanny QR registration and ownership.
--
-- THE PROBLEM THIS SOLVES
-- -----------------------
-- A Sqanny Stand is printed and shipped BEFORE anyone knows who will own it or
-- where it will point. It therefore needs a permanent identity that exists
-- with no owner, and that identity must survive every later change to its
-- destination. `qr_codes` cannot hold that row: `qr_codes.user_id` is NOT NULL
-- and the table also backs the `scans`/`scan_daily`/`dynamic_pages` foreign
-- keys, so making ownership nullable means rebuilding a live table with three
-- dependants. That is a high-risk change for a modelling problem.
--
-- So this adds a serial-number LEDGER for the physical asset, and leaves
-- `qr_codes` as what it already is: the redirect configuration.
--
--   qr_registry  = the printed asset. Identity, owner, business, lifecycle.
--   qr_codes     = its configuration: name, category, placement, destination.
--
-- This is a split, not a duplicate. Ownership and business live in exactly one
-- place (`qr_registry`); the destination lives in exactly one place
-- (`qr_codes.destination`, which `/r/:code` already reads). A second copy of
-- either would be a bug waiting to happen. The two are joined 1:1 by
-- `qr_registry.qr_code_id` and are only ever written in the same transaction.
--
-- WHY NO `claiming` RESERVATION STATE
-- ----------------------------------
-- The claim is a single conditional UPDATE guarded on `status = 'unclaimed'`
-- plus a UNIQUE constraint on the identifier, so two simultaneous claims can
-- never both win (see db/queries.ts claimQrAsset). A reservation would add a
-- third write to undo, and a stale reservation would need a reaper job to
-- recover. The compare-and-swap is both simpler and strictly more correct, so
-- `claiming` is deliberately absent rather than present-but-unused.
--
-- ADDITIVE ONLY: one new table, no change to any existing column or key.

-- ------------------------------------------------------------------ registry
CREATE TABLE qr_registry (
  id TEXT PRIMARY KEY,                 -- internal; never printed or exposed
  qr_identifier TEXT NOT NULL UNIQUE,  -- public serial, e.g. 'SQ-8F2K9A'
  -- Lifecycle. CHECKed so an unknown state is a write error, not a silent
  -- 'unknown' that every read path then has to guess about.
  status TEXT NOT NULL DEFAULT 'unclaimed'
    CHECK (status IN ('unclaimed', 'claimed', 'active', 'archived')),
  -- The ONE owner authority. NULL only while status = 'unclaimed'.
  owner_id TEXT REFERENCES users(id),
  -- The ONE current business association. NULL until claimed.
  business_id TEXT REFERENCES businesses(id),
  -- Linked configuration row. NULL until claimed; UNIQUE so a configuration
  -- can never be shared by two physical assets.
  qr_code_id TEXT UNIQUE REFERENCES qr_codes(id),
  claimed_at INTEGER,
  archived_at INTEGER,
  -- Bumped whenever the destination is (re)configured, so the detail page can
  -- tell a freshly-registered code from a long-settled one.
  last_configured_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Ownership and business are meaningless without each other: a half-claimed
  -- asset (owner set, business null) would be a state no code path should be
  -- able to produce, so the database refuses to store one.
  CHECK (
    (status = 'unclaimed' AND owner_id IS NULL AND business_id IS NULL
      AND claimed_at IS NULL AND qr_code_id IS NULL)
    OR
    (status IN ('claimed', 'active', 'archived') AND owner_id IS NOT NULL
      AND business_id IS NOT NULL AND claimed_at IS NOT NULL
      AND qr_code_id IS NOT NULL)
  ),
  -- An archived asset keeps its owner and business: archiving must not release
  -- the claim. Reassignment is an explicit support action, not a side effect.
  CHECK (status = 'archived' OR archived_at IS NULL)
);

CREATE INDEX idx_registry_owner ON qr_registry(owner_id);
CREATE INDEX idx_registry_business ON qr_registry(business_id);
CREATE INDEX idx_registry_status ON qr_registry(status);

-- ------------------------------------------------- configuration on qr_codes
-- Additive columns. All nullable so every existing studio-created code keeps
-- working untouched: a code with no `qr_registry` row simply has no claim
-- metadata, which is exactly the state it is in today.
--
-- `category` is a controlled key from lib/qr-registration.ts, not the legacy
-- `type` column: `type` describes what the code RENDERS (url/text/wifi), while
-- `category` describes what the customer is meant to DO (reviews/menu/contact).
-- Overloading one column for both is what made the old flow feel informal.
ALTER TABLE qr_codes ADD COLUMN category TEXT;
-- Free text that qualifies a `custom` category, so 'Wayfinding' stays
-- distinguishable from every other custom QR. Mirrors the businesses rule: a
-- non-custom key discards the submitted text rather than storing it.
ALTER TABLE qr_codes ADD COLUMN custom_category TEXT;
-- Physical placement, e.g. 'Counter', 'Table 04'. Free text on purpose: the
-- useful values are site-specific and no enumeration would fit.
ALTER TABLE qr_codes ADD COLUMN placement TEXT;
ALTER TABLE qr_codes ADD COLUMN claimed_at INTEGER;
ALTER TABLE qr_codes ADD COLUMN archived_at INTEGER;
-- Reserved for the QR management list: a physical asset should sort ahead of
-- studio codes and group with its siblings.
ALTER TABLE qr_codes ADD COLUMN source TEXT NOT NULL DEFAULT 'studio';
CREATE INDEX idx_qr_category ON qr_codes(category);
CREATE INDEX idx_qr_source ON qr_codes(source);

-- A user's physical assets, ready for the /qrs list without a join back to the
-- registry for the ownership filter.
CREATE INDEX idx_qr_registry_owner_code ON qr_registry(owner_id, qr_code_id);
