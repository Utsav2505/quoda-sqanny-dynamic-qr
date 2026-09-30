import type { QrType } from "../types";

// ---------------------------------------------------------------------------
// Row shapes (plain objects mirroring the D1 schema in migrations/0001_init.sql)
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  email: string;
  plan_id: string;
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
  /** Return path applied after a successful sign-in, if one was captured. */
  next_path: string | null;
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
  /** Who set a deferred destination, and when. Null for codes created with one. */
  destination_claimed_by: string | null;
  destination_claimed_at: number | null;
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
      "INSERT INTO users (id, email, plan_id, onboarded_at, created_at) VALUES (?, ?, 'free', NULL, ?)",
    )
    .bind(id, email, now)
    .run();
  return { id, email, plan_id: "free", onboarded_at: null, created_at: now };
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
  input: { tokenHash: string; email: string; expiresAt: number; nextPath?: string | null },
): Promise<MagicLinkRow> {
  await db
    .prepare(
      "INSERT INTO magic_links (token_hash, email, expires_at, consumed_at, next_path) VALUES (?, ?, ?, NULL, ?)",
    )
    .bind(input.tokenHash, input.email, input.expiresAt, input.nextPath ?? null)
    .run();
  return {
    token_hash: input.tokenHash,
    email: input.email,
    expires_at: input.expiresAt,
    consumed_at: null,
    next_path: input.nextPath ?? null,
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
    // A freshly created code has not been claimed by anyone.
    destination_claimed_by: null,
    destination_claimed_at: null,
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

export type ClaimResult = "claimed" | "already-set" | "not-found";

/**
 * Set a deferred destination on a code identified by its short code.
 *
 * The `destination IS NULL` predicate inside the UPDATE is the concurrency
 * control, not a pre-flight SELECT. Two visitors can open the claim page at the
 * same instant; only one UPDATE can flip the row, and the loser is told the code
 * is already set. Checking first and writing second would let both win.
 */
export async function claimDestination(
  db: D1Database,
  shortCode: string,
  destination: string,
  userId: string,
): Promise<ClaimResult> {
  const now = Date.now();
  const res = await db
    .prepare(
      `UPDATE qr_codes
          SET destination = ?, destination_claimed_by = ?, destination_claimed_at = ?, updated_at = ?
        WHERE short_code = ? AND destination IS NULL AND is_dynamic = 1`,
    )
    .bind(destination, userId, now, now, shortCode)
    .run();

  if (res.meta.changes > 0) return "claimed";

  // Distinguish "someone beat you to it" from "no such code", so the page can
  // say something useful instead of a bare error.
  const row = await db
    .prepare("SELECT destination FROM qr_codes WHERE short_code = ?")
    .bind(shortCode)
    .first<{ destination: string | null }>();
  if (!row) return "not-found";
  return "already-set";
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
