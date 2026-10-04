// The physical-asset registry: rows in `qr_registry` (migrations/0006).
//
// Kept in its own module rather than appended to queries.ts because the claim
// path is the one piece of this feature that has to be right on the first try:
// it is the only place ownership is decided, and the SQL below is where that
// decision is made. It is easier to review in isolation.
//
// Every function here takes an explicit owner/user id and derives access from
// it. No function accepts an id from a request and trusts it.

import type { QrStatus } from "../lib/qr-registration";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** One row of `qr_registry`: the permanent identity of a printed stand. */
export interface RegistryRow {
  id: string;
  /** public serial, e.g. 'SQ-8F2K9A' — the only part ever printed or scanned */
  qr_identifier: string;
  status: QrStatus;
  owner_id: string | null;
  business_id: string | null;
  /** linked configuration row in qr_codes; null until claimed */
  qr_code_id: string | null;
  claimed_at: number | null;
  archived_at: number | null;
  last_configured_at: number | null;
  created_at: number;
  updated_at: number;
  /**
   * The batch that minted this asset, or null for a random stand (migrations/0007).
   *
   * Ownership and business are NOT here — they are the fields above, and that is
   * the point: a batch QR is an ordinary registry asset that additionally records
   * which run produced it.
   */
  batch_id: string | null;
  /** Position within the batch. Unbounded — no three-digit limit. */
  batch_sequence: number | null;
  /** The batch's type code, denormalised so a batch can be read without a join. */
  batch_type: string | null;
}

/** A registry row joined to its configuration — what every user-facing read returns. */
export interface QrAssetView extends RegistryRow {
  name: string;
  category: string | null;
  custom_category: string | null;
  placement: string | null;
  destination: string | null;
  short_code: string | null;
  scan_count: number;
  last_scanned_at: number | null;
  business_name: string | null;
  business_city: string | null;
  business_state: string | null;
  business_country: string | null;
}

/**
 * The joined view every user-facing registry read returns.
 *
 * `scan_count` and `last_scanned_at` are TWO correlated subqueries over the same
 * filtered set, i.e. two scans of `scans` per row. They are combined into one
 * pass here so a list of N stands costs one scan rather than two — and, more
 * importantly, so the two numbers can never be derived from different reads and
 * disagree.
 *
 * The count is read from `scans` (D1), NOT from the KV counter the dashboard
 * uses. D1 is the system of record: the KV value is an eventually-consistent
 * fast counter kept for the dashboard's hot list, and using it here is what made
 * a stand show a different number on /qrs than on its own detail page.
 */
const VIEW_SELECT = `
  SELECT r.id, r.qr_identifier, r.status, r.owner_id, r.business_id,
         r.qr_code_id, r.claimed_at, r.archived_at, r.last_configured_at,
         r.created_at, r.updated_at,
         -- Batch provenance (migrations/0007). NULL for a random stand. Included
         -- here because this view IS the stands list, and a list that cannot say
         -- which run produced an asset cannot offer the run's own management.
         r.batch_id, r.batch_sequence, r.batch_type,
         q.title        AS name,
         q.category,
         q.custom_category,
         q.placement,
         q.destination,
         q.short_code,
         b.name         AS business_name,
         b.city         AS business_city,
         b.state        AS business_state,
         b.country      AS business_country,
         -- COALESCE is load-bearing: a LEFT JOIN that finds no matching row
         -- yields NULL, whereas COUNT(*) over an empty set yields 0. Without
         -- it a never-scanned stand reports "null scans" instead of "0 scans".
         COALESCE(s.cnt, 0) AS scan_count,
         s.last         AS last_scanned_at
    FROM qr_registry r
    LEFT JOIN qr_codes q ON q.id = r.qr_code_id
    LEFT JOIN businesses b ON b.id = r.business_id
    LEFT JOIN (
         SELECT qr_id, COUNT(*) AS cnt, MAX(ts) AS last
           FROM scans
          GROUP BY qr_id
    ) s ON s.qr_id = q.id
`;

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Resolve a printed serial. Returns the row regardless of owner — the caller
 *  decides what an anonymous viewer is allowed to be told about it. */
export async function getAssetByIdentifier(
  db: D1Database,
  identifier: string,
): Promise<RegistryRow | null> {
  return db
    .prepare("SELECT * FROM qr_registry WHERE qr_identifier = ?")
    .bind(identifier)
    .first<RegistryRow>();
}

/**
 * The registry row that owns a given configuration row, or null when the
 * configuration belongs to a plain studio code.
 *
 * This is the join every write path needs in order to know whether a `qr_codes`
 * row is half of a physical asset. It replaces inferring it from
 * `source = 'registration'`, which is only a hint: it says a row came from a
 * claim, not that the registry still points at it.
 */
export async function getRegistryByQrCodeId(
  db: D1Database,
  qrCodeId: string,
): Promise<RegistryRow | null> {
  return db
    .prepare("SELECT * FROM qr_registry WHERE qr_code_id = ? LIMIT 1")
    .bind(qrCodeId)
    .first<RegistryRow>();
}

/**
 * Set an owned stand's destination, keeping both tables in step.
 *
 * The narrow counterpart to updateAssetConfig, for the one field that can
 * change without the rest of the configuration: the inline "set destination"
 * control on the QR detail page and the studio's destination field.
 *
 * Routing this through the registry is the point. Writing `qr_codes.destination`
 * directly — which is what the studio API used to do — leaves `qr_registry`
 * claiming 'Setup pending' for a stand that is already serving traffic, and
 * leaves `qr_registry.business_id` disagreeing with `qr_codes.business_id`.
 *
 * Re-activates from 'claimed' to 'active', because a destination is exactly what
 * 'active' means. Archived stands are excluded: retiring is a promise that the
 * code stops serving, and it must not be undone by an edit.
 */
export async function setAssetDestination(
  db: D1Database,
  input: {
    qrCodeId: string;
    ownerId: string;
    destination: string;
  },
): Promise<{ ok: true; asset: QrAssetView } | { ok: false; reason: "not-found" | "archived" }> {
  const now = Date.now();

  const qr = await db
    .prepare(
      `UPDATE qr_codes
          SET destination = ?, destination_claimed_by = ?, destination_claimed_at = ?,
              updated_at = ?
        WHERE id = ?
          AND user_id = ?
          AND EXISTS (SELECT 1 FROM qr_registry r
                       WHERE r.qr_code_id = qr_codes.id
                         AND r.owner_id = ?
                         AND r.status != 'archived')`,
    )
    .bind(input.destination, input.ownerId, now, now, input.qrCodeId, input.ownerId, input.ownerId)
    .run();

  if (qr.meta.changes > 0) {
    const registry = await getRegistryByQrCodeId(db, input.qrCodeId);
    if (registry) {
      await db
        .prepare(
          `UPDATE qr_registry
              SET status = CASE WHEN status = 'claimed' THEN 'active' ELSE status END,
                  last_configured_at = ?, updated_at = ?
            WHERE id = ? AND owner_id = ?`,
        )
        .bind(now, now, registry.id, input.ownerId)
        .run();
      const asset = await getAssetViewForOwner(db, registry.id, input.ownerId);
      if (asset) return { ok: true, asset };
    }
    return { ok: false, reason: "not-found" };
  }

  const registry = await getRegistryByQrCodeId(db, input.qrCodeId);
  if (!registry || registry.owner_id !== input.ownerId) return { ok: false, reason: "not-found" };
  return { ok: false, reason: "archived" };
}

/**
 * Move an owned stand's configuration to a different business of the caller's,
 * keeping the registry's denormalised pointer in step.
 *
 * Used by the studio's business-assignment control, which is a second way to
 * reach a physical stand's configuration and would otherwise drift the ledger.
 */
export async function moveAssetBusiness(
  db: D1Database,
  input: {
    qrCodeId: string;
    ownerId: string;
    businessId: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "business-forbidden" }> {
  const now = Date.now();

  const qr = await db
    .prepare(
      `UPDATE qr_codes
          SET business_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
          AND EXISTS (SELECT 1 FROM qr_registry r
                       WHERE r.qr_code_id = qr_codes.id
                         AND r.owner_id = ?
                         AND r.status != 'archived')`,
    )
    .bind(input.businessId, now, input.qrCodeId, input.ownerId, input.ownerId)
    .run();

  // A null target means "detach", which any owner may do; a real target must be
  // a business they belong to. Checked here rather than as a conditional clause
  // so the two cases do not need two different parameter lists — a mismatch
  // between a template and its binds is a 500, and this used to have one.
  if (qr.meta.changes > 0) {
    if (input.businessId) {
      const member = await db
        .prepare("SELECT 1 AS ok FROM business_members WHERE business_id = ? AND user_id = ? LIMIT 1")
        .bind(input.businessId, input.ownerId)
        .first<{ ok: number }>();
      if (!member) {
        // Undo: the row moved to a business the caller does not belong to.
        await db
          .prepare("UPDATE qr_codes SET business_id = ? WHERE id = ?")
          .bind(null, input.qrCodeId)
          .run();
        return { ok: false, reason: "business-forbidden" };
      }
    }

    const registry = await getRegistryByQrCodeId(db, input.qrCodeId);
    if (registry) {
      await db
        .prepare("UPDATE qr_registry SET business_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
        .bind(input.businessId, now, registry.id, input.ownerId)
        .run();
    }
    return { ok: true };
  }

  const registry = await getRegistryByQrCodeId(db, input.qrCodeId);
  if (!registry || registry.owner_id !== input.ownerId) return { ok: false, reason: "not-found" };
  return { ok: false, reason: "business-forbidden" };
}

/** Full joined view by serial. */
export async function getAssetViewByIdentifier(
  db: D1Database,
  identifier: string,
): Promise<QrAssetView | null> {
  return db
    .prepare(`${VIEW_SELECT} WHERE r.qr_identifier = ?`)
    .bind(identifier)
    .first<QrAssetView>();
}

/** Full joined view by internal id, but ONLY for a given owner.
 *  Returns null for anyone else, which is what makes cross-tenant access a
 *  non-leaking 404 rather than a 403 that confirms the row exists. */
export async function getAssetViewForOwner(
  db: D1Database,
  id: string,
  ownerId: string,
): Promise<QrAssetView | null> {
  return db
    .prepare(`${VIEW_SELECT} WHERE r.id = ? AND r.owner_id = ?`)
    .bind(id, ownerId)
    .first<QrAssetView>();
}

/**
 * Hard cap on one list response. See QR_LIST_LIMIT in db/queries.ts — same
 * reasoning, and the same caveat: this bounds a request, it is not pagination.
 */
const ASSET_LIST_LIMIT = 500;

/** The caller's own assets, newest first, with optional filters. */
export async function listAssetsForOwner(
  db: D1Database,
  ownerId: string,
  filters: {
    businessId?: string | null;
    category?: string | null;
    status?: QrStatus | null;
    search?: string | null;
  } = {},
): Promise<QrAssetView[]> {
  const where: string[] = ["r.owner_id = ?"];
  const binds: string[] = [ownerId];

  if (filters.businessId) {
    where.push("r.business_id = ?");
    binds.push(filters.businessId);
  }
  if (filters.status) {
    where.push("r.status = ?");
    binds.push(filters.status);
  }
  if (filters.category) {
    where.push("(q.category = ? OR q.custom_category = ?)");
    binds.push(filters.category, filters.category);
  }
  if (filters.search) {
    // Matches either the human name or the serial, because "which stand is
    // SQ-8F2K9A" is the question people actually ask of a search box.
    where.push("(LOWER(q.title) LIKE ? OR LOWER(r.qr_identifier) LIKE ?)");
    const like = `%${filters.search.toLowerCase()}%`;
    binds.push(like, like);
  }

  return db
    .prepare(
      `${VIEW_SELECT} WHERE ${where.join(" AND ")}
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${ASSET_LIST_LIMIT}`,
    )
    .bind(...binds)
    .all<QrAssetView>()
    .then((r) => r.results);
}

// ---------------------------------------------------------------------------
// Provisioning (manufacturing / operator tooling, never user-facing)
// ---------------------------------------------------------------------------

/**
 * Register printed serials so they exist before anyone claims them.
 *
 * A stand is only a valid claim target if its serial was registered when it was
 * manufactured. Without this table a claim of an unknown serial is a 404, which
 * is what stops "just guess a serial and take someone's QR".
 */
export async function registerAsset(
  db: D1Database,
  identifier: string,
): Promise<RegistryRow | null> {
  const now = Date.now();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO qr_registry (id, qr_identifier, status, created_at, updated_at)
       VALUES (?, ?, 'unclaimed', ?, ?)`,
    )
    .bind(id, identifier, now, now)
    .run();
  return getAssetByIdentifier(db, identifier);
}

/** Bulk variant for seeding a production run. Rejects duplicates loudly. */
export async function registerAssets(
  db: D1Database,
  identifiers: string[],
): Promise<number> {
  const now = Date.now();
  const stmts = identifiers.map((identifier) =>
    db
      .prepare(
        `INSERT INTO qr_registry (id, qr_identifier, status, created_at, updated_at)
         VALUES (?, ?, 'unclaimed', ?, ?)`,
      )
      .bind(crypto.randomUUID(), identifier, now, now),
  );
  if (!stmts.length) return 0;
  await db.batch(stmts);
  return stmts.length;
}

/** The configuration row a claim will attach to. Created before the CAS. */
export async function insertRegistrationQr(
  db: D1Database,
  input: {
    id: string;
    ownerId: string;
    businessId: string;
    name: string;
    category: string;
    customCategory: string | null;
    placement: string | null;
    destination: string;
    shortCode: string;
  },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO qr_codes
         (id, user_id, business_id, type, title, is_dynamic, short_code, destination,
          content_json, design_json, category, custom_category, placement,
          source, claimed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'url', ?, 1, ?, ?, '{}', '{}', ?, ?, ?, 'registration', ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.ownerId,
      input.businessId,
      input.name,
      input.shortCode,
      input.destination,
      input.category,
      input.customCategory,
      input.placement,
      now,
      now,
      now,
    )
    .run();
}

// ---------------------------------------------------------------------------
// THE CLAIM
// ---------------------------------------------------------------------------

export type ClaimOutcome =
  /** This user won the race; the asset is now theirs. */
  | { ok: true; asset: QrAssetView }
  /** Someone else owns it, or it has been retired. */
  | { ok: false; reason: "already-claimed" | "archived" | "not-found" | "not-claimable" }
  /** The chosen business is not one the caller belongs to. */
  | { ok: false; reason: "business-forbidden" };

/**
 * Atomically claim a printed stand for a user.
 *
 * The whole decision is one UPDATE. It is the only statement that can set
 * owner_id, and it carries every precondition in its WHERE clause:
 *
 *   * the serial is unclaimed (`owner_id IS NULL`) — so two simultaneous claims
 *     cannot both match, and D1 serialises writes to a row, so exactly one
 *     gets `changes = 1` and the other gets 0;
 *   * it is not archived;
 *   * the caller is a member of the business being attached, checked with an
 *     EXISTS subquery IN THIS SAME STATEMENT, so a business id from the request
 *     is verified against the database rather than trusted;
 *   * a re-entry by the same owner is allowed only for an asset that is owned
 *     but not yet active, which is how an interrupted setup is resumed.
 *
 * The FK on qr_code_id and the table CHECK together mean a losing racer cannot
 * leave a half-claimed row behind even if it tries: the status and owner can
 * only ever move together.
 *
 * The caller must have already inserted the configuration row and pass its id.
 * If this returns ok:false, the caller deletes that row — see claimQrAsset() in
 * the service, which owns that compensation.
 */
export async function claimAsset(
  db: D1Database,
  input: {
    identifier: string;
    ownerId: string;
    businessId: string;
    qrCodeId: string;
    status: QrStatus;
  },
): Promise<ClaimOutcome> {
  const now = Date.now();

  const res = await db
    .prepare(
      `UPDATE qr_registry
          SET owner_id = ?,
              business_id = ?,
              qr_code_id = ?,
              status = ?,
              claimed_at = COALESCE(claimed_at, ?),
              last_configured_at = ?,
              updated_at = ?
        WHERE qr_identifier = ?
          AND (owner_id IS NULL OR owner_id = ?)
          AND status IN ('unclaimed', 'claimed')
          AND EXISTS (
            SELECT 1 FROM business_members
             WHERE business_id = ? AND user_id = ?
          )`,
    )
    .bind(
      input.ownerId,
      input.businessId,
      input.qrCodeId,
      input.status,
      now,
      now,
      now,
      input.identifier,
      input.ownerId,
      input.businessId,
      input.ownerId,
    )
    .run();

  if (res.meta.changes > 0) {
    const asset = await db
      .prepare(`${VIEW_SELECT} WHERE r.qr_identifier = ?`)
      .bind(input.identifier)
      .first<QrAssetView>();
    // The row we just wrote must exist; if it somehow doesn't, treat it as a
    // lost race rather than handing back a half-built object.
    if (asset) return { ok: true, asset };
  }

  // Lost the race, or a precondition failed. Read the row to say which, so the
  // UI can distinguish "someone beat you" from "that serial doesn't exist"
  // without the caller having to guess.
  const row = await getAssetByIdentifier(db, input.identifier);
  if (!row) return { ok: false, reason: "not-found" };
  if (row.status === "archived") return { ok: false, reason: "archived" };
  if (row.owner_id && row.owner_id !== input.ownerId) {
    return { ok: false, reason: "already-claimed" };
  }
  if (row.status === "active") return { ok: false, reason: "not-claimable" };
  // Still ours to take but the membership check failed.
  return { ok: false, reason: "business-forbidden" };
}

/** Remove a configuration row that lost a claim race. Compensation only. */
export async function deleteOrphanQr(db: D1Database, qrId: string): Promise<void> {
  await db
    .prepare("DELETE FROM qr_codes WHERE id = ? AND source = 'registration'")
    .bind(qrId)
    .run();
}

/**
 * Drop a superseded configuration row left behind by re-entering the claim flow.
 *
 * `claimAsset` deliberately lets the current owner re-claim a stand they have
 * claimed but not finished, which is how an interrupted setup is resumed. The
 * service then creates a fresh configuration row and repoints the registry at
 * it — so the previous row is orphaned: it keeps a short code, it still answers
 * on /r/<code>, and it is invisible to every user-facing query because those all
 * read through the registry join.
 *
 * An orphan is invisible to its owner and permanently served, which is worse than
 * the state the re-entry was meant to fix. So the swap is completed here: the
 * new row wins, the old one is removed. Safe because it is scoped to
 * `source = 'registration'` and to a row the registry no longer references.
 */
export async function dropSupersededQr(db: D1Database, qrId: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM qr_codes
        WHERE id = ?
          AND source = 'registration'
          AND id NOT IN (SELECT qr_code_id FROM qr_registry WHERE qr_code_id IS NOT NULL)`,
    )
    .bind(qrId)
    .run();
}

// ---------------------------------------------------------------------------
// Post-claim configuration
// ---------------------------------------------------------------------------

/**
 * Edit an owned asset's configuration.
 *
 * Ownership is re-asserted in the WHERE clause from the caller's id, so this is
 * safe to call with an id lifted out of a URL. Destination is REQUIRED to
 * re-activate: clearing a destination would make a printed stand 404 every
 * customer who scans it, so 'active' is only reachable with somewhere to go.
 */
export async function updateAssetConfig(
  db: D1Database,
  input: {
    registryId: string;
    ownerId: string;
    name: string;
    category: string;
    customCategory: string | null;
    placement: string | null;
    destination: string;
    businessId: string;
  },
): Promise<{ ok: true; asset: QrAssetView } | { ok: false; reason: "not-found" | "business-forbidden" }> {
  const now = Date.now();
  const res = await db
    .prepare(
      `UPDATE qr_codes
          SET title = ?, category = ?, custom_category = ?, placement = ?,
              destination = ?, business_id = ?, updated_at = ?
        WHERE id = (SELECT qr_code_id FROM qr_registry
                     WHERE id = ? AND owner_id = ? AND status != 'archived')
          AND EXISTS (SELECT 1 FROM business_members
                       WHERE business_id = ? AND user_id = ?)`,
    )
    .bind(
      input.name,
      input.category,
      input.customCategory,
      input.placement,
      input.destination,
      input.businessId,
      now,
      input.registryId,
      input.ownerId,
      input.businessId,
      input.ownerId,
    )
    .run();

  if (res.meta.changes > 0) {
    // Keep the ledger's denormalised business pointer in step with the config,
    // and re-assert the status. Doing it here rather than at each call site is
    // what stops the two tables drifting apart.
    await db
      .prepare(
        `UPDATE qr_registry
            SET business_id = ?, last_configured_at = ?, updated_at = ?,
                status = CASE WHEN status = 'claimed' THEN 'active' ELSE status END
          WHERE id = ? AND owner_id = ?`,
      )
      .bind(input.businessId, now, now, input.registryId, input.ownerId)
      .run();

    const asset = await getAssetViewForOwner(db, input.registryId, input.ownerId);
    if (asset) return { ok: true, asset };
  }
  // Distinguish "not yours / gone" from "that business isn't yours to attach".
  const mine = await getAssetViewForOwner(db, input.registryId, input.ownerId);
  if (!mine) return { ok: false, reason: "not-found" };
  return { ok: false, reason: "business-forbidden" };
}

/**
 * Archive an asset. The row, the owner, the business and every scan survive.
 *
 * Guarded on the caller's id and on `status != 'archived'` so it is idempotent
 * and cannot be aimed at someone else's stand.
 */
export async function archiveAsset(
  db: D1Database,
  registryId: string,
  ownerId: string,
): Promise<{ ok: boolean; status: QrStatus | null }> {
  const now = Date.now();
  const res = await db
    .prepare(
      `UPDATE qr_registry SET status = 'archived', archived_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND status != 'archived'`,
    )
    .bind(now, now, registryId, ownerId)
    .run();
  if (res.meta.changes > 0) return { ok: true, status: "archived" };
  const mine = await getAssetViewForOwner(db, registryId, ownerId);
  return { ok: false, status: mine?.status ?? null };
}

/** Bring an archived asset back. Kept narrow on purpose: an archived stand is
 *  never re-claimable by anyone else, so this only ever revives your own. */
export async function restoreAsset(
  db: D1Database,
  registryId: string,
  ownerId: string,
): Promise<{ ok: boolean; status: QrStatus | null }> {
  const now = Date.now();
  const res = await db
    .prepare(
      `UPDATE qr_registry
          SET status = CASE WHEN qr_code_id IS NOT NULL THEN 'active' ELSE 'claimed' END,
              archived_at = NULL, updated_at = ?
        WHERE id = ? AND owner_id = ? AND status = 'archived'`,
    )
    .bind(now, registryId, ownerId)
    .run();
  if (res.meta.changes > 0) {
    const mine = await getAssetViewForOwner(db, registryId, ownerId);
    return { ok: true, status: mine?.status ?? "active" };
  }
  const mine = await getAssetViewForOwner(db, registryId, ownerId);
  return { ok: false, status: mine?.status ?? null };
}

/** Count of a user's assets by status, for the management page summary. */
export async function countAssetsForOwner(
  db: D1Database,
  ownerId: string,
): Promise<{ total: number; active: number; archived: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived
         FROM qr_registry WHERE owner_id = ?`,
    )
    .bind(ownerId)
    .first<{ total: number; active: number; archived: number }>();
  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    archived: row?.archived ?? 0,
  };
}
