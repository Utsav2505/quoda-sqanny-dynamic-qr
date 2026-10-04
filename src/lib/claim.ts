// The QR registration service: ONE implementation, two entry points.
//
// Section 31 of the spec asks for a single source of truth, and that is the
// whole reason this file exists. Both entry points below route through it:
//
//   Dashboard  -> "Claim a QR"        -> resolveQrPayload / resolveAsset / claimQr
//   Physical QR -> unconfigured scan  -> resolveQrPayload / resolveAsset / claimQr
//
// They differ only in where the serial came from and which view is rendered.
// Nothing about validation, ownership, or claiming is reimplemented per caller,
// so the two can never disagree about whether something is claimable.
//
// This layer decides nothing from the request. `viewerId` is always the
// authenticated user from the session, and `businessId` is re-checked against
// `business_members` inside the claim's own SQL.

import {
  claimAsset,
  deleteOrphanQr,
  dropSupersededQr,
  getAssetByIdentifier,
  getAssetViewByIdentifier,
  insertRegistrationQr,
  type QrAssetView,
} from "../db/qr-registry";
import {
  isQrCategory,
  normalizeIdentifier,
  resolveCategory,
  serialFromPayload,
  statusFor,
  validateDestination,
  validatePlacement,
  validateQrName,
  type QrCategory,
} from "./qr-registration";
import { ensureUniqueShortCode } from "./shortcode";
import { canCreateDynamic } from "./plans";

// ---------------------------------------------------------------------------
// Payload resolution
// ---------------------------------------------------------------------------

/**
 * Pull a serial out of whatever the camera or the user handed us.
 *
 * Accepts, in order of likelihood:
 *   - `SQ-8F2K9A`            a bare serial typed or printed on the stand
 *   - `sq-8f2k9a`            the same, re-typed in the wrong case
 *   - `.../q/SQ-8F2K9A`      the stand's own public URL, as a scanner returns it
 *   - `...?qr=SQ-8F2K9A`     the same URL with the serial as a parameter
 *
 * Returns null for anything that isn't a Sqanny serial. That is the whole
 * trust boundary: the camera is an untrusted input, so the serial is only ever
 * treated as a lookup key and the ownership answer always comes from the
 * database, never from the payload.
 */
/**
 * Kept as the service's public name, but the decode itself lives in the shared
 * domain lib so the camera island and the server cannot drift apart. The
 * scanner calls serialFromPayload directly (it is a client island and cannot
 * import this module); both end up in the same function.
 */
export function resolveQrPayload(raw: unknown): string | null {
  return serialFromPayload(raw);
}
// ---------------------------------------------------------------------------
// Resolution: what may this viewer do with this serial?
// ---------------------------------------------------------------------------

/**
 * The scan decision. Every field here is safe to show to the person holding the
 * phone — note there is deliberately NO owner identity in any branch, so a
 * scanner can never be made to disclose who owns a serial.
 */
export type AssetResolution =
  /** Not a Sqanny serial at all (wrong shape, or some other QR). */
  | { state: "not-a-sqanny-qr"; identifier: null }
  /** Well-formed serial, but not registered as one of our printed stands. */
  | { state: "unregistered"; identifier: string }
  /** Free to claim. Carries only what the public would see on the stand. */
  | { state: "claimable"; identifier: string }
  /** Already yours. `configured` decides between "finish setup" and "open it". */
  | { state: "yours"; identifier: string; asset: QrAssetView; configured: boolean }
  /** Someone else owns it. No owner details, by design. */
  | { state: "taken"; identifier: string }
  /** Retired. Not claimable by anyone, including its previous owner. */
  | { state: "archived"; identifier: string };

/**
 * Decide what the given viewer may do with a serial. This is the authoritative
 * answer — the scanner and the API both call it rather than judging for
 * themselves, which is what keeps the two entry points in agreement.
 *
 * `viewerId` is null for an anonymous visitor, who may learn only that a serial
 * is claimable, is unregistered, or is off-limits. They never learn who holds
 * an owned serial, and never see its configuration.
 */
export async function resolveAsset(
  db: D1Database,
  identifier: string,
  viewerId: string | null,
): Promise<AssetResolution> {
  const canonical = normalizeIdentifier(identifier);
  if (!canonical) return { state: "not-a-sqanny-qr", identifier: null };

  const asset = await getAssetViewByIdentifier(db, canonical);
  if (!asset) return { state: "unregistered", identifier: canonical };

  if (asset.status === "archived") {
    return { state: "archived", identifier: canonical };
  }

  if (asset.owner_id === null) {
    // Unclaimed. An anonymous visitor gets the same answer as a signed-in one:
    // knowing a stand is free is not sensitive, and the claim itself is gated.
    return { state: "claimable", identifier: canonical };
  }

  if (viewerId !== null && asset.owner_id === viewerId) {
    return {
      state: "yours",
      identifier: canonical,
      asset,
      configured: Boolean(asset.destination),
    };
  }

  // Owned by someone else, or owned-but-viewed anonymously. Identical response:
  // an anonymous visitor must not be able to distinguish "taken" from "private".
  return { state: "taken", identifier: canonical };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export interface ClaimInput {
  identifier: string;
  viewerId: string;
  businessId: string;
  name: string;
  category: string;
  customCategory?: string | null;
  placement?: string | null;
  destination: string;
}

export type ClaimErrors = Partial<Record<"name" | "category" | "destination" | "placement", string>>;

/** A claim that has passed validation: every optional field resolved, every
 *  value trimmed, the destination already normalised. This is the only shape
 *  that reaches the database, which is why it is spelled out rather than
 *  derived from the raw input type (where optionality would leak through). */
interface NormalizedClaim {
  identifier: string;
  businessId: string;
  name: string;
  category: QrCategory;
  customCategory: string | null;
  placement: string | null;
  destination: string;
}

export type ClaimResult =
  | { ok: true; asset: QrAssetView }
  | { ok: false; reason: "invalid" | "not-found" | "already-claimed" | "archived" | "business-forbidden" | "not-claimable" | "plan-limit" }
  | { ok: false; reason: "validation"; errors: ClaimErrors };

/**
 * Validate a submitted claim without touching the database.
 *
 * Split from claimQr so the review step and the failure path can show the exact
 * field error, and so the API can reject bad input with a 422 body the UI maps
 * straight onto fields.
 */
export function validateClaimInput(
  input: Omit<ClaimInput, "viewerId">,
): { clean: NormalizedClaim | null; errors: ClaimErrors } {
  const errors: ClaimErrors = {};

  const name = input.name.trim();
  const nameError = validateQrName(name);
  if (nameError) errors.name = nameError;

  if (!isQrCategory(input.category)) {
    errors.category = "Choose a category.";
  } else {
    const resolved = resolveCategory(input.category, input.customCategory ?? "");
    if (resolved.error) errors.category = resolved.error;
  }

  const placementError = validatePlacement(input.placement ?? "");
  if (placementError) errors.placement = placementError;

  const dest = validateDestination(input.destination ?? "");
  if (dest.error) errors.destination = dest.error;

  const categoryResolved = resolveCategory(input.category, input.customCategory ?? "");
  const placement = (input.placement ?? "").trim();

  if (Object.keys(errors).length) {
    return { clean: null, errors };
  }

  return {
    clean: {
      identifier: input.identifier,
      businessId: input.businessId,
      name,
      category: categoryResolved.category as QrCategory,
      customCategory: categoryResolved.customCategory ?? null,
      placement: placement || null,
      destination: dest.url as string,
    },
    errors,
  };
}

/**
 * Claim a stand.
 *
 * The two-step write (insert configuration, then compare-and-swap the registry
 * row) is deliberate. D1 offers batched statements, not interactive
 * transactions, and a conditional UPDATE needs its result before the next
 * statement can react to it. So the loser of a race compensates by deleting the
 * configuration row it optimistically created:
 *
 *   1. insert a configuration row in state 'registration' (invisible to every
 *      user-facing query, which all read through the registry join);
 *   2. one conditional UPDATE claims the registry row, re-verifying both that
 *      the stand is still free and that the caller belongs to the target
 *      business — see claimAsset() for the full WHERE clause;
 *   3. if that UPDATE matched nothing, delete the row from step 1 and report
 *      the precise reason.
 *
 * The alternative — a reservation state — would need its own expiry and a
 * reaper, and would leave stands stuck in limbo if the worker died mid-claim.
 * An orphaned configuration row is inert and reapable; a stuck reservation is
 * not. The registry's UNIQUE identifier and CHECK constraints mean no observer
 * ever sees the intermediate state.
 *
 * Re-entry by the same owner (resuming an interrupted setup) is the one case
 * where step 2 SUCCEEDS against a row that already had a configuration. Step 3
 * then does the opposite of a compensation: it deletes the row the registry has
 * just stopped pointing at, so a resumed claim does not leave a second live QR
 * behind that its owner can never see or manage.
 *
 * `planId` is checked here for the same reason the studio API checks it: a
 * physical stand is a dynamic QR like any other, and leaving claims ungated
 * would let a free account manufacture unlimited permanent codes through the
 * postbox rather than the front door.
 */
export async function claimQr(
  db: D1Database,
  input: ClaimInput,
  planId: string = "pro",
): Promise<ClaimResult> {
  const identifier = normalizeIdentifier(input.identifier);
  if (!identifier) return { ok: false, reason: "invalid" };

  const { clean, errors } = validateClaimInput(input);
  if (!clean) return { ok: false, reason: "validation", errors };

  if (!(await canCreateDynamic({ DB: db }, { id: input.viewerId, plan_id: planId }))) {
    return { ok: false, reason: "plan-limit" };
  }

  // Whatever configuration the registry is currently pointing at, so a resumed
  // claim can retire it once the swap succeeds. Captured BEFORE the insert, and
  // only for an asset this user already owns.
  const existing = await getAssetByIdentifier(db, identifier);
  const superseded =
    existing && existing.owner_id === input.viewerId ? existing.qr_code_id : null;

  const qrCodeId = crypto.randomUUID();

  // Mint the short code and insert the configuration in ONE retry loop. Splitting
  // them (draw a code, then insert) leaves a window in which two concurrent
  // claims pick the same code and the loser's INSERT raises a UNIQUE violation
  // mid-wizard; folding the insert into the loop turns that into a transparent
  // retry.
  let shortCode: string | null = null;
  try {
    shortCode = await ensureUniqueShortCode(db, 7, async (code) => {
      await insertRegistrationQr(db, {
        id: qrCodeId,
        ownerId: input.viewerId,
        businessId: clean.businessId,
        name: clean.name,
        category: clean.category,
        customCategory: clean.customCategory,
        placement: clean.placement,
        destination: clean.destination,
        shortCode: code,
      });
    });
  } catch (err) {
    // The short-code UNIQUE index is the one thing here that can legitimately
    // collide, and a raw SQLITE_CONSTRAINT would surface as a 500 on the last
    // step of the wizard. Say so instead.
    console.error("[claim] could not create the configuration row:", err);
    return { ok: false, reason: "not-claimable" };
  }

  const outcome = await claimAsset(db, {
    identifier,
    ownerId: input.viewerId,
    businessId: clean.businessId,
    qrCodeId,
    // A destination was required by validation, so this is always 'active' from
    // the customer flow. The branch exists so the service stays correct if a
    // future caller claims without one.
    status: statusFor(Boolean(clean.destination)),
  });

  if (!outcome.ok) {
    await deleteOrphanQr(db, qrCodeId);
    return { ok: false, reason: outcome.reason };
  }

  if (superseded && superseded !== qrCodeId) {
    await dropSupersededQr(db, superseded);
  }

  return { ok: true, asset: outcome.asset };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * User-facing messages for a failed claim live in ONE place: the flash table in
 * lib/flash.ts, which is also what the POST->redirect->GET round trip renders.
 *
 * This module used to carry a parallel CLAIM_FAILURE_COPY table alongside it. Two
 * tables describing the same eight failures is two things to keep in step, and the
 * drift had already happened — the reason→code mapping was duplicated in
 * routes/qrs.tsx a third time. Deleted rather than reconciled: the flash table is
 * the one the UI actually reads.
 *
 * Note what is deliberately NOT in any of them: no message interpolates an owner.
 * No outcome carries one, because a scanner is never entitled to learn who holds a
 * serial. "Someone else has it" is the whole message.
 */
