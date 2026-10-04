-- Batch QR generation.
--
-- WHAT THIS IS
-- ------------
-- A batch is a set of physical stands produced together: one type, one batch
-- number, one starting sequence, one size. Generating one means minting a
-- contiguous run of serials of the form
--
--   SQ-{TYPE}-{BATCH}-{SEQUENCE}      e.g. SQ-GR-B01-001 … SQ-GR-B01-018
--
-- -----------------------------------------------------------------------
-- WHY THESE QRs ARE REGISTRY ROWS, NOT A NEW TABLE
-- -----------------------------------------------------------------------
-- A batch QR is a printed stand like any other: it has a permanent serial, an
-- owner, a business, a lifecycle (claimed / active / archived) and a destination
-- that can change without reprinting. `qr_registry` already encodes all of that,
-- and `qr_registry.qr_identifier` is already UNIQUE.
--
-- So a batch does NOT get its own QR table. It gets a row in `qr_batches` plus
-- batch columns on `qr_registry`. That means:
--
--   * serial uniqueness across random AND batch serials is enforced by ONE
--     existing index, with no second mechanism to keep in step;
--   * every batch QR is immediately visible to the existing stand management
--     pages, the archive/restore lifecycle, and the dashboard;
--   * regenerating an asset cannot create a duplicate, because regeneration does
--     not create a row at all.
--
-- Creating a parallel QR model would have duplicated all of that and guaranteed
-- drift.
--
-- -----------------------------------------------------------------------
-- SEQUENCE IS AN INTEGER, AND THAT IS NOT THE THREE-DIGIT PROBLEM
-- -----------------------------------------------------------------------
-- `sequence_start` / `sequence_end` / `batch_sequence` are INTEGERs. The
-- constraint being guarded against here is a THREE-DIGIT limit — a padded
-- fixed-width field that wraps 1000 back to 000. An integer type does not do
-- that: SQLite integers are 64-bit and `1000` is simply 1000.
--
-- Display padding is a RENDERING rule, not a storage rule, and lives in exactly
-- one place (formatSequence in src/lib/batch.ts): at least three digits, never
-- fewer than the value needs. 999 -> "999", 1000 -> "1000". No stored column
-- anywhere holds a padded string that could disagree with the number it came
-- from.
--
-- -----------------------------------------------------------------------
-- ADDITIVE ONLY
-- -----------------------------------------------------------------------
-- One new table plus six new nullable columns. No existing column, key, or
-- constraint is touched, so this cannot break the scan_daily upsert or the claim
-- compare-and-swap the way a key rebuild would.

-- ------------------------------------------------------------------- batches
CREATE TABLE qr_batches (
  id TEXT PRIMARY KEY,
  -- The ONE owner authority, as on qr_registry. Not derived from a client flag.
  owner_id TEXT NOT NULL REFERENCES users(id),
  -- Business scope. NOT NULL, and not a choice made here: qr_registry's
  -- existing CHECK permits an owned row only when owner, business and
  -- configuration are all present, so an "owned but unscoped" batch QR is a
  -- state that table cannot represent. Requiring a business is also consistent
  -- with the existing claim flow, which already makes one mandatory.
  business_id TEXT NOT NULL REFERENCES businesses(id),

  -- -------------------------------------------------------------- identity
  -- Exactly two uppercase letters. A controlled SHAPE, not a controlled list:
  -- the product treats the type as an operational label the user supplies, so
  -- there is deliberately no lookup table here.
  type TEXT NOT NULL,
  -- 1-12 uppercase alphanumerics. No dash, because the token is one dash-
  -- delimited field of the serial and a dash inside it would make two different
  -- configurations able to produce the same string.
  batch_number TEXT NOT NULL,

  -- Contiguous range. See the header note on why these are integers.
  sequence_start INTEGER NOT NULL,
  sequence_end   INTEGER NOT NULL,
  quantity       INTEGER NOT NULL,

  -- Optional user-defined metadata (name/value rows) for THIS batch — printed
  -- on the sheet, in the manifest, nowhere near the QR identity. Kept out of
  -- qr_registry on purpose: identity must not vary with descriptive data.
  metadata_json TEXT NOT NULL DEFAULT '[]',

  -- ------------------------------------------------------------- lifecycle
  -- Two states, not five. Generation is atomic — see the service layer — so
  -- "generating" and "partially failed" are states the database can never be in.
  -- Publishing a state the system cannot maintain is how a UI ends up telling
  -- someone a batch is Ready when it is not.
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'archived')),
  archived_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- A range may not overlap itself within the same type+batch. Two users
  -- creating B01 001-018 and B01 001-018 must not both succeed; this makes the
  -- exact duplicate impossible before the serial UNIQUE index is even consulted.
  -- Overlapping-but-not-identical ranges are still caught by that index, which
  -- is the authority — this constraint is the cheap first line, not the guarantee.
  UNIQUE (type, batch_number, sequence_start)
);

CREATE INDEX idx_batches_owner ON qr_batches(owner_id);
CREATE INDEX idx_batches_status ON qr_batches(status);
CREATE INDEX idx_batches_created ON qr_batches(created_at DESC);

-- ------------------------------------------------- batch link on qr_registry
-- Nullable so every existing row (random stands, studio codes) is untouched.
-- Populated only for serials minted by a batch.
ALTER TABLE qr_registry ADD COLUMN batch_id TEXT REFERENCES qr_batches(id);
ALTER TABLE qr_registry ADD COLUMN batch_sequence INTEGER;
ALTER TABLE qr_registry ADD COLUMN batch_type TEXT;

CREATE INDEX idx_registry_batch ON qr_registry(batch_id, batch_sequence);

-- Partial index for "does any serial in this set already exist". Serves the
-- conflict pre-check without scanning the whole table, and is used only for
-- batch rows so it stays small.
CREATE INDEX idx_registry_identifier_batch ON qr_registry(qr_identifier)
  WHERE batch_id IS NOT NULL;
