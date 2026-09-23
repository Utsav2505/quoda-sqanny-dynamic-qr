import type { QrType } from "../types";

// ---------------------------------------------------------------------------
// Row shapes (plain objects mirroring the D1 schema in migrations/0001_init.sql)
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  email: string;
  plan_id: string;
  role: string;
  onboarded_at: number | null;
  created_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  user_agent: string | null;
  created_at: number;
}

export interface MagicLinkRow {
  token_hash: string;
  email: string;
  expires_at: number;
  consumed_at: number | null;
}

export interface QrRow {
  id: string;
  user_id: string;
  type: QrType;
  title: string;
  is_dynamic: number;
  short_code: string | null;
  destination: string | null;
  content_json: string;
  design_json: string;
  folder_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
}

// Caller-supplied input for creating a QR code. id/timestamps are generated
// here when omitted so callers can stay terse.
export interface CreateQrInput {
  id?: string;
  user_id: string;
  type: QrType;
  title: string;
  is_dynamic?: number | boolean;
  short_code?: string | null;
  destination?: string | null;
  content_json: string;
  design_json: string;
  folder_id?: string | null;
  created_at?: number;
  updated_at?: number;
}

// Patchable QR fields.
export type QrPatch = Partial<
  Pick<
    QrRow,
    | "title"
    | "is_dynamic"
    | "short_code"
    | "destination"
    | "content_json"
    | "design_json"
    | "folder_id"
  >
>;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function createUser(
  db: D1Database,
  email: string,
): Promise<UserRow> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO users (id, email, plan_id, role, onboarded_at, created_at) VALUES (?, ?, 'free', 'user', NULL, ?)",
    )
    .bind(id, email, now)
    .run();
  return { id, email, plan_id: "free", role: "user", onboarded_at: null, created_at: now };
}

export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM users WHERE email = ? LIMIT 1")
    .bind(email)
    .first<UserRow>();
}

export async function getUserById(
  db: D1Database,
  id: string,
): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
    .bind(id)
    .first<UserRow>();
}

export async function setOnboarded(
  db: D1Database,
  id: string,
  ts: number,
): Promise<void> {
  await db
    .prepare("UPDATE users SET onboarded_at = ? WHERE id = ?")
    .bind(ts, id)
    .run();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(
  db: D1Database,
  input: { id: string; userId: string; expiresAt: number; ua?: string | null },
): Promise<SessionRow> {
  const now = Date.now();
  const ua = input.ua ?? null;
  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, expires_at, user_agent, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(input.id, input.userId, input.expiresAt, ua, now)
    .run();
  return {
    id: input.id,
    user_id: input.userId,
    expires_at: input.expiresAt,
    user_agent: ua,
    created_at: now,
  };
}

export async function getSessionRow(
  db: D1Database,
  id: string,
): Promise<SessionRow | null> {
  return db
    .prepare("SELECT * FROM sessions WHERE id = ? LIMIT 1")
    .bind(id)
    .first<SessionRow>();
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

// ---------------------------------------------------------------------------
// Magic links
// ---------------------------------------------------------------------------

export async function createMagicLink(
  db: D1Database,
  input: { tokenHash: string; email: string; expiresAt: number },
): Promise<MagicLinkRow> {
  await db
    .prepare(
      "INSERT INTO magic_links (token_hash, email, expires_at, consumed_at) VALUES (?, ?, ?, NULL)",
    )
    .bind(input.tokenHash, input.email, input.expiresAt)
    .run();
  return {
    token_hash: input.tokenHash,
    email: input.email,
    expires_at: input.expiresAt,
    consumed_at: null,
  };
}

export async function getMagicLink(
  db: D1Database,
  tokenHash: string,
): Promise<MagicLinkRow | null> {
  return db
    .prepare("SELECT * FROM magic_links WHERE token_hash = ? LIMIT 1")
    .bind(tokenHash)
    .first<MagicLinkRow>();
}

/**
 * Atomically consume a magic link. Returns true only if THIS call flipped it
 * from unconsumed to consumed — the conditional UPDATE is the single source of
 * truth, closing the check-then-act race in verifyMagicLink.
 */
export async function consumeMagicLink(
  db: D1Database,
  tokenHash: string,
  ts: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      "UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
    )
    .bind(ts, tokenHash)
    .run();
  return r.meta.changes === 1;
}

// ---------------------------------------------------------------------------
// QR codes
// ---------------------------------------------------------------------------

export async function createQr(
  db: D1Database,
  row: CreateQrInput,
): Promise<QrRow> {
  const id = row.id ?? crypto.randomUUID();
  const now = Date.now();
  const created_at = row.created_at ?? now;
  const updated_at = row.updated_at ?? now;
  const is_dynamic =
    typeof row.is_dynamic === "boolean"
      ? row.is_dynamic
        ? 1
        : 0
      : (row.is_dynamic ?? 0);
  const short_code = row.short_code ?? null;
  const destination = row.destination ?? null;
  const folder_id = row.folder_id ?? null;

  await db
    .prepare(
      `INSERT INTO qr_codes
         (id, user_id, type, title, is_dynamic, short_code, destination, content_json, design_json, folder_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      row.user_id,
      row.type,
      row.title,
      is_dynamic,
      short_code,
      destination,
      row.content_json,
      row.design_json,
      folder_id,
      created_at,
      updated_at,
    )
    .run();

  return {
    id,
    user_id: row.user_id,
    type: row.type,
    title: row.title,
    is_dynamic,
    short_code,
    destination,
    content_json: row.content_json,
    design_json: row.design_json,
    folder_id,
    created_at,
    updated_at,
  };
}

export async function getQrById(
  db: D1Database,
  id: string,
): Promise<QrRow | null> {
  return db
    .prepare("SELECT * FROM qr_codes WHERE id = ? LIMIT 1")
    .bind(id)
    .first<QrRow>();
}

export async function getQrByShortCode(
  db: D1Database,
  code: string,
): Promise<QrRow | null> {
  return db
    .prepare("SELECT * FROM qr_codes WHERE short_code = ? LIMIT 1")
    .bind(code)
    .first<QrRow>();
}

export async function listQrByUser(
  db: D1Database,
  userId: string,
): Promise<QrRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM qr_codes WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<QrRow>();
  return results ?? [];
}

export async function updateQr(
  db: D1Database,
  id: string,
  patch: QrPatch,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  // Always bump updated_at.
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);

  await db
    .prepare(`UPDATE qr_codes SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function deleteQr(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM qr_codes WHERE id = ?").bind(id).run();
}

export async function countDynamicByUser(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM qr_codes WHERE user_id = ? AND is_dynamic = 1",
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createFolder(
  db: D1Database,
  userId: string,
  name: string,
): Promise<FolderRow> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO folders (id, user_id, name, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id, userId, name, now)
    .run();
  return { id, user_id: userId, name, created_at: now };
}

export async function listFolders(
  db: D1Database,
  userId: string,
): Promise<FolderRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM folders WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<FolderRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Dynamic pages (hosted landings for rich QR types, served at /p/:slug)
// ---------------------------------------------------------------------------

export type DynamicPageKind = "menu" | "business" | "social" | "appstore" | "pdf";

export interface DynamicPageRow {
  qr_id: string;
  kind: DynamicPageKind;
  data_json: string;
  asset_keys: string;
}

/** Create or replace the dynamic page for a QR (one page per qr_id). */
export async function upsertDynamicPage(
  db: D1Database,
  input: { qr_id: string; kind: DynamicPageKind; data_json: string; asset_keys?: string },
): Promise<DynamicPageRow> {
  const asset_keys = input.asset_keys ?? "[]";
  await db
    .prepare(
      `INSERT INTO dynamic_pages (qr_id, kind, data_json, asset_keys)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(qr_id) DO UPDATE SET kind = excluded.kind, data_json = excluded.data_json, asset_keys = excluded.asset_keys`,
    )
    .bind(input.qr_id, input.kind, input.data_json, asset_keys)
    .run();
  return { qr_id: input.qr_id, kind: input.kind, data_json: input.data_json, asset_keys };
}

/** Read a dynamic page by its owning QR id. */
export async function getDynamicPageByQrId(
  db: D1Database,
  qrId: string,
): Promise<DynamicPageRow | null> {
  return db
    .prepare("SELECT * FROM dynamic_pages WHERE qr_id = ? LIMIT 1")
    .bind(qrId)
    .first<DynamicPageRow>();
}

/**
 * Read a dynamic page by public slug. The slug is the QR's short_code; join
 * back to the owning QR so the page and its QR stay in sync.
 */
export async function getDynamicPageBySlug(
  db: D1Database,
  slug: string,
): Promise<{ page: DynamicPageRow; qr: QrRow } | null> {
  const qr = await getQrByShortCode(db, slug);
  if (!qr) return null;
  const page = await getDynamicPageByQrId(db, qr.id);
  if (!page) return null;
  return { page, qr };
}

// ---------------------------------------------------------------------------
// Product QR Management System
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SKU types and queries
// ---------------------------------------------------------------------------

export interface SkuRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export interface CreateSkuInput {
  id?: string;
  code: string;
  name: string;
  description?: string | null;
  created_at?: number;
  updated_at?: number;
}

export type SkuPatch = Partial<Pick<SkuRow, "name" | "description" | "is_active">>;

export async function createSku(
  db: D1Database,
  input: CreateSkuInput,
): Promise<SkuRow> {
  const id = input.id ?? crypto.randomUUID();
  const now = Date.now();
  const created_at = input.created_at ?? now;
  const updated_at = input.updated_at ?? now;
  await db
    .prepare(
      `INSERT INTO skus (id, code, name, description, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, input.code, input.name, input.description ?? null, created_at, updated_at)
    .run();
  return {
    id,
    code: input.code,
    name: input.name,
    description: input.description ?? null,
    is_active: 1,
    created_at,
    updated_at,
  };
}

export async function getSkuById(
  db: D1Database,
  id: string,
): Promise<SkuRow | null> {
  return db
    .prepare("SELECT * FROM skus WHERE id = ? LIMIT 1")
    .bind(id)
    .first<SkuRow>();
}

export async function getSkuByCode(
  db: D1Database,
  code: string,
): Promise<SkuRow | null> {
  return db
    .prepare("SELECT * FROM skus WHERE code = ? LIMIT 1")
    .bind(code)
    .first<SkuRow>();
}

export async function listSkus(
  db: D1Database,
): Promise<SkuRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM skus ORDER BY created_at DESC")
    .all<SkuRow>();
  return results ?? [];
}

export async function listActiveSkus(
  db: D1Database,
): Promise<SkuRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM skus WHERE is_active = 1 ORDER BY code ASC")
    .all<SkuRow>();
  return results ?? [];
}

export async function updateSku(
  db: D1Database,
  id: string,
  patch: SkuPatch,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  await db
    .prepare(`UPDATE skus SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function deactivateSku(
  db: D1Database,
  id: string,
): Promise<void> {
  await db
    .prepare("UPDATE skus SET is_active = 0, updated_at = ? WHERE id = ?")
    .bind(Date.now(), id)
    .run();
}

// ---------------------------------------------------------------------------
// Batch types and queries
// ---------------------------------------------------------------------------

export type BatchStatus = "pending" | "generating" | "completed" | "failed";

export interface BatchRow {
  id: string;
  batch_number: string;
  sku_id: string;
  quantity: number;
  generated_count: number;
  status: BatchStatus;
  created_at: number;
  updated_at: number;
}

export interface CreateBatchInput {
  id?: string;
  batch_number: string;
  sku_id: string;
  quantity: number;
  generated_count?: number;
  status?: BatchStatus;
  created_at?: number;
  updated_at?: number;
}

export async function createBatch(
  db: D1Database,
  input: CreateBatchInput,
): Promise<BatchRow> {
  const id = input.id ?? crypto.randomUUID();
  const now = Date.now();
  const created_at = input.created_at ?? now;
  const updated_at = input.updated_at ?? now;
  const status = input.status ?? "pending";
  const generated_count = input.generated_count ?? 0;
  await db
    .prepare(
      `INSERT INTO batches (id, batch_number, sku_id, quantity, generated_count, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.batch_number, input.sku_id, input.quantity, generated_count, status, created_at, updated_at)
    .run();
  return {
    id,
    batch_number: input.batch_number,
    sku_id: input.sku_id,
    quantity: input.quantity,
    generated_count,
    status,
    created_at,
    updated_at,
  };
}

export async function getBatchById(
  db: D1Database,
  id: string,
): Promise<BatchRow | null> {
  return db
    .prepare("SELECT * FROM batches WHERE id = ? LIMIT 1")
    .bind(id)
    .first<BatchRow>();
}

export async function getBatchByNumber(
  db: D1Database,
  batchNumber: string,
): Promise<BatchRow | null> {
  return db
    .prepare("SELECT * FROM batches WHERE batch_number = ? LIMIT 1")
    .bind(batchNumber)
    .first<BatchRow>();
}

export async function listBatches(
  db: D1Database,
  limit = 25,
  offset = 0,
): Promise<BatchRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM batches ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all<BatchRow>();
  return results ?? [];
}

export async function updateBatchStatus(
  db: D1Database,
  id: string,
  status: BatchStatus,
  generatedCount?: number,
): Promise<void> {
  if (generatedCount !== undefined) {
    await db
      .prepare("UPDATE batches SET status = ?, generated_count = ?, updated_at = ? WHERE id = ?")
      .bind(status, generatedCount, Date.now(), id)
      .run();
  } else {
    await db
      .prepare("UPDATE batches SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, Date.now(), id)
      .run();
  }
}

export async function incrementBatchGeneratedCount(
  db: D1Database,
  id: string,
): Promise<number> {
  const result = await db
    .prepare("UPDATE batches SET generated_count = generated_count + 1, updated_at = ? WHERE id = ? RETURNING generated_count")
    .bind(Date.now(), id)
    .first<{ generated_count: number }>();
  return result?.generated_count ?? 0;
}

// ---------------------------------------------------------------------------
// Product QR types and queries
// ---------------------------------------------------------------------------

export type ProductQrStatus = "available" | "claimed" | "active" | "disabled" | "retired";

export interface ProductQrRow {
  id: string;
  serial_number: string;
  short_code: string;
  sku_id: string;
  batch_id: string;
  status: ProductQrStatus;
  customer_id: string | null;
  destination: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  activated_at: number | null;
}

export interface CreateProductQrInput {
  id?: string;
  serial_number: string;
  short_code: string;
  sku_id: string;
  batch_id: string;
  status?: ProductQrStatus;
  customer_id?: string | null;
  destination?: string | null;
  title?: string | null;
  created_at?: number;
  updated_at?: number;
  claimed_at?: number | null;
  activated_at?: number | null;
}

export async function createProductQr(
  db: D1Database,
  input: CreateProductQrInput,
): Promise<ProductQrRow> {
  const id = input.id ?? crypto.randomUUID();
  const now = Date.now();
  const created_at = input.created_at ?? now;
  const updated_at = input.updated_at ?? now;
  const status = input.status ?? "available";
  await db
    .prepare(
      `INSERT INTO product_qr (id, serial_number, short_code, sku_id, batch_id, status, customer_id, destination, title, created_at, updated_at, claimed_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.serial_number,
      input.short_code,
      input.sku_id,
      input.batch_id,
      status,
      input.customer_id ?? null,
      input.destination ?? null,
      input.title ?? null,
      created_at,
      updated_at,
      input.claimed_at ?? null,
      input.activated_at ?? null,
    )
    .run();
  return {
    id,
    serial_number: input.serial_number,
    short_code: input.short_code,
    sku_id: input.sku_id,
    batch_id: input.batch_id,
    status,
    customer_id: input.customer_id ?? null,
    destination: input.destination ?? null,
    title: input.title ?? null,
    created_at,
    updated_at,
    claimed_at: input.claimed_at ?? null,
    activated_at: input.activated_at ?? null,
  };
}

export async function getProductQrById(
  db: D1Database,
  id: string,
): Promise<ProductQrRow | null> {
  return db
    .prepare("SELECT * FROM product_qr WHERE id = ? LIMIT 1")
    .bind(id)
    .first<ProductQrRow>();
}

export async function getProductQrBySerial(
  db: D1Database,
  serialNumber: string,
): Promise<ProductQrRow | null> {
  return db
    .prepare("SELECT * FROM product_qr WHERE serial_number = ? LIMIT 1")
    .bind(serialNumber)
    .first<ProductQrRow>();
}

export async function getProductQrByShortCode(
  db: D1Database,
  shortCode: string,
): Promise<ProductQrRow | null> {
  return db
    .prepare("SELECT * FROM product_qr WHERE short_code = ? LIMIT 1")
    .bind(shortCode)
    .first<ProductQrRow>();
}

export async function listProductQrByBatch(
  db: D1Database,
  batchId: string,
  limit = 25,
  offset = 0,
): Promise<ProductQrRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM product_qr WHERE batch_id = ? ORDER BY serial_number ASC LIMIT ? OFFSET ?")
    .bind(batchId, limit, offset)
    .all<ProductQrRow>();
  return results ?? [];
}

export async function listProductQrByCustomer(
  db: D1Database,
  customerId: string,
): Promise<ProductQrRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM product_qr WHERE customer_id = ? ORDER BY claimed_at DESC")
    .bind(customerId)
    .all<ProductQrRow>();
  return results ?? [];
}

export async function claimProductQr(
  db: D1Database,
  shortCode: string,
  customerId: string,
): Promise<ProductQrRow | null> {
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE product_qr
       SET status = 'claimed', customer_id = ?, claimed_at = ?, updated_at = ?
       WHERE short_code = ? AND status = 'available'
       RETURNING *`,
    )
    .bind(customerId, now, now, shortCode)
    .first<ProductQrRow>();
  return result ?? null;
}

export async function activateProductQr(
  db: D1Database,
  id: string,
  customerId: string,
  destination: string,
): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE product_qr
       SET status = 'active', destination = ?, activated_at = ?, updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = 'claimed'`,
    )
    .bind(destination, now, now, id, customerId)
    .run();
  return result.meta.changes === 1;
}

export async function updateProductQrStatus(
  db: D1Database,
  id: string,
  status: ProductQrStatus,
): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare("UPDATE product_qr SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, now, id)
    .run();
  return result.meta.changes === 1;
}

export async function updateProductQrDestination(
  db: D1Database,
  id: string,
  customerId: string,
  destination: string,
): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE product_qr
       SET destination = ?, updated_at = ?
       WHERE id = ? AND customer_id = ? AND status IN ('claimed', 'active')`,
    )
    .bind(destination, now, id, customerId)
    .run();
  return result.meta.changes === 1;
}

export async function countProductQrByStatus(
  db: D1Database,
): Promise<Record<ProductQrStatus, number>> {
  const { results } = await db
    .prepare("SELECT status, COUNT(*) as count FROM product_qr GROUP BY status")
    .all<{ status: ProductQrStatus; count: number }>();
  const counts: Record<ProductQrStatus, number> = {
    available: 0,
    claimed: 0,
    active: 0,
    disabled: 0,
    retired: 0,
  };
  for (const row of results ?? []) {
    counts[row.status] = row.count;
  }
  return counts;
}

export async function countCustomers(
  db: D1Database,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(DISTINCT customer_id) as count FROM product_qr WHERE customer_id IS NOT NULL")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Audit log types and queries
// ---------------------------------------------------------------------------

export interface AuditLogRow {
  id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details_json: string | null;
  ip_address: string | null;
  created_at: number;
}

export interface CreateAuditLogInput {
  id?: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details_json?: string | null;
  ip_address?: string | null;
  created_at?: number;
}

export async function createAuditLog(
  db: D1Database,
  input: CreateAuditLogInput,
): Promise<AuditLogRow> {
  const id = input.id ?? crypto.randomUUID();
  const now = Date.now();
  const created_at = input.created_at ?? now;
  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, details_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.actor_id, input.action, input.entity_type, input.entity_id, input.details_json ?? null, input.ip_address ?? null, created_at)
    .run();
  return {
    id,
    actor_id: input.actor_id,
    action: input.action,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    details_json: input.details_json ?? null,
    ip_address: input.ip_address ?? null,
    created_at,
  };
}

export async function listAuditLogs(
  db: D1Database,
  limit = 25,
  offset = 0,
): Promise<AuditLogRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all<AuditLogRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Short code lookup types and queries
// ---------------------------------------------------------------------------

export interface ShortCodeLookupRow {
  short_code: string;
  source: string;
  source_id: string;
  created_at: number;
}

export async function createShortCodeLookup(
  db: D1Database,
  input: { short_code: string; source: string; source_id: string; created_at?: number },
): Promise<ShortCodeLookupRow> {
  const created_at = input.created_at ?? Date.now();
  await db
    .prepare(
      "INSERT INTO short_code_lookup (short_code, source, source_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(input.short_code, input.source, input.source_id, created_at)
    .run();
  return { short_code: input.short_code, source: input.source, source_id: input.source_id, created_at };
}

export async function lookupShortCode(
  db: D1Database,
  shortCode: string,
): Promise<ShortCodeLookupRow | null> {
  return db
    .prepare("SELECT * FROM short_code_lookup WHERE short_code = ? LIMIT 1")
    .bind(shortCode)
    .first<ShortCodeLookupRow>();
}

export async function deleteShortCodeLookup(
  db: D1Database,
  shortCode: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM short_code_lookup WHERE short_code = ?")
    .bind(shortCode)
    .run();
}
