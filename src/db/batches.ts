/**
 * Batch persistence.
 *
 * ---------------------------------------------------------------------------
 * BATCH QRs ARE REGISTRY ROWS
 * ---------------------------------------------------------------------------
 * There is no `qr_codes`-parallel batch table. A batch mints `qr_registry` rows,
 * because that table is where a printed asset's identity, owner and lifecycle
 * already live — and where `qr_identifier` is already UNIQUE. Creating a second
 * QR store would have meant a second uniqueness mechanism, a second archive
 * lifecycle, and a second dashboard.
 *
 * ---------------------------------------------------------------------------
 * ATOMICITY
 * ---------------------------------------------------------------------------
 * Generation is all-or-nothing. Every registry row and its configuration row are
 * written in ONE `db.batch()`, which D1 executes as a single transaction: either
 * the whole batch lands or none of it does.
 *
 * The alternative — insert, check, insert, check — would leave 13 of 18 rows in
 * place after the 14th collided. A batch that partially exists is worse than one
 * that failed, because the user's next instinct is to retry, and a retry of a
 * partially-created range collides with the half that DID land.
 *
 * `qr_batches` is written in the same transaction, so a batch row can never
 * exist without its QRs or vice versa.
 *
 * ---------------------------------------------------------------------------
 * A BATCH REQUIRES A BUSINESS
 * ---------------------------------------------------------------------------
 * Not a product decision made here — a consequence of `qr_registry`'s existing
 * CHECK, which permits an owned row only when owner, business and configuration
 * are ALL set. An "owned but not yet filed under a business" row is a state the
 * table cannot represent.
 *
 * Relaxing it would mean rebuilding a table with three foreign-key dependants,
 * which is the same high-risk change migrations/0006 declined for the same
 * reason. Requiring a business is also consistent with the existing claim flow,
 * which already makes a business mandatory (`/qrs/claim/business` exists because
 * a QR cannot be unscoped on the dashboard).
 *
 * ---------------------------------------------------------------------------
 * UNIQUENESS IS THE DATABASE'S JOB
 * ---------------------------------------------------------------------------
 * `claimQrAsset`-style compare-and-swap is the right tool for a single contested
 * row. A batch of 2000 is not one row, and D1 has no interactive transaction, so
 * there is no way to CAS 2000 rows at once. What D1 DOES guarantee is the UNIQUE
 * index: if two users request overlapping ranges concurrently, exactly one
 * transaction commits and the other fails the constraint. We surface that as a
 * clear conflict naming the colliding serials rather than a 500.
 *
 * A pre-flight existence check is still done, but only to produce a GOOD error
 * message. It is not the guarantee — the constraint is.
 */

import {
  composeSerial,
  expandSerials,
  formatSequence,
  parseMetadata,
  type BatchConfig,
  type BatchMetadataField,
} from "../lib/batch";
import { ensureUniqueShortCode } from "../lib/shortcode";
import { statusFor } from "../lib/qr-registration";

/** A batch row, as stored. */
export interface BatchRow {
  id: string;
  owner_id: string;
  business_id: string | null;
  type: string;
  batch_number: string;
  sequence_start: number;
  sequence_end: number;
  quantity: number;
  metadata_json: string;
  status: "ready" | "archived";
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A batch plus the derived fields list and detail views need. */
export interface BatchSummary extends BatchRow {
  metadata: BatchMetadataField[];
  business_name: string | null;
  owner_email: string;
  first_serial: string;
  last_serial: string;
}

/** One QR inside a batch. */
export interface BatchQrView {
  registry_id: string;
  serial: string;
  sequence: number;
  /** the internal qr_codes id, for the asset + analytics routes */
  qr_code_id: string | null;
  short_code: string | null;
  destination: string | null;
  status: string;
  created_at: number;
}

export type CreateBatchFailure =
  | "serials-exist"
  | "range-exists"
  | "no-business";

export type CreateBatchResult =
  | { ok: true; batch: BatchSummary }
  | {
      ok: false;
      reason: CreateBatchFailure;
      /** the serials that already exist, for the error copy */
      conflicts?: string[];
      message: string;
    };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const BATCH_SELECT = `
  SELECT b.*,
         biz.name AS business_name,
         u.email   AS owner_email
    FROM qr_batches b
    JOIN users u          ON u.id = b.owner_id
    LEFT JOIN businesses biz ON biz.id = b.business_id
`;

/** Attach the derived serial bounds and parsed metadata to a raw row. */
function toSummary(row: Omit<BatchSummary, "metadata" | "first_serial" | "last_serial">): BatchSummary {
  return {
    ...row,
    metadata: parseMetadata(row.metadata_json),
    first_serial: composeSerial(row.type, row.batch_number, row.sequence_start),
    last_serial: composeSerial(row.type, row.batch_number, row.sequence_end),
  };
}

/** One batch, but ONLY for its owner. Null for anyone else — a non-leaking 404. */
export async function getBatchForOwner(
  db: D1Database,
  id: string,
  ownerId: string,
): Promise<BatchSummary | null> {
  const row = await db
    .prepare(`${BATCH_SELECT} WHERE b.id = ? AND b.owner_id = ? LIMIT 1`)
    .bind(id, ownerId)
    .first<Omit<BatchSummary, "metadata" | "first_serial" | "last_serial">>();
  return row ? toSummary(row) : null;
}

/** Every batch the caller owns, newest first. */
export async function listBatchesForOwner(
  db: D1Database,
  ownerId: string,
  opts: { status?: "ready" | "archived" } = {},
): Promise<BatchSummary[]> {
  const { results } = await db
    .prepare(
      `${BATCH_SELECT}
        WHERE b.owner_id = ? ${opts.status ? "AND b.status = ?" : ""}
        ORDER BY b.created_at DESC, b.id DESC`,
    )
    .bind(...(opts.status ? [ownerId, opts.status] : [ownerId]))
    .all<Omit<BatchSummary, "metadata" | "first_serial" | "last_serial">>();
  return (results ?? []).map(toSummary);
}

/**
 * The QRs of a batch, in sequence order.
 *
 * Reads through the registry rather than a denormalised copy so the list can
 * never disagree with the stand management page about what this batch contains.
 */
export async function listBatchQrs(
  db: D1Database,
  batchId: string,
  ownerId: string,
): Promise<BatchQrView[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id AS registry_id,
              r.qr_identifier AS serial,
              r.batch_sequence AS sequence,
              r.qr_code_id,
              r.status,
              r.created_at,
              q.short_code,
              q.destination
         FROM qr_registry r
         LEFT JOIN qr_codes q ON q.id = r.qr_code_id
        WHERE r.batch_id = ? AND r.owner_id = ?
        ORDER BY r.batch_sequence ASC`,
    )
    .bind(batchId, ownerId)
    .all<BatchQrView>();
  return results ?? [];
}

/** Total QRs actually present for a batch — must match `quantity` to be "ready". */
export async function countBatchQrs(
  db: D1Database,
  batchId: string,
  ownerId: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM qr_registry WHERE batch_id = ? AND owner_id = ?")
    .bind(batchId, ownerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Distinct destinations in a batch, for the detail page summary. */
export async function batchDestinations(
  db: D1Database,
  batchId: string,
  ownerId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT q.destination AS d
         FROM qr_registry r JOIN qr_codes q ON q.id = r.qr_code_id
        WHERE r.batch_id = ? AND r.owner_id = ? AND q.destination IS NOT NULL
        ORDER BY d`,
    )
    .bind(batchId, ownerId)
    .all<{ d: string }>();
  return (results ?? []).map((r) => r.d).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Which of the requested serials already exist.
 *
 * Runs BEFORE generation, purely to produce an error the user can act on. The
 * authoritative check is the UNIQUE index; this one lets us say *which* serial
 * collided instead of surfacing a constraint failure.
 *
 * Chunked because D1 caps bound parameters, and a 2000-item batch would
 * otherwise exceed it in a single statement.
 */
export async function findExistingSerials(
  db: D1Database,
  serials: string[],
): Promise<string[]> {
  const found: string[] = [];
  const CHUNK = 100;
  for (let i = 0; i < serials.length; i += CHUNK) {
    const chunk = serials.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT qr_identifier FROM qr_registry WHERE qr_identifier IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<{ qr_identifier: string }>();
    for (const row of results ?? []) found.push(row.qr_identifier);
  }
  // Return in the caller's order so the message reads "001 through 018", not a
  // jumble of SQLite's IN-order.
  const set = new Set(found);
  return serials.filter((s) => set.has(s));
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Create a batch: the row, one registry row per serial, and one configuration
 * row per serial — all in one transaction.
 *
 * `appUrl` is used only to record nothing; the permanent URL is DERIVED at read
 * time from APP_URL, so a deployment that moves domains does not leave stale
 * absolute URLs stored in the registry. Storing the URL would also mean the
 * printed QR and the stored URL could disagree, which defeats the point of a
 * permanent identity.
 */
export async function createBatch(
  db: D1Database,
  input: {
    ownerId: string;
    businessId: string;
    config: BatchConfig;
    appUrl: string;
  },
): Promise<CreateBatchResult> {
  const { config } = input;
  const serials = expandSerials(config);

  if (!input.businessId) {
    return {
      ok: false,
      reason: "no-business",
      message:
        "Choose a business for this batch. Every Sqanny QR belongs to one, which is what keeps its scans separate.",
    };
  }
  const businessId = input.businessId;

  const existing = await findExistingSerials(db, serials);
  if (existing.length) {
    return {
      ok: false,
      reason: "serials-exist",
      conflicts: existing,
      message: conflictMessage(existing, serials),
    };
  }

  // Exact-duplicate guard. The UNIQUE(type, batch_number, sequence_start)
  // constraint would catch it, but a constraint failure has no message worth
  // showing a user, so it is checked by name.
  const duplicate = await db
    .prepare(
      "SELECT id FROM qr_batches WHERE type = ? AND batch_number = ? AND sequence_start = ? LIMIT 1",
    )
    .bind(config.type, config.batchNumber, config.sequenceStart)
    .first<{ id: string }>();
  if (duplicate) {
    return {
      ok: false,
      reason: "range-exists",
      conflicts: serials,
      message: `Batch ${config.batchNumber} (${config.type}) already covers sequences ${formatSequence(
        config.sequenceStart,
      )} onward. Choose a different starting sequence or batch number.`,
    };
  }

  const batchId = crypto.randomUUID();
  const now = Date.now();

  // Short codes are minted for the configuration rows so each QR has a working
  // /r/<code> entry as well as the permanent /q/<serial> one. Retried through
  // ensureUniqueShortCode's insert callback, so a collision is invisible.
  const shortCodes: string[] = [];
  for (let i = 0; i < config.quantity; i++) {
    const code = await ensureUniqueShortCode(db, 7);
    shortCodes.push(code);
  }

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO qr_batches
           (id, owner_id, business_id, type, batch_number, sequence_start, sequence_end,
            quantity, metadata_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      )
      .bind(
        batchId,
        input.ownerId,
        input.businessId,
        config.type,
        config.batchNumber,
        config.sequenceStart,
        config.sequenceEnd,
        config.quantity,
        JSON.stringify(config.metadata),
        now,
        now,
      ),
  ];

  // Status comes from the one authoritative helper, `statusFor(hasDestination)`,
  // rather than being hardcoded. An earlier version pinned these rows to 'active'
  // on the reasoning that a batch QR's destination is "a separate, later decision".
  // That is true of the DECISION but not of the STATE, and the state is what this
  // column records:
  //
  //  - 'claimed' renders as "Setup pending", which is exactly what a printed label
  //    that resolves to a setup page actually is. A stands list badging 2000 rows
  //    "Active" when none of them reach the shop is worse than useless — it is the
  //    one list a user would check to answer "which of my codes are live?".
  //  - A single stand claimed and left unconfigured already shows "Setup pending".
  //    Identical owner + business + no destination must not badge differently just
  //    because 2000 of them arrived at once.
  //  - Nothing is lost. The batch page carries its own 'ready' status and its own
  //    destination workflow, so the operational answer is still one click away.
  //
  // Business is separately required by the qr_registry CHECK for any owned row,
  // which is why `statusFor` can only ever return 'claimed' or 'active' here.
  const status = statusFor(Boolean(config.destination));

  for (let i = 0; i < config.quantity; i++) {
    const sequence = config.sequenceStart + i;
    const serial = composeSerial(config.type, config.batchNumber, sequence);
    const qrCodeId = crypto.randomUUID();

    // ORDER IS LOAD-BEARING.
    //
    // `qr_registry.qr_code_id` REFERENCES `qr_codes(id)`, and SQLite checks
    // foreign keys immediately unless the constraint is deferred. Inserting the
    // registry row first therefore fails with SQLITE_CONSTRAINT, taking the whole
    // batch with it. The configuration row must be written first — which is also
    // why claimQr() inserts its configuration row before its compare-and-swap.
    statements.push(
      db
        .prepare(
          `INSERT INTO qr_codes
             (id, user_id, business_id, type, title, is_dynamic, short_code, destination,
              content_json, design_json, category, placement, source, claimed_at,
              created_at, updated_at)
           VALUES (?, ?, ?, 'url', ?, 1, ?, ?, '{}', '{}', ?, NULL, 'registration', ?, ?, ?)`,
        )
        .bind(
          qrCodeId,
          input.ownerId,
          businessId,
          // The serial is the name. With 2000 of these in a list, "QR 17" is
          // useless and "SQ-GR-B01-017" is not.
          serial,
          shortCodes[i],
          config.destination,
          config.type,
          now,
          now,
          now,
        ),
    );

    statements.push(
      db
        .prepare(
          `INSERT INTO qr_registry
             (id, qr_identifier, status, owner_id, business_id, qr_code_id,
              claimed_at, last_configured_at, batch_id, batch_sequence, batch_type,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          serial,
          status,
          input.ownerId,
          businessId,
          qrCodeId,
          now,
          now,
          batchId,
          sequence,
          config.type,
          now,
          now,
        ),
    );
  }

  let batch: BatchSummary | null = null;
  try {
    // One transaction. A UNIQUE violation anywhere aborts the whole thing.
    await db.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost a race between the pre-check above and this commit. Report it the
      // same way, with a fresh read so the message names the real culprit.
      const nowTaken = await findExistingSerials(db, serials);
      return {
        ok: false,
        reason: "serials-exist",
        conflicts: nowTaken,
        message: conflictMessage(nowTaken, serials),
      };
    }
    console.error("[batches] generation failed:", err);
    return {
      ok: false,
      reason: "serials-exist",
      conflicts: [],
      message: "The batch could not be generated. Nothing was created — please try again.",
    };
  }

  batch = await getBatchForOwner(db, batchId, input.ownerId);
  if (!batch) {
    return {
      ok: false,
      reason: "serials-exist",
      conflicts: [],
      message: "The batch was created but could not be read back. Please try again.",
    };
  }
  return { ok: true, batch };
}

/**
 * The conflict message.
 *
 * Names the specific serials, because "serials already exist" gives the user
 * nothing to act on — they cannot tell whether they mis-typed the start, whether
 * someone else already ran this batch, or whether their own earlier attempt
 * succeeded and they did not notice.
 */
function conflictMessage(conflicts: string[], all: string[]): string {
  if (!conflicts.length) return "These serial numbers already exist.";
  const first = conflicts[0];
  if (conflicts.length === 1) {
    return `${first} already exists. Pick a different starting sequence or batch number.`;
  }
  if (conflicts.length === all.length) {
    return `All ${conflicts.length} of these serial numbers already exist (starting at ${first}). Pick a different starting sequence or batch number.`;
  }
  return `${first} and ${conflicts.length - 1} more in this range already exist (up to ${
    conflicts[conflicts.length - 1]
  }). Pick a different starting sequence.`;
}

/** Whether an error is a UNIQUE / PRIMARY KEY constraint failure. */
export function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /UNIQUE constraint failed|PRIMARY KEY must be unique|SQLITE_CONSTRAINT_UNIQUE/i.test(
    message,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Archive a batch.
 *
 * Retires every QR in it — a batch is produced and retired as a unit, and leaving
 * half a batch serving would be indistinguishable from a bug. The rows, the owner,
 * the metadata and the serials all survive, so it can be restored.
 *
 * Idempotent: an already-archived batch reports `ok: true` with no second write,
 * so a double-click cannot produce a confusing error.
 */
export async function archiveBatch(
  db: D1Database,
  batchId: string,
  ownerId: string,
): Promise<{ ok: boolean; status: "ready" | "archived" | null; archivedCount: number }> {
  const now = Date.now();

  const already = await db
    .prepare("SELECT status FROM qr_batches WHERE id = ? AND owner_id = ? LIMIT 1")
    .bind(batchId, ownerId)
    .first<{ status: "ready" | "archived" }>();
  if (!already) return { ok: false, status: null, archivedCount: 0 };
  if (already.status === "archived") {
    const n = await countBatchQrs(db, batchId, ownerId);
    return { ok: true, status: "archived", archivedCount: n };
  }

  // Batch the batch-row update with the registry update so the two cannot
  // disagree. db.batch is one transaction.
  await db.batch([
    db
      .prepare(
        "UPDATE qr_batches SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
      )
      .bind(now, now, batchId, ownerId),
    db
      .prepare(
        "UPDATE qr_registry SET status = 'archived', archived_at = ?, updated_at = ? WHERE batch_id = ? AND owner_id = ? AND status != 'archived'",
      )
      .bind(now, now, batchId, ownerId),
  ]);

  return { ok: true, status: "archived", archivedCount: await countBatchQrs(db, batchId, ownerId) };
}

/** Bring an archived batch and all of its QRs back. */
export async function restoreBatch(
  db: D1Database,
  batchId: string,
  ownerId: string,
): Promise<{ ok: boolean; status: "ready" | "archived" | null }> {
  const now = Date.now();
  const batch = await getBatchForOwner(db, batchId, ownerId);
  if (!batch) return { ok: false, status: null };
  if (batch.status !== "archived") return { ok: true, status: batch.status };

  // A batch without a business stays 'claimed': the registry CHECK forbids an
  // active row with no business, and downgrading would be a silent lie.
  const status = batch.business_id ? "active" : "claimed";

  await db.batch([
    db
      .prepare(
        "UPDATE qr_batches SET status = 'ready', archived_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ?",
      )
      .bind(now, batchId, ownerId),
    db
      .prepare(
        "UPDATE qr_registry SET status = ?, archived_at = NULL, updated_at = ? WHERE batch_id = ? AND owner_id = ? AND status = 'archived'",
      )
      .bind(status, now, batchId, ownerId),
  ]);

  return { ok: true, status: "ready" };
}

// ---------------------------------------------------------------------------
// Regeneration
// ---------------------------------------------------------------------------

/**
 * Regenerate a batch's assets.
 *
 * A no-op on the database BY DESIGN. The QR record is the identity; the SVG is a
 * render of it. Regenerating re-derives the image from the same permanent URL and
 * the same stored design, so it cannot change the serial, the destination, the
 * business, the owner or the batch membership — and it cannot create a row,
 * because nothing is inserted.
 *
 * Returns the per-QR render input so the caller can rebuild assets without
 * re-querying, and reports how many were regenerated so the UI can say so.
 */
export async function batchRenderInputs(
  db: D1Database,
  batchId: string,
  ownerId: string,
): Promise<
  Array<{
    registry_id: string;
    serial: string;
    short_code: string | null;
    destination: string | null;
    design_json: string;
  }>
> {
  const { results } = await db
    .prepare(
      `SELECT r.id AS registry_id,
              r.qr_identifier AS serial,
              q.short_code,
              q.destination,
              q.design_json
         FROM qr_registry r
         LEFT JOIN qr_codes q ON q.id = r.qr_code_id
        WHERE r.batch_id = ? AND r.owner_id = ?
        ORDER BY r.batch_sequence ASC`,
    )
    .bind(batchId, ownerId)
    .all<{
      registry_id: string;
      serial: string;
      short_code: string | null;
      destination: string | null;
      design_json: string;
    }>();
  return results ?? [];
}

/**
 * The permanent URL for a serial — what a batch QR encodes.
 *
 * Derived, never stored. See createBatch's note on why.
 */
export function dynamicUrlFor(appUrl: string, serial: string): string {
  return `${appUrl.replace(/\/+$/, "")}/q/${encodeURIComponent(serial)}`;
}
