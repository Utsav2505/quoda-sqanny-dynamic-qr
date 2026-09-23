-- Product QR Management System (D1 / SQLite)

-- Add role column to users table
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

-- Product type definitions
CREATE TABLE skus (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_skus_code ON skus(code);

-- Generation batch records
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  batch_number TEXT UNIQUE NOT NULL,
  sku_id TEXT NOT NULL REFERENCES skus(id),
  quantity INTEGER NOT NULL,
  generated_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_batches_sku ON batches(sku_id);
CREATE INDEX idx_batches_number ON batches(batch_number);

-- Product QR code records
CREATE TABLE product_qr (
  id TEXT PRIMARY KEY,
  serial_number TEXT UNIQUE NOT NULL,
  short_code TEXT UNIQUE NOT NULL,
  sku_id TEXT NOT NULL REFERENCES skus(id),
  batch_id TEXT NOT NULL REFERENCES batches(id),
  status TEXT NOT NULL DEFAULT 'available',
  customer_id TEXT REFERENCES users(id),
  destination TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  activated_at INTEGER
);
CREATE INDEX idx_product_qr_serial ON product_qr(serial_number);
CREATE INDEX idx_product_qr_short ON product_qr(short_code);
CREATE INDEX idx_product_qr_sku ON product_qr(sku_id);
CREATE INDEX idx_product_qr_batch ON product_qr(batch_id);
CREATE INDEX idx_product_qr_customer ON product_qr(customer_id);
CREATE INDEX idx_product_qr_status ON product_qr(status);

-- Audit trail for admin and customer actions
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT,
  ip_address TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

-- Global short code lookup for O(1) redirect performance
CREATE TABLE short_code_lookup (
  short_code TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
