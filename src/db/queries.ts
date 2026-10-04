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
  /** profile fields (migrations/0005) — null until the user fills them in */
  name: string | null;
  phone: string | null;
  /** R2 object key under avatars/; render via assetUrl() */
  avatar_key: string | null;
  /** active business scope, or null for "All businesses" */
  current_business_id: string | null;
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
  /** business this code is scoped to; null = not assigned to a business */
  business_id: string | null;
  created_at: number;
  updated_at: number;
  /** Who set a deferred destination, and when. Null for codes created with one. */
  destination_claimed_by: string | null;
  destination_claimed_at: number | null;
  /**
   * Where this row came from: 'studio' for a code created in the designer,
   * 'registration' for the configuration of a physical Sqanny Stand.
   *
   * Load-bearing, not a label. A 'registration' row is the configuration half
   * of a `qr_registry` asset: its owner and business live in the registry, and
   * writes to it have to go through the registry service so the two tables
   * cannot drift. Read it before accepting any write to this row.
   */
  source: QrSource;
}

/**
 * Provenance of a `qr_codes` row. See QrRow.source — the discriminator between a
 * free-standing studio code and the configuration half of a physical stand.
 */
export type QrSource = "studio" | "registration";

/**
 * A QR as it appears in a LIST, with the physical stand it belongs to resolved.
 *
 * `registry_id` is the join key for a `source = 'registration'` row and is what
 * makes a stand routable to its own management screen (`/qrs/:registryId`)
 * instead of the studio (`/app/:qrId`). Without it every list has to guess which
 * of two editors a code belongs to, and a stand ends up with two editors and no
 * way to tell which is authoritative.
 */
export interface QrListRow extends QrRow {
  registry_id: string | null;
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
  business_id?: string | null;
  /** provenance; defaults to 'studio'. Only the claim service sets this. */
  source?: QrSource;
  created_at?: number;
  updated_at?: number;
}

// Patchable QR fields.
//
// Split in two on purpose. `short_code` is the PRINTED IDENTITY: a code that can
// be rewritten is a code whose label silently stops resolving to the same thing,
// so it is never part of a generic patch. `business_id` IS patchable, but only
// after the caller has verified membership (see assignQrToBusiness and
// routes/api/qr.ts) — otherwise a code could be filed under another tenant.
export type QrPatchKey =
  | "title"
  | "is_dynamic"
  | "short_code"
  | "destination"
  | "content_json"
  | "design_json"
  | "folder_id"
  | "business_id";

export type QrPatch = Partial<Pick<QrRow, QrPatchKey>>;

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
  return {
    id,
    email,
    plan_id: "free",
    onboarded_at: null,
    created_at: now,
    name: null,
    phone: null,
    avatar_key: null,
    current_business_id: null,
  };
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

/** Profile fields a user may change about themselves. */
export interface UserProfilePatch {
  name?: string | null;
  phone?: string | null;
  avatar_key?: string | null;
}

/**
 * Update the signed-in user's own profile.
 *
 * The `id` in the WHERE clause is the *authenticated* id, never a submitted
 * one — this is the authorization boundary for profile writes. A tampered
 * request body cannot redirect the UPDATE at another account: it simply
 * matches zero rows.
 */
export async function updateUserProfile(
  db: D1Database,
  userId: string,
  patch: UserProfilePatch,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const key of ["name", "phone", "avatar_key"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (!fields.length) return;
  values.push(userId);
  await db
    .prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

/**
 * Set the active business context. Passing null means "All businesses".
 *
 * The membership and status checks are IN the UPDATE rather than left to the
 * caller. `current_business_id` is read on nearly every authenticated page to
 * decide what to show, so a stale or forged value is not a cosmetic problem: it
 * silently narrows the dashboard to another tenant's business name and QR
 * counts. Scoping to an archived business is refused too, for the same reason —
 * it is no longer a context to work in.
 *
 * Returns whether a scope was actually set, so a caller can tell "switched" from
 * "refused" and say so.
 */
export async function setCurrentBusiness(
  db: D1Database,
  userId: string,
  businessId: string | null,
): Promise<boolean> {
  if (businessId === null) {
    await db
      .prepare("UPDATE users SET current_business_id = NULL WHERE id = ?")
      .bind(userId)
      .run();
    return true;
  }
  const res = await db
    .prepare(
      `UPDATE users SET current_business_id = ?
        WHERE id = ?
          AND EXISTS (SELECT 1 FROM businesses b
                        JOIN business_members m ON m.business_id = b.id AND m.user_id = users.id
                       WHERE b.id = ? AND b.status = 'active')`,
    )
    .bind(businessId, userId, businessId)
    .run();
  return res.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------

export type BusinessRole = "owner" | "manager" | "member";

export interface BusinessRow {
  id: string;
  owner_id: string;
  name: string;
  category: string;
  custom_category: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  google_business_url: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  description: string | null;
  logo_key: string | null;
  hours_json: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

/** A business plus the derived fields list views need. */
export interface BusinessSummary extends BusinessRow {
  /** how many QRs are scoped to this business */
  qr_count: number;
  /** the requesting user's role, from the membership join */
  role: BusinessRole;
}

export interface CreateBusinessInput {
  name: string;
  category: string;
  custom_category?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  google_business_url?: string | null;
  instagram_url?: string | null;
  facebook_url?: string | null;
  description?: string | null;
  logo_key?: string | null;
  hours_json?: string | null;
}

export type BusinessPatch = Partial<Omit<BusinessRow, "id" | "owner_id" | "created_at">>;

/**
 * Create a business and enrol the creator as its owner.
 *
 * The `businesses` row and the `business_members` row are written together as
 * one D1 batch. Without the batch a crash between them would leave a business
 * that its own owner cannot read back — invisible through the only authorized
 * read path — and unrecoverable without direct SQL.
 */
export async function createBusiness(
  db: D1Database,
  ownerId: string,
  input: CreateBusinessInput,
): Promise<BusinessRow> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const row: BusinessRow = {
    id,
    owner_id: ownerId,
    name: input.name,
    category: input.category,
    custom_category: input.custom_category ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    country: input.country ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    website: input.website ?? null,
    google_business_url: input.google_business_url ?? null,
    instagram_url: input.instagram_url ?? null,
    facebook_url: input.facebook_url ?? null,
    description: input.description ?? null,
    logo_key: input.logo_key ?? null,
    hours_json: input.hours_json ?? null,
    status: "active",
    created_at: now,
    updated_at: now,
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO businesses
           (id, owner_id, name, category, custom_category, address, city, state, country,
            phone, email, website, google_business_url, instagram_url, facebook_url,
            description, logo_key, hours_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.owner_id,
        row.name,
        row.category,
        row.custom_category,
        row.address,
        row.city,
        row.state,
        row.country,
        row.phone,
        row.email,
        row.website,
        row.google_business_url,
        row.instagram_url,
        row.facebook_url,
        row.description,
        row.logo_key,
        row.hours_json,
        row.status,
        row.created_at,
        row.updated_at,
      ),
    db
      .prepare(
        "INSERT INTO business_members (business_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .bind(id, ownerId, now),
  ]);

  return row;
}

/**
 * Read one business *as a member*.
 *
 * The membership join is the authorization check, not a filter applied by the
 * caller. `id` is attacker-controlled (it comes from the URL), so a business
 * owned by someone else must simply not come back.
 *
 * `qr_count` is scoped to `?userId` deliberately. The business may be shared with
 * staff (business_members exists for exactly that), and an unscoped count would
 * tell a member how many codes the OWNER has — a fact about another account's
 * inventory, surfaced in the business switcher on every page.
 */
export async function getBusinessForUser(
  db: D1Database,
  id: string,
  userId: string,
): Promise<BusinessSummary | null> {
  return db
    .prepare(
      `SELECT b.*, m.role AS role,
              (SELECT COUNT(*) FROM qr_codes q
                WHERE q.business_id = b.id AND q.user_id = ?) AS qr_count
         FROM businesses b
         JOIN business_members m ON m.business_id = b.id AND m.user_id = ?
        WHERE b.id = ?
        LIMIT 1`,
    )
    .bind(userId, userId, id)
    .first<BusinessSummary>();
}

/**
 * Every business the user can see, newest activity first.
 *
 * Includes archived businesses: they are hidden from the default views but
 * must stay reachable so they can be restored. Callers filter by status.
 *
 * `qr_count` is the CALLER's own count within the business, for the same
 * cross-tenant reason as getBusinessForUser.
 */
export async function listBusinessesForUser(
  db: D1Database,
  userId: string,
  opts: { status?: "active" | "archived" } = {},
): Promise<BusinessSummary[]> {
  const where = opts.status ? "AND b.status = ?" : "";
  const { results } = await db
    .prepare(
      `SELECT b.*, m.role AS role,
              (SELECT COUNT(*) FROM qr_codes q
                WHERE q.business_id = b.id AND q.user_id = ?) AS qr_count
         FROM businesses b
         JOIN business_members m ON m.business_id = b.id AND m.user_id = ?
        WHERE 1 = 1 ${where}
        ORDER BY b.updated_at DESC`,
    )
    .bind(userId, userId, ...(opts.status ? [opts.status] : []))
    .all<BusinessSummary>();
  return results ?? [];
}

/** Whether the user holds any role on the business. Cheap membership probe. */
export async function getBusinessRole(
  db: D1Database,
  businessId: string,
  userId: string,
): Promise<BusinessRole | null> {
  const row = await db
    .prepare("SELECT role FROM business_members WHERE business_id = ? AND user_id = ? LIMIT 1")
    .bind(businessId, userId)
    .first<{ role: BusinessRole }>();
  return row?.role ?? null;
}

export async function countBusinessesForUser(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM business_members m
         JOIN businesses b ON b.id = m.business_id
        WHERE m.user_id = ? AND b.status = 'active'`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The columns a business patch may write.
 *
 * `id`, `owner_id` and `created_at` are structural, and `status` has its own
 * dedicated membership-checked route — a form must not be able to un-archive a
 * business or reassign its owner by including a hidden field.
 */
const BUSINESS_PATCHABLE = new Set<keyof BusinessRow>([
  "name",
  "category",
  "custom_category",
  "address",
  "city",
  "state",
  "country",
  "phone",
  "email",
  "website",
  "google_business_url",
  "instagram_url",
  "facebook_url",
  "description",
  "logo_key",
  "hours_json",
]);

/**
 * Patch a business on behalf of a member.
 *
 * The UPDATE is guarded by the same membership join as the read, so the write
 * and the read agree on who is allowed. `updated_at` is bumped here rather
 * than trusted from the patch, keeping "last updated" meaningful.
 *
 * Keys are checked against an allow-list before being interpolated. The values
 * are all bound, but a key becomes part of the SQL text, so an unexpected one is
 * dropped rather than concatenated.
 */
export async function updateBusinessForUser(
  db: D1Database,
  id: string,
  userId: string,
  patch: BusinessPatch,
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!BUSINESS_PATCHABLE.has(key as keyof BusinessRow)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (!fields.length) return true;
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  values.push(userId);

  const res = await db
    .prepare(
      `UPDATE businesses SET ${fields.join(", ")}
        WHERE id = ?
          AND EXISTS (SELECT 1 FROM business_members m
                       WHERE m.business_id = businesses.id AND m.user_id = ?)`,
    )
    .bind(...values)
    .run();
  return res.meta.changes > 0;
}

/**
 * Set a business's status (active <-> archived).
 *
 * Archiving is preferred over deletion: QR rows and scan history reference the
 * business, and dropping it would take the customer's interaction data with it.
 */
export async function setBusinessStatusForUser(
  db: D1Database,
  id: string,
  userId: string,
  status: "active" | "archived",
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE businesses SET status = ?, updated_at = ?
        WHERE id = ?
          AND EXISTS (SELECT 1 FROM business_members m
                       WHERE m.business_id = businesses.id AND m.user_id = ?)`,
    )
    .bind(status, Date.now(), id, userId)
    .run();
  return res.meta.changes > 0;
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
  const business_id = row.business_id ?? null;
  const source = row.source ?? "studio";

  await db
    .prepare(
      `INSERT INTO qr_codes
         (id, user_id, type, title, is_dynamic, short_code, destination, content_json, design_json, folder_id, business_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      business_id,
      source,
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
    business_id,
    created_at,
    updated_at,
    // A freshly created code has not been claimed by anyone.
    destination_claimed_by: null,
    destination_claimed_at: null,
    source: row.source ?? "studio",
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

/**
 * The shared SELECT for a user's QR list.
 *
 * The `qr_registry` join is a LEFT JOIN so a studio code (which has no registry
 * row) still appears, with `registry_id` NULL. It is resolved here rather than at
 * each call site so no list can forget it and send a physical stand to the wrong
 * editor.
 */
const QR_LIST_SELECT = `
  SELECT q.*, r.id AS registry_id
    FROM qr_codes q
    LEFT JOIN qr_registry r ON r.qr_code_id = q.id
   WHERE q.user_id = ?
`;

/**
 * Hard cap on a list response.
 *
 * These queries are rendered into a page, not consumed by a paginated client, so
 * there is no "next page" to follow. Without a bound, one account with thousands
 * of codes would render thousands of cards (and — before the scan counters were
 * batched — issue thousands of KV reads) on every dashboard paint. 500 is far
 * beyond any realistic account and keeps a single request bounded.
 *
 * The honest caveat: this TRUNCATES rather than paginates. Real pagination needs
 * a cursor in the query and a "load more" affordance, which is a UI feature, not
 * a safety valve — so it is recorded here rather than half-built.
 */
export const QR_LIST_LIMIT = 500;

/** How many rows a list actually returned, for the "showing N of M" copy. */
export async function countQrByUserScoped(
  db: D1Database,
  userId: string,
  businessId?: string | null,
): Promise<number> {
  const row = businessId
    ? await db
        .prepare("SELECT COUNT(*) AS n FROM qr_codes WHERE user_id = ? AND business_id = ?")
        .bind(userId, businessId)
        .first<{ n: number }>()
    : await db
        .prepare("SELECT COUNT(*) AS n FROM qr_codes WHERE user_id = ?")
        .bind(userId)
        .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listQrByUser(
  db: D1Database,
  userId: string,
): Promise<QrListRow[]> {
  const { results } = await db
    .prepare(`${QR_LIST_SELECT} ORDER BY q.created_at DESC LIMIT ${QR_LIST_LIMIT}`)
    .bind(userId)
    .all<QrListRow>();
  return results ?? [];
}

/**
 * List a user's QRs, optionally narrowed to one business.
 *
 * The business filter is applied in SQL together with the user filter rather
 * than after the fetch. That ordering matters: selecting in the UI says "you
 * are looking at ABC Cafe", and a code from XYZ Restaurant must never be
 * reachable in that view — not even for the frame between load and filter.
 */
export async function listQrByUserScoped(
  db: D1Database,
  userId: string,
  businessId?: string | null,
): Promise<QrListRow[]> {
  if (businessId) {
    const { results } = await db
      .prepare(
        `${QR_LIST_SELECT} AND q.business_id = ? ORDER BY q.created_at DESC LIMIT ${QR_LIST_LIMIT}`,
      )
      .bind(userId, businessId)
      .all<QrListRow>();
    return results ?? [];
  }
  return listQrByUser(db, userId);
}

/** QRs that exist but aren't attached to any business yet. */
export async function countUnassignedQrByUser(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM qr_codes WHERE user_id = ? AND business_id IS NULL",
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Attach a user's own QR to a business.
 *
 * BOTH predicates live in the UPDATE. `user_id = ?` stops a stranger moving
 * your code; the `business_members` EXISTS stops your code being filed under
 * somebody else's business, which would surface it in their dashboard and their
 * QR count. Neither was checked here before — the function trusted the caller to
 * have verified the business.
 */
export async function assignQrToBusiness(
  db: D1Database,
  qrId: string,
  userId: string,
  businessId: string | null,
): Promise<boolean> {
  const now = Date.now();
  const res = businessId
    ? await db
        .prepare(
          `UPDATE qr_codes SET business_id = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
              AND EXISTS (SELECT 1 FROM business_members
                           WHERE business_id = ? AND user_id = ?)`,
        )
        .bind(businessId, now, qrId, userId, businessId, userId)
        .run()
    : await db
        .prepare(
          "UPDATE qr_codes SET business_id = NULL, updated_at = ? WHERE id = ? AND user_id = ?",
        )
        .bind(now, qrId, userId)
        .run();
  return res.meta.changes > 0;
}

/**
 * Delete a QR the caller owns.
 *
 * Refuses a physical stand's configuration (`source = 'registration'`) and
 * refuses anything with scan history. Both are hard database facts rather than
 * policy: `qr_registry.qr_code_id` and `scans.qr_id` both reference this row, so
 * a DELETE on either would raise SQLITE_CONSTRAINT. Letting the statement fail
 * surfaced a bare 500 on the QR detail page's Delete button; catching it here
 * turns a crash into a message that names the right action.
 *
 * A stand is retired, never deleted — see archiveAsset() in db/qr-registry.ts,
 * which keeps the row, the owner and every scan.
 */
export async function deleteQrForUser(
  db: D1Database,
  id: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "is-stand" | "has-scans" }> {
  const row = await db
    .prepare("SELECT id, user_id, source FROM qr_codes WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ id: string; user_id: string; source: QrSource }>();
  if (!row || row.user_id !== userId) return { ok: false, reason: "not-found" };

  if (row.source === "registration") {
    return { ok: false, reason: "is-stand" };
  }

  const scans = await db
    .prepare("SELECT 1 AS x FROM scans WHERE qr_id = ? LIMIT 1")
    .bind(id)
    .first<{ x: number }>();
  if (scans) return { ok: false, reason: "has-scans" };

  await db.prepare("DELETE FROM qr_codes WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return { ok: true };
}

/**
 * Patch a QR row.
 *
 * OWNERSHIP IS A PREDICATE, NOT A PRIOR CHECK. `user_id = ?` is in the WHERE
 * clause so a row belonging to another account matches nothing. The previous
 * version took a bare `id`, so any caller that forgot to check first turned a
 * URL parameter into a cross-tenant write.
 *
 * Deliberately not exported any more as an unguarded primitive: every write
 * path goes through here or through a registry service, and none of them may
 * bypass this guard.
 */
export async function updateQr(
  db: D1Database,
  id: string,
  userId: string,
  patch: QrPatch,
): Promise<boolean> {
  // `short_code` and `folder_id` are identity, not configuration: a caller that
  // could rewrite them could repoint a printed label or move a code between
  // folders it does not own. Neither has a legitimate use on this path.
  const { short_code: _shortCode, folder_id: _folder, ...safe } = patch;

  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(safe)) {
    if (value === undefined) continue;
    if (!QR_PATCHABLE.has(key as QrPatchKey)) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  // Always bump updated_at.
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  values.push(userId);

  const res = await db
    .prepare(`UPDATE qr_codes SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...values)
    .run();
  return res.meta.changes > 0;
}

/** The only qr_codes columns a generic patch may touch. */
const QR_PATCHABLE = new Set<QrPatchKey>([
  "title",
  "is_dynamic",
  "destination",
  "content_json",
  "design_json",
  "business_id",
]);

export type ClaimResult =
  | "claimed"
  | "already-set"
  | "not-found"
  | "not-owner"
  | "managed-elsewhere";

/**
 * Set a deferred destination on a code identified by its short code.
 *
 * OWNERSHIP IS ENFORCED HERE, IN THE UPDATE. `user_id = ?` is a predicate on the
 * same statement, not a check the caller is trusted to have made. This endpoint
 * was previously open to any signed-in account, which let a stranger repoint
 * somebody else's printed code to a URL of their choosing — a stored open
 * redirect served from a physical label, attributed in the audit trail to the
 * attacker.
 *
 * Two further guards matter:
 *
 *   * `source <> 'registration'` — a physical stand's destination is owned by
 *     the registry service (lib/claim.ts), which is the only thing that may
 *     write it. A stand is not claimable through this legacy deferred-destination
 *     path at all, because it has its own lifecycle (claimed / active /
 *     archived) and its own identity (/q/<serial>).
 *   * `destination IS NULL` is the concurrency control, not a pre-flight
 *     SELECT. Two people can open the claim page at the same instant; only one
 *     UPDATE can flip the row, and the loser is told the code is already set.
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
        WHERE short_code = ?
          AND user_id = ?
          AND destination IS NULL
          AND is_dynamic = 1
          AND source <> 'registration'`,
    )
    .bind(destination, userId, now, now, shortCode, userId)
    .run();

  if (res.meta.changes > 0) return "claimed";

  // Distinguish each failure from the others, so the page can say something
  // useful instead of a bare error. Read order matters: existence first, then
  // "managed elsewhere", then ownership, then the race — so the reason never
  // reveals more than the visitor already learned by scanning the code.
  const row = await db
    .prepare(
      "SELECT destination, user_id, source FROM qr_codes WHERE short_code = ? LIMIT 1",
    )
    .bind(shortCode)
    .first<{ destination: string | null; user_id: string; source: string }>();
  if (!row) return "not-found";
  if (row.source === "registration") return "managed-elsewhere";
  if (row.user_id !== userId) return "not-owner";
  if (row.destination !== null) return "already-set";
  // The row matched nothing despite every predicate looking satisfiable, which
  // means a concurrent write beat us between the UPDATE and this read.
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
