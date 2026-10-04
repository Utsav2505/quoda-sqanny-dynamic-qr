// Sqanny QR registration domain: identity, categorisation, lifecycle.
//
// This module is the single source of truth for WHAT a registration QR is. The
// claim service, the API routes, the scanner and the management pages all read
// these definitions rather than restating them, so a category added here shows
// up everywhere at once.

import { cleanText, LIMITS, normalizeUrl, orNull } from "./validate";

// ---------------------------------------------------------------------------
// Physical identity
// ---------------------------------------------------------------------------

/**
 * The glyphs used in a printed serial: no 0/O, 1/I/L, or U.
 *
 * This is a physical product. A serial gets read aloud over the phone, typed
 * into a support chat, and re-keyed from a sticker in bad light, so the glyphs
 * that people reliably confuse with each other are excluded outright rather
 * than merely discouraged. That leaves 30 symbols (8 digits + 22 letters), not
 * a power of two — which is why generation below rejects instead of masking.
 */
const SERIAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export const IDENTIFIER_PREFIX = "SQ";
/**
 * `SQ-` + 6 glyphs, matching the format printed on the stand
 * (`SQ-8F2K9A`). Six base-30 symbols is ~590M serials, and the UNIQUE index
 * makes even a collision a caught error rather than a silent overwrite.
 */
export const IDENTIFIER_LENGTH = 6;

/**
 * The random-serial shape: `SQ-XXXXXX`.
 *
 * One of TWO accepted identifier shapes. The other is a batch serial,
 * `SQ-<TYPE>-<BATCH>-<SEQUENCE>`, built by lib/batch.ts. Both resolve at
 * `/q/:identifier` and both are covered by the same UNIQUE index on
 * `qr_registry.qr_identifier`, so a batch serial can never collide with a
 * random one.
 *
 * They are one identifier system, not two: everything downstream (ownership,
 * archive lifecycle, regeneration, the destination redirect) reads
 * `qr_registry` and does not know or care which shape produced the row.
 */
const IDENTIFIER_RE = new RegExp(
  `^${IDENTIFIER_PREFIX}-[${SERIAL_ALPHABET}]{${IDENTIFIER_LENGTH}}$`,
  "i",
);

/**
 * The batch-serial shape, mirrored from lib/batch.ts and kept permissive here.
 *
 * `normalizeIdentifier` is a TRUST BOUNDARY — it is what decides whether a
 * scanned payload or a URL path segment is a serial we issued. Being too strict
 * rejects a legitimate stand; being too loose lets arbitrary text through as an
 * identifier. So this only checks the SHAPE and defers the segment semantics to
 * `isBatchSerial`, which is where BATCH_TOKEN_RE and the sequence rule live.
 *
 *   SQ-GR-B01-001
 *   SQ-FB-JAN01-1000
 *
 * Sequence is `\d{1,12}` — deliberately not bounded at three digits. A batch that
 * runs past 999 must produce 1000, 1001, … with no truncation and no wrap.
 *
 * `(?!0+$)` rejects an all-zero sequence. We never issue `SQ-GR-B01-000`, and
 * without this the two halves of the system disagree: `parseSequence("000")`
 * returns null (0 is not a sequence) while this regex would happily accept the
 * string. An identifier that cannot be composed is an identifier the rest of the
 * code has no answer for.
 */
const BATCH_IDENTIFIER_RE = new RegExp(
  `^${IDENTIFIER_PREFIX}-([A-Z]{2})-([A-Z0-9]{1,12})-((?!0+$)\\d{1,12})$`,
  "i",
);

/**
 * Whether a string is a batch serial rather than a random one.
 *
 * A single source of truth for "what shape is this?" so the route that serves
 * `/q/:serial`, the batch service, and the claim scanner cannot disagree.
 */
export function isBatchSerial(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return BATCH_IDENTIFIER_RE.test(value.trim());
}

/**
 * Generate a serial, uniformly.
 *
 * The alphabet is 30 long, so `byte % 30` would make the first 16 glyphs
 * measurably more likely than the last 14. Instead draw bytes and reject any
 * that fall in the ragged tail of the range (>= 240), which leaves exactly 8
 * complete cycles of 30 and every glyph equally likely.
 */
export function generateIdentifier(): string {
  const limit = Math.floor(256 / SERIAL_ALPHABET.length) * SERIAL_ALPHABET.length; // 240
  const buf = new Uint8Array(IDENTIFIER_LENGTH * 2);
  let out = "";
  while (out.length < IDENTIFIER_LENGTH) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < IDENTIFIER_LENGTH; i++) {
      if (buf[i] < limit) out += SERIAL_ALPHABET[buf[i] % SERIAL_ALPHABET.length];
    }
  }
  return `${IDENTIFIER_PREFIX}-${out}`;
}

/**
 * Canonicalise a user-typed or scanned serial, or null if it isn't one.
 *
 * Accepts BOTH accepted shapes and returns the canonical UPPERCASE form, so
 * `sq-gr-b01-001` typed by hand in the wrong case is accepted rather than
 * rejected as "not a valid QR" — and, more importantly, is canonicalised to the
 * exact string the registry stores, so a case-sensitive lookup still finds it.
 */
export function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = cleanText(value.toUpperCase(), 64);
  if (IDENTIFIER_RE.test(v)) return v;
  if (BATCH_IDENTIFIER_RE.test(v)) return v;
  return null;
}

export function isIdentifier(value: unknown): boolean {
  return normalizeIdentifier(value) !== null;
}

/**
 * Extract a stand's serial from whatever a scanner actually decoded.
 *
 * A stand prints either a bare serial or a URL containing it, so both are
 * accepted. The camera is an UNTRUSTED input: this only ever produces a lookup
 * key. Whether the code exists, and who owns it, is always answered by the
 * database — never by the payload.
 *
 * This lives in the shared domain lib, not in the scanner island, on purpose.
 * The camera uses it to decide whether a frame is worth submitting, and the
 * server uses it to decide whether that submission is a real serial. If those
 * were two copies, they would eventually disagree and the camera would either
 * submit junk or silently drop a valid code.
 *
 * Returns null for anything that is not a Sqanny serial.
 */
export function serialFromPayload(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 512) return null;

  // Bare serial, the common case for manual entry.
  const direct = normalizeIdentifier(v);
  if (direct) return direct;

  // A URL: read the serial out of the path or the query string rather than
  // trusting any other part of it. Only http(s) and site-absolute paths are
  // considered, so arbitrary text cannot be coerced into a URL and mined for a
  // substring.
  if (!/^https?:\/\//i.test(v) && !v.startsWith("/")) return null;
  let parsed: URL;
  try {
    parsed = new URL(v, "https://sqanny.invalid");
  } catch {
    return null;
  }

  const fromQuery = parsed.searchParams.get("qr") ?? parsed.searchParams.get("id");
  if (fromQuery) return normalizeIdentifier(fromQuery);

  // `/q/SQ-8F2K9A` - the segment after the mount point.
  for (const seg of parsed.pathname.split("/")) {
    const hit = normalizeIdentifier(seg);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * What a customer is meant to DO when they scan.
 *
 * Deliberately not the legacy `qr_codes.type` column: `type` says what the code
 * renders (url / text / wifi) and is constrained by the encoder. This says what
 * the QR is FOR at a location, which is the thing a business owner actually
 * chooses when they have twenty physical stands to distribute. Pinning every
 * stand to "Google review" is what made the old flow feel like a dead end.
 */
export const QR_CATEGORIES = {
  reviews: { label: "Reviews", hint: "Send customers to a Google or review page." },
  feedback: { label: "Customer Feedback", hint: "Collect ratings or comments." },
  menu: { label: "Menu", hint: "Show a menu, price list, or catalogue." },
  website: { label: "Website", hint: "Send customers to any web page." },
  contact: { label: "Contact", hint: "Phone, email, or a contact page." },
  whatsapp: { label: "WhatsApp", hint: "Open a WhatsApp chat." },
  social: { label: "Social Media", hint: "Instagram, LinkedIn, or another profile." },
  offers: { label: "Offers", hint: "Promotions, coupons, or a campaign." },
  booking: { label: "Booking", hint: "Reservations, appointments, or ordering." },
  custom: { label: "Custom", hint: "Anything else — describe it below." },
} as const;

export type QrCategory = keyof typeof QR_CATEGORIES;

/** The stored key for a free-text category, alongside the controlled ones. */
export const CUSTOM_CATEGORY = "custom";

export function isQrCategory(value: unknown): value is QrCategory {
  return typeof value === "string" && value in QR_CATEGORIES;
}

export const QR_CATEGORY_KEYS = Object.keys(QR_CATEGORIES) as QrCategory[];

/** Options for a <select>, in the order a business owner would pick them. */
export function categoryOptions(): Array<{ value: string; label: string; hint: string }> {
  return QR_CATEGORY_KEYS.map((k) => ({
    value: k,
    label: QR_CATEGORIES[k].label,
    hint: QR_CATEGORIES[k].hint,
  }));
}

/**
 * Resolve a submitted category into what gets stored.
 *
 * Mirrors the `custom_category` rule already used for businesses: a hidden or
 * tampered field must not be able to smuggle a value into a column the UI says
 * is a controlled key. Any key other than `custom` therefore discards the free
 * text rather than storing it beside a category that already has a name.
 */
export function resolveCategory(
  raw: string,
  customText: string,
): { category: QrCategory; customCategory: string | null; error: string | null } {
  const key = raw.trim().toLowerCase();
  if (!key) return { category: "custom", customCategory: null, error: "Choose a category." };
  if (!isQrCategory(key)) {
    return { category: "custom", customCategory: null, error: "Choose a valid category." };
  }
  if (key !== CUSTOM_CATEGORY) {
    return { category: key, customCategory: null, error: null };
  }
  const custom = cleanText(customText, LIMITS.customCategory);
  if (!custom) {
    return {
      category: CUSTOM_CATEGORY,
      customCategory: null,
      error: "Describe the category so it can be told apart later.",
    };
  }
  return { category: CUSTOM_CATEGORY, customCategory: custom, error: null };
}

/** Human label for a stored (category, custom_category) pair. */
export function categoryLabel(category: string | null, custom: string | null): string {
  if (!category) return "Uncategorised";
  if (category === CUSTOM_CATEGORY) return custom || "Custom";
  return QR_CATEGORIES[category as QrCategory]?.label ?? "Uncategorised";
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The registration lifecycle.
 *
 * `unclaimed` -> a printed stand nobody owns yet.
 * `claimed`   -> owned and attached to a business, but not yet serving a
 *                destination. Reachable through the service (an operator can
 *                attach a stand to a business before the URL is agreed) and
 *                never produced by the customer flow, which requires a
 *                destination and therefore lands on `active`.
 * `active`    -> claimed, with a destination every scan is redirected to.
 * `archived`  -> retired. The row, its owner, its business and its scan history
 *                all stay; only serving stops. Archiving never releases the
 *                claim, so an archived stand cannot be taken by another account.
 */
export const QR_STATUSES = ["unclaimed", "claimed", "active", "archived"] as const;
export type QrStatus = (typeof QR_STATUSES)[number];

export function isQrStatus(value: unknown): value is QrStatus {
  return typeof value === "string" && (QR_STATUSES as readonly string[]).includes(value);
}

/** The status a claim should land in, given whether a destination was supplied. */
export function statusFor(hasDestination: boolean): QrStatus {
  return hasDestination ? "active" : "claimed";
}

export const QR_STATUS_LABELS: Record<QrStatus, string> = {
  unclaimed: "Unclaimed",
  claimed: "Setup pending",
  active: "Active",
  archived: "Archived",
};

// There is deliberately no exported `isClaimable(status, ownerId, viewerId)`
// helper here. A second answer to "may this viewer claim this?" is exactly how
// the two entry points start disagreeing, and the authoritative one is already
// computed from the database row by resolveAsset() in lib/claim.ts. If you need
// that answer, call it — do not re-derive it from these columns.

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

export const QR_PLACEMENT_MAX = 60;
export const QR_NAME_MAX = 60;

/**
 * Validate a destination for a registration QR.
 *
 * `normalizeUrl` already applies the project's rules (https preference, host
 * required, http/https only), so this only adds the "required" framing the
 * claim flow needs and returns the normalised value the caller should store.
 *
 * Returning the normalised string matters for the whole point of the feature:
 * the destination is configuration, so `google.com/maps/x` becomes
 * `https://google.com/maps/x` once, here, and is never touched again. The
 * serial in section 15 is what stays fixed.
 */
export function validateDestination(raw: string): { url: string | null; error: string | null } {
  const v = raw.trim();
  if (!v) return { url: null, error: "Enter a destination URL." };
  const normalized = normalizeUrl(v);
  if (!normalized) return { url: null, error: "Enter a valid URL." };
  return { url: normalized, error: null };
}

/** A short, honest rendering of a destination for review/recap rows. */
export function destinationLabel(url: string | null): string {
  if (!url) return "Not configured";
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Placement examples, offered as datalist hints rather than a hard enum. */
export const PLACEMENT_SUGGESTIONS = [
  "Reception",
  "Counter",
  "Entrance",
  "Cash Desk",
  "Billing Counter",
  "Table 01",
  "Room 101",
  "Waiting Area",
];

/**
 * Validate the free-text QR name ("Counter", "Table 04").
 *
 * The length check runs on the value BEFORE `cleanText` truncates it. Truncating
 * first makes the check unreachable — `cleanText(v, 60)` is at most 60
 * characters, so `v.length > 60` can never be true and an over-long name is
 * silently accepted (and then silently shortened on the way to the database,
 * which is worse than being told).
 */
export function validateQrName(value: string): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length > QR_NAME_MAX) {
    return `Name must be ${QR_NAME_MAX} characters or fewer.`;
  }
  const v = cleanText(raw, QR_NAME_MAX);
  if (!v) return "Give this QR a name so you can tell it apart later.";
  return null;
}

/** As validateQrName: length checked before truncation, for the same reason. */
export function validatePlacement(value: string): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length > QR_PLACEMENT_MAX) {
    return `Placement must be ${QR_PLACEMENT_MAX} characters or fewer.`;
  }
  return null;
}

/** Persisted value for optional free text: empty becomes NULL, never "". */
export function optionalText(value: string, max: number): string | null {
  return orNull(cleanText(value, max));
}
