-- User profile + Business (multi-business from day one).
--
-- Design notes:
--  * Businesses are SEPARATE records, never columns on `users`. A user owns
--    many businesses; a business has many QRs.
--  * `businesses.owner_id` is the creating user (always also a member with role
--    'owner'). Access is authorized through `business_members` so a business can
--    later be shared with staff without a schema change. Every read path joins
--    through that table rather than trusting an id from the request.
--  * `users.onboarded_at` already exists (set by the QR onboarding) and is the
--    single source of truth for "onboarding finished". No duplicate flag.
--  * `users.current_business_id` is the active business context. NULL means
--    "All businesses". Kept on the user row so it is one write, not a
--    multi-row invariant.
--  * `qr_codes.user_id` stays the access-control column; `business_id` is the
--    scoping/organisation attribute. Existing rows default to NULL
--    (unscoped) and are not backfilled — guessing an owner would be wrong.

-- ---------------------------------------------------------------- user profile
ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE users ADD COLUMN current_business_id TEXT;

-- ------------------------------------------------------------------ businesses
CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,                 -- controlled key from lib/business.ts
  custom_category TEXT,                   -- required when category = 'other'
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,                           -- normalized, https:// prefixed
  google_business_url TEXT,
  instagram_url TEXT,
  facebook_url TEXT,
  description TEXT,
  logo_key TEXT,                          -- R2 key under logos/
  hours_json TEXT,                        -- {"mon":{"open":"09:00","close":"21:00","closed":false},...}
  status TEXT NOT NULL DEFAULT 'active',  -- active | archived
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_businesses_owner ON businesses(owner_id);
CREATE INDEX idx_businesses_status ON businesses(status);

-- Membership is the authorization gate: a business is visible/editable only
-- through a row here. The owner gets a row at creation time.
CREATE TABLE business_members (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',    -- owner | manager | member
  created_at INTEGER NOT NULL,
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX idx_bm_user ON business_members(user_id);
CREATE INDEX idx_bm_business ON business_members(business_id);

-- QR -> business scope. Nullable so unscoped codes keep working; SQLite only
-- permits a REFERENCES clause on ADD COLUMN when the default is NULL.
ALTER TABLE qr_codes ADD COLUMN business_id TEXT REFERENCES businesses(id);
CREATE INDEX idx_qr_business ON qr_codes(business_id);
