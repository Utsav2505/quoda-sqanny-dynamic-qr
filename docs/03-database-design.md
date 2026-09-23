# 03 — Database Design

## Migration Strategy

- Existing tables remain unchanged
- New tables added via `0002_product_qr.sql` migration
- `users` table gets one new column: `role`
- All new tables use TEXT primary keys (UUIDs) consistent with existing schema
- Timestamps use INTEGER (Unix ms) consistent with existing schema

## Schema Changes

### Alter Existing Table

```sql
-- Add role column to users table
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
-- Values: 'user' (existing), 'admin'
```

### New Tables

#### `skus` — Product type definitions

```sql
CREATE TABLE skus (
  id TEXT PRIMARY KEY,                          -- UUID
  code TEXT UNIQUE NOT NULL,                    -- e.g., 'RT-01' (human-readable)
  name TEXT NOT NULL,                           -- e.g., 'Google Review Stand'
  description TEXT,                             -- optional description
  is_active INTEGER NOT NULL DEFAULT 1,         -- soft delete: 0 = inactive
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_skus_code ON skus(code);
```

**Notes:**
- `code` is unique and human-readable (e.g., `RT-01`, `PROD-V2`)
- `is_active` for soft delete — never hard-delete SKUs that have batches

#### `batches` — Generation batch records

```sql
CREATE TABLE batches (
  id TEXT PRIMARY KEY,                          -- UUID
  batch_number TEXT UNIQUE NOT NULL,            -- e.g., 'B-20260922-001'
  sku_id TEXT NOT NULL REFERENCES skus(id),
  quantity INTEGER NOT NULL,                    -- total QR codes in batch
  generated_count INTEGER NOT NULL DEFAULT 0,   -- how many generated so far
  status TEXT NOT NULL DEFAULT 'pending',       -- pending|generating|completed|failed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_batches_sku ON batches(sku_id);
CREATE INDEX idx_batches_number ON batches(batch_number);
```

**Batch number format:** `B-YYYYMMDD-NNN` (date + daily sequence number)
- Generated server-side: `B-${YYYYMMDD}-${sequence}`
- Sequence resets daily (tracked in a KV counter or derived from D1)

#### `product_qr` — Product QR code records

```sql
CREATE TABLE product_qr (
  id TEXT PRIMARY KEY,                          -- UUID
  serial_number TEXT UNIQUE NOT NULL,           -- e.g., 'SQ-000001' (internal identifier)
  short_code TEXT UNIQUE NOT NULL,              -- e.g., 'A7kP92x' (immutable, for /r/:code)
  sku_id TEXT NOT NULL REFERENCES skus(id),
  batch_id TEXT NOT NULL REFERENCES batches(id),
  status TEXT NOT NULL DEFAULT 'available',     -- available|claimed|active|disabled|retired
  customer_id TEXT REFERENCES users(id),        -- NULL until claimed
  destination TEXT,                             -- NULL until configured
  title TEXT,                                   -- optional user-given title
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,                           -- when customer claimed
  activated_at INTEGER                          -- when destination set
);
CREATE INDEX idx_product_qr_serial ON product_qr(serial_number);
CREATE INDEX idx_product_qr_short ON product_qr(short_code);
CREATE INDEX idx_product_qr_sku ON product_qr(sku_id);
CREATE INDEX idx_product_qr_batch ON product_qr(batch_id);
CREATE INDEX idx_product_qr_customer ON product_qr(customer_id);
CREATE INDEX idx_product_qr_status ON product_qr(status);
```

**Serial number format:** `SQ-NNNNNN` (6-digit zero-padded)
- Generated server-side sequentially within a batch
- Internal identifier — does NOT appear on physical product label

**Short code:** Reuses existing `src/lib/shortcode.ts` (base62, 7 chars)
- Immutable once generated
- Maps to `/r/:code` redirect endpoint

#### `audit_log` — Admin and customer action audit trail

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,                          -- UUID
  actor_id TEXT NOT NULL REFERENCES users(id),  -- who performed the action
  action TEXT NOT NULL,                         -- e.g., 'sku.create', 'batch.generate', 'qr.claim'
  entity_type TEXT NOT NULL,                    -- 'sku', 'batch', 'product_qr', 'customer'
  entity_id TEXT NOT NULL,                      -- ID of affected entity
  details_json TEXT,                            -- optional JSON with additional context
  ip_address TEXT,                              -- request IP
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
```

**Action naming convention:** `{entity}.{action}`
- `sku.create`, `sku.update`, `sku.deactivate`
- `batch.create`, `batch.generate`, `batch.complete`
- `qr.generate`, `qr.claim`, `qr.activate`, `qr.disable`, `qr.retire`
- `customer.register`, `customer.update_profile`

## Entity Relationships

```
users (1) ──── (N) product_qr     [customer_id]
users (1) ──── (N) audit_log      [actor_id]
skus  (1) ──── (N) batches        [sku_id]
skus  (1) ──── (N) product_qr     [sku_id]
batches (1) ── (N) product_qr     [batch_id]
```

## Existing Tables (unchanged)

| Table | Status | Notes |
|-------|--------|-------|
| `plans` | Unchanged | No product-QR-specific plans needed yet |
| `users` | +1 column | `role TEXT NOT NULL DEFAULT 'user'` |
| `sessions` | Unchanged | Reused for admin + customer auth |
| `magic_links` | Unchanged | Reused for admin + customer auth |
| `folders` | Unchanged | Generic QR folders remain |
| `qr_codes` | Unchanged | Existing generic QR system untouched |
| `dynamic_pages` | Unchanged | Existing landing pages untouched |
| `scans` | Unchanged | Existing scan log untouched |
| `scan_daily` | Unchanged | Existing daily aggregates untouched |

**Key decision:** Product QR codes live in `product_qr`, NOT in `qr_codes`. The existing `qr_codes` table serves the generic QR system. The two systems share the redirect endpoint (`/r/:code`) but have separate data models.

**Why separate tables?**
1. `qr_codes` has `user_id` (creator), `type`, `content_json`, `design_json` — product QR doesn't need these
2. `product_qr` has `serial_number`, `batch_id`, `status`, `customer_id` — generic QR doesn't need these
3. Separate tables avoid polluting either system with unnecessary columns
4. Clean separation allows independent evolution

## Short Code Sharing

Both `qr_codes.short_code` and `product_qr.short_code` must be globally unique. The redirect endpoint (`/r/:code`) queries both tables:

```sql
-- In redirect handler, try product_qr first, then qr_codes
SELECT id, destination, status FROM product_qr WHERE short_code = ?
UNION ALL
SELECT id, destination, 'active' as status FROM qr_codes WHERE short_code = ?
```

**Alternative (simpler):** Use a shared `short_codes` lookup table that maps `short_code → (table, id)`. This avoids the UNION and makes lookups O(1).

**Recommended:** Add a `short_code_lookup` table:

```sql
CREATE TABLE short_code_lookup (
  short_code TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- 'qr_codes' or 'product_qr'
  source_id TEXT NOT NULL,        -- ID in the source table
  created_at INTEGER NOT NULL
);
```

This adds one write during QR creation but makes the hot redirect path a single indexed lookup.

## Sequence Number Generation

### Batch Number: `B-YYYYMMDD-NNN`
- Date component: current UTC date
- Sequence: incrementing counter per day
- Implementation: KV key `batch:seq:{YYYYMMDD}`, increment on each batch creation
- Fallback: query D1 for max sequence on that date

### Serial Number: `SQ-NNNNNN`
- Global sequential counter
- Implementation: KV key `serial:seq`, increment on each QR creation
- Alternative: per-batch sequential (SQ-000001 to SQ-000500 within batch B-20260922-001)
- **Decision:** Global sequential (simpler, no collision risk across batches)

## Query Patterns

### Admin: List QR codes with search/filter/sort
```sql
SELECT pq.*, s.code as sku_code, s.name as sku_name, b.batch_number, u.email as customer_email
FROM product_qr pq
JOIN skus s ON pq.sku_id = s.id
JOIN batches b ON pq.batch_id = b.id
LEFT JOIN users u ON pq.customer_id = u.id
WHERE (? IS NULL OR pq.serial_number LIKE ?)       -- search
  AND (? IS NULL OR pq.sku_id = ?)                 -- filter by SKU
  AND (? IS NULL OR pq.batch_id = ?)               -- filter by batch
  AND (? IS NULL OR pq.status = ?)                 -- filter by status
ORDER BY pq.created_at DESC                        -- sort
LIMIT ? OFFSET ?                                   -- pagination
```

### Admin: Dashboard stats
```sql
-- Total QR codes
SELECT COUNT(*) FROM product_qr;

-- By status
SELECT status, COUNT(*) FROM product_qr GROUP BY status;

-- Recent batches
SELECT * FROM batches ORDER BY created_at DESC LIMIT 10;

-- Total customers (users who have claimed at least one QR)
SELECT COUNT(DISTINCT customer_id) FROM product_qr WHERE customer_id IS NOT NULL;
```

### Customer: List my stands
```sql
SELECT pq.*, s.code as sku_code, s.name as sku_name
FROM product_qr pq
JOIN skus s ON pq.sku_id = s.id
WHERE pq.customer_id = ?
ORDER BY pq.claimed_at DESC;
```

### Redirect: Lookup by short code
```sql
-- Try product_qr first
SELECT id, destination, status, customer_id
FROM product_qr
WHERE short_code = ?
LIMIT 1;
```
