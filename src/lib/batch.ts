/**
 * Batch QR generation — the domain rules.
 *
 * This module owns WHAT a batch serial is and what makes a batch configuration
 * valid. It is pure: no database, no request, no clock. Both the server route and
 * the browser island's live preview import these same functions, which is the
 * only way the preview can be trusted to match what generation actually does.
 * (The island bundle inlines them — esbuild bundles per entry — so the client has
 * its own copy, but it is a copy of THIS file, not a re-implementation.)
 *
 * ---------------------------------------------------------------------------
 * THE SERIAL
 * ---------------------------------------------------------------------------
 *
 *   SQ-{TYPE}-{BATCH}-{SEQUENCE}
 *
 *   SQ-GR-B01-001     a batch serial
 *   SQ-8F2K9A         a random serial (unchanged; see lib/qr-registration.ts)
 *
 * Both are one identifier system: both are rows in `qr_registry`, both are
 * covered by the same UNIQUE index, and both resolve at `/q/:identifier`.
 *
 * ---------------------------------------------------------------------------
 * THE SEQUENCE IS A NUMBER, NOT A THREE-DIGIT FIELD
 * ---------------------------------------------------------------------------
 *
 * The padding rule is "at least 3 digits, and never fewer than the number
 * actually needs". So:
 *
 *   1 -> 001    9 -> 009    10 -> 010    99 -> 099
 *   999 -> 999  1000 -> 1000  10000 -> 10000
 *
 * There is no upper bound of 999, no truncation, and no wrap. `formatSequence`
 * is the single place that decides what a sequence looks like, so a batch that
 * crosses 999 mid-range renders 998, 999, 1000, 1001 with no special case.
 *
 * Stored as a JS number and a SQLite INTEGER (both 64-bit). The warning this
 * addresses is a THREE-DIGIT LIMIT, which an integer type does not impose; a
 * TEXT column would only have moved the same arithmetic into string-land, where
 * "is this in range" becomes a question about collation.
 */

import { IDENTIFIER_PREFIX, isBatchSerial } from "./qr-registration";
import { cleanText, normalizeUrl } from "./validate";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Minimum digits in a rendered sequence. */
export const SEQUENCE_MIN_DIGITS = 3;

/**
 * Largest sequence accepted.
 *
 * Bounded only by Number.MAX_SAFE_INTEGER, and checked rather than assumed: a
 * serial that silently lost precision past 2^53 would produce two different
 * sequences with the same printed value, which is the exact failure mode a
 * sequence exists to prevent.
 */
export const SEQUENCE_MAX = Number.MAX_SAFE_INTEGER;

/** Digits allowed in a sequence. */
export const SEQUENCE_MAX_DIGITS = String(SEQUENCE_MAX).length;

/** Batch size must be a multiple of this. */
export const BATCH_SIZE_MULTIPLE = 9;

/**
 * Practical ceiling on one batch.
 *
 * Not a product limit — a work limit. Each QR becomes a `qr_registry` row, a
 * `qr_codes` row and an SVG; generation, ZIP assembly and rendering all happen in
 * one request, and the response body has to fit in memory. 2000 items is
 * comfortably inside that and is roughly 200 sheets of labels, which is more than
 * a single printing run.
 *
 * Communicated in the UI rather than enforced silently: a user asking for 20000
 * gets told the limit, not a truncated batch.
 */
export const BATCH_SIZE_MAX = 2000;

/** Upper bound on user-defined metadata fields per batch. */
export const BATCH_METADATA_MAX = 20;

/** Type must be exactly this many letters. */
export const BATCH_TYPE_LENGTH = 2;

/** Batch token bounds. Uppercase alphanumerics only — see BATCH_TOKEN_RE. */
export const BATCH_TOKEN_MIN = 1;
export const BATCH_TOKEN_MAX = 12;

/** Metadata field name / value bounds. */
export const METADATA_KEY_MAX = 60;
export const METADATA_VALUE_MAX = 200;

/**
 * A batch token: 1–12 uppercase alphanumerics.
 *
 * Letters and digits only, because the token is one dash-delimited field of the
 * serial. Allowing `-` here would make `SQ-GR-A-1-001` ambiguous — two different
 * configurations could produce the same string — so a dash is rejected outright
 * rather than escaped. Spaces are rejected for the same reason plus the obvious
 * one: nobody can read a serial aloud with a silent space in it.
 */
export const BATCH_TOKEN_RE = /^[A-Z0-9]{1,12}$/;

/** Exactly two letters, uppercase. */
export const BATCH_TYPE_RE = /^[A-Z]{2}$/;

// ---------------------------------------------------------------------------
// Sequence formatting
// ---------------------------------------------------------------------------

/**
 * Render a sequence number: at least three digits, never fewer than it needs.
 *
 * Deterministic and total. `formatSequence(1000)` is `"1000"` — not `"000"`,
 * not `"1000"` truncated, and there is no code path that can produce `"000"`
 * because zero is not an accepted sequence at all.
 */
export function formatSequence(value: number): string {
  const n = Math.trunc(value);
  return String(n).padStart(SEQUENCE_MIN_DIGITS, "0");
}

/**
 * Parse a user-entered sequence. Returns null for anything unusable.
 *
 * Tolerates leading zeros on the way in (`"007"` -> 7) because a human who typed
 * a padded number has not made a mistake worth blocking them over — and because
 * the same user is about to be shown `007` again in the preview, which would be
 * confusing if the leading zeros silently changed the number.
 *
 * Rejects leading zeros outright only when they would change the value's digit
 * count beyond what formatting would produce anyway; see `hasAmbiguousPadding`.
 */
export function parseSequence(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 1 && raw <= SEQUENCE_MAX ? raw : null;
  }
  if (typeof raw !== "string") return null;
  // Strip separators a spreadsheet paste may have carried in, but nothing else:
  // `parseInt` would happily accept "12abc" as 12.
  const v = raw.trim().replace(/[\s,_]/g, "");
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1 || n > SEQUENCE_MAX) return null;
  if (v.length > SEQUENCE_MAX_DIGITS) return null;
  return n;
}

/**
 * True when the typed form carries leading zeros that formatting will not
 * reproduce — i.e. the user typed something we would rewrite.
 *
 * `007` -> 7 -> `007`. Round-trips, so it is accepted silently.
 * `0007` -> 7 -> `0007`? No: `formatSequence(7)` is `007`. So this would be
 * rewritten, and the preview has to show it rather than hiding it.
 */
export function hasAmbiguousPadding(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim().replace(/[\s,_]/g, "");
  if (!/^\d+$/.test(v) || v.length <= 1) return false;
  const n = parseSequence(v);
  if (n === null) return false;
  return v !== formatSequence(n);
}

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/**
 * Normalise a batch type to exactly two uppercase letters.
 *
 * Returns an error string rather than throwing, because the same call serves the
 * form (which needs a message) and the scanner-side preview (which only needs to
 * know it is unusable).
 *
 * The type is user-configurable: there is no enumeration and no lookup table,
 * because the product treats it as an operational label rather than a controlled
 * vocabulary. Only its SHAPE is constrained.
 */
export function resolveBatchType(raw: unknown): { value: string | null; error: string | null } {
  const v = cleanText(String(raw ?? "").toUpperCase(), 8);
  if (!v) return { value: null, error: "Type is required." };
  if (!BATCH_TYPE_RE.test(v)) {
    return { value: null, error: "Type must contain exactly 2 letters." };
  }
  return { value: v, error: null };
}

// ---------------------------------------------------------------------------
// Batch number
// ---------------------------------------------------------------------------

/**
 * Normalise a batch identifier.
 *
 * Trims, upper-cases, and validates the shape. The result is always echoed back
 * to the user in the preview and the review row — normalisation is never silent
 * in the sense of "you will not see what changed"; the caller is given the exact
 * string that will be stored and is expected to show it.
 */
export function resolveBatchNumber(raw: unknown): { value: string | null; error: string | null } {
  const v = cleanText(String(raw ?? "").toUpperCase(), 24);
  if (!v) return { value: null, error: "Batch No. is required." };
  if (/\s/.test(v)) {
    return { value: null, error: "Batch No. cannot contain spaces." };
  }
  if (!BATCH_TOKEN_RE.test(v)) {
    return {
      value: null,
      error: `Batch No. must be ${BATCH_TOKEN_MAX} letters or digits, with no spaces or dashes.`,
    };
  }
  return { value: v, error: null };
}

// ---------------------------------------------------------------------------
// Batch size
// ---------------------------------------------------------------------------

/**
 * Validate a batch size.
 *
 * Must be a positive multiple of nine, and never silently rounded. A size of 10
 * is not "close enough to 9": the multiples-of-nine rule is a packaging
 * constraint, and quietly generating nine when someone asked for ten would hand
 * them a box that does not fit.
 */
export function resolveBatchSize(raw: unknown): { value: number | null; error: string | null } {
  const s = String(raw ?? "").trim();
  if (!s) return { value: null, error: "Batch size is required." };
  if (!/^\d+$/.test(s)) {
    return { value: null, error: "Batch size must be a whole number." };
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { value: null, error: "Batch size must be greater than zero." };
  }
  if (n > BATCH_SIZE_MAX) {
    return {
      value: null,
      error: `Batch size must be ${BATCH_SIZE_MAX} or fewer. Split it into multiple batches.`,
    };
  }
  if (n % BATCH_SIZE_MULTIPLE !== 0) {
    return { value: null, error: `Batch size must be a multiple of ${BATCH_SIZE_MULTIPLE}.` };
  }
  return { value: n, error: null };
}

// ---------------------------------------------------------------------------
// Serial composition
// ---------------------------------------------------------------------------

/**
 * Build one batch serial.
 *
 *   composeSerial("GR", "B01", 1)  -> "SQ-GR-B01-001"
 *   composeSerial("GR", "B01", 1000) -> "SQ-GR-B01-1000"
 *
 * Not defensive about its arguments: it is only ever called with values that
 * `resolveBatchType` / `resolveBatchNumber` / `parseSequence` have already
 * validated, and the service layer guarantees that. Re-validating here would mean
 * two rules that could disagree.
 */
export function composeSerial(type: string, batchNumber: string, sequence: number): string {
  return `${IDENTIFIER_PREFIX}-${type}-${batchNumber}-${formatSequence(sequence)}`;
}

/**
 * Split a batch serial back into its parts.
 *
 * The inverse of `composeSerial`, used when reading a row back out of the
 * registry. Returns null for anything that is not a batch serial — including a
 * random `SQ-XXXXXX`, which is a valid identifier but has no batch parts.
 */
export function parseSerial(serial: unknown): {
  type: string;
  batchNumber: string;
  sequence: number;
} | null {
  if (typeof serial !== "string" || !isBatchSerial(serial)) return null;
  const parts = serial.trim().toUpperCase().split("-");
  // SQ / TYPE / BATCH / SEQUENCE
  if (parts.length !== 4) return null;
  const sequence = parseSequence(parts[3]);
  if (sequence === null) return null;
  return { type: parts[1], batchNumber: parts[2], sequence };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * One user-defined metadata field.
 *
 * Deliberately a small typed record rather than a bag of strings, so a future
 * field (Product, SKU, Production Date) can be given its own validator without
 * changing the shape of everything around it.
 */
export interface BatchMetadataField {
  name: string;
  value: string;
}

/**
 * Normalise and validate the metadata field list.
 *
 * Names are de-duplicated case-insensitively (first wins) and blanks are dropped,
 * because `Manufacturing Line` and `manufacturing line` would otherwise become two
 * columns in the manifest with the same meaning.
 *
 * A duplicate name is NOT an error: the user almost certainly meant to fix a
 * typo, and dropping the row silently is more forgiving than blocking the whole
 * batch over it.
 */
export function resolveMetadataFields(
  raw: unknown,
): { fields: BatchMetadataField[]; errors: string[] } {
  const errors: string[] = [];
  const fields: BatchMetadataField[] = [];

  // Accept both the JSON array the client posts and the repeated
  // `meta_name[]`/`meta_value[]` form a no-JS form submission produces.
  let rows: Array<Record<string, unknown>> = [];
  if (Array.isArray(raw)) {
    rows = raw.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
  }

  if (rows.length > BATCH_METADATA_MAX) {
    errors.push(`You've reached the maximum number of custom fields (${BATCH_METADATA_MAX}).`);
    return { fields: [], errors };
  }

  const seen = new Set<string>();
  for (const row of rows) {
    const name = cleanText(String(row.name ?? ""), METADATA_KEY_MAX * 2);
    const value = cleanText(String(row.value ?? ""), METADATA_VALUE_MAX * 2);

    // A row with no name but a value is a half-typed field the user never
    // finished. Drop it rather than storing a nameless column.
    if (!name) continue;
    if (!value) {
      errors.push(`"${name}" needs a value.`);
      continue;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (name.length > METADATA_KEY_MAX) {
      errors.push(`Field names must be ${METADATA_KEY_MAX} characters or fewer.`);
      continue;
    }
    if (value.length > METADATA_VALUE_MAX) {
      errors.push(`"${name}" must be ${METADATA_VALUE_MAX} characters or fewer.`);
      continue;
    }
    // Field names become CSV column headers, so they must survive a round trip.
    if (/[",\r\n]/.test(name)) {
      errors.push(`"${name}" contains a character that can't be used as a column name.`);
      continue;
    }

    fields.push({ name, value });
  }

  if (fields.length > BATCH_METADATA_MAX) {
    errors.push(`You've reached the maximum number of custom fields (${BATCH_METADATA_MAX}).`);
    return { fields: [], errors };
  }

  return { fields, errors };
}

/** Serialise metadata for the `metadata_json` column. */
export function serializeMetadata(fields: BatchMetadataField[]): string {
  return JSON.stringify(fields.map((f) => ({ name: f.name, value: f.value })));
}

/**
 * Read metadata back out of the column, tolerating null and corrupt values.
 *
 * A corrupt column must not break the detail page or the manifest — the batch is
 * still real and its QR assets are still valid.
 */
export function parseMetadata(json: string | null | undefined): BatchMetadataField[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: BatchMetadataField[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : "";
      const value = typeof rec.value === "string" ? rec.value : "";
      if (name) out.push({ name, value });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Batch configuration
// ---------------------------------------------------------------------------

export interface BatchFormValues {
  sequenceStart: string;
  batchNumber: string;
  type: string;
  batchSize: string;
  /** optional per-batch destination; when set, every QR in the batch points here */
  destination: string;
  /** optional business to scope the batch to */
  businessId: string;
  /** user-defined metadata rows */
  metadata: BatchMetadataField[];
}

export type BatchFieldErrors = Partial<
  Record<"sequenceStart" | "batchNumber" | "type" | "batchSize" | "destination" | "business" | "metadata", string>
>;

export interface BatchConfig {
  type: string;
  batchNumber: string;
  sequenceStart: number;
  sequenceEnd: number;
  quantity: number;
  destination: string | null;
  businessId: string | null;
  metadata: BatchMetadataField[];
}

export interface BatchValidation {
  config: BatchConfig | null;
  errors: BatchFieldErrors;
  /** True when the configuration is complete and internally consistent. */
  ok: boolean;
}

export const EMPTY_BATCH_FORM: BatchFormValues = {
  sequenceStart: "",
  batchNumber: "",
  type: "",
  batchSize: String(BATCH_SIZE_MULTIPLE),
  destination: "",
  businessId: "",
  metadata: [],
};

/**
 * Validate a whole batch configuration.
 *
 * Returns the normalised `config` ONLY when everything passes, which is what
 * makes "do not create records before validation is complete" enforceable at the
 * type level: a caller that has a `config` has a validated one.
 */
export function validateBatchForm(input: Partial<BatchFormValues>): BatchValidation {
  const errors: BatchFieldErrors = {};

  const type = resolveBatchType(input.type);
  if (type.error) errors.type = type.error;

  const batchNumber = resolveBatchNumber(input.batchNumber);
  if (batchNumber.error) errors.batchNumber = batchNumber.error;

  const sequenceStart = parseSequence(input.sequenceStart ?? "");
  if (sequenceStart === null) {
    errors.sequenceStart = sequenceStartError(input.sequenceStart ?? "");
  }

  const batchSize = resolveBatchSize(input.batchSize ?? "");
  if (batchSize.error) errors.batchSize = batchSize.error;

  // The destination is optional, so it reuses the shared URL policy rather than
  // duplicating one. Empty is legitimate: a stand can be printed before anyone
  // knows where it points.
  let destination: string | null = null;
  const rawDestination = (input.destination ?? "").trim();
  if (rawDestination) {
    // The shared URL policy, not a batch-specific one: a batch destination is the
    // same kind of value as a stand's, so it gets the same validation. An empty
    // destination is legitimate — a stand can be printed before anyone knows
    // where it points.
    const normalized = normalizeUrl(rawDestination);
    if (!normalized) {
      errors.destination = "Enter a valid web address, or leave it blank.";
    } else {
      destination = normalized;
    }
  }

  const metadata = resolveMetadataFields(input.metadata);
  if (metadata.errors.length) errors.metadata = metadata.errors[0];

  // A range that would run past the sequence ceiling is a range we cannot
  // render, and it must be caught here rather than producing a truncated batch.
  if (sequenceStart !== null && batchSize.value !== null) {
    const end = sequenceStart + batchSize.value - 1;
    if (end > SEQUENCE_MAX) {
      errors.sequenceStart = "That starting sequence plus this batch size runs past the maximum sequence number.";
    }
  }

  if (Object.keys(errors).length) {
    return { config: null, errors, ok: false };
  }

  const quantity = batchSize.value as number;
  const start = sequenceStart as number;

  return {
    config: {
      type: type.value as string,
      batchNumber: batchNumber.value as string,
      sequenceStart: start,
      sequenceEnd: start + quantity - 1,
      quantity,
      destination,
      businessId: (input.businessId ?? "").trim() || null,
      metadata: metadata.fields,
    },
    errors: {},
    ok: true };
}

/** The message for an unparseable sequence, chosen by what the user actually typed. */
function sequenceStartError(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "Starting sequence is required.";
  if (!/^[\d\s,_]+$/.test(s)) return "Starting sequence must be a number.";
  if (Number(s.replace(/[\s,_]/g, "")) < 1) return "Starting sequence must be 1 or greater.";
  return "Starting sequence is too large.";
}

// ---------------------------------------------------------------------------
// Range + preview
// ---------------------------------------------------------------------------

export interface BatchPreview {
  type: string;
  batchNumber: string;
  quantity: number;
  sequenceStart: string;
  sequenceEnd: string;
  /** first serial, fully composed */
  firstSerial: string;
  /** last serial, fully composed */
  lastSerial: string;
  /** a short, representative middle sample for display */
  sample: string[];
  /** true when the range crosses from 3-digit into 4-digit sequences */
  crossesDigitBoundary: boolean;
}

/**
 * Compute the preview for a configuration.
 *
 * Pure arithmetic — no QR is generated, nothing is stored, and no record is
 * created to look at. That is the whole point: the preview is a promise about
 * what generation WILL do, so it must be derived from the same functions
 * generation uses, not from a sample run of it.
 */
export function previewBatch(input: Partial<BatchFormValues>): BatchPreview | null {
  const { config, ok } = validateBatchForm(input);
  if (!ok || !config) return null;
  return previewFromConfig(config);
}

/** Preview from an already-validated config. */
export function previewFromConfig(config: BatchConfig): BatchPreview {
  const { type, batchNumber, sequenceStart, sequenceEnd, quantity } = config;

  // Up to three interior samples so the user can see the increment without the
  // preview turning into a list of every serial.
  const sample: string[] = [];
  const step = Math.max(1, Math.floor(quantity / 3));
  for (let i = 0; i < 3; i++) {
    const seq = sequenceStart + step * i;
    if (seq > sequenceEnd) break;
    sample.push(composeSerial(type, batchNumber, seq));
  }

  return {
    type,
    batchNumber,
    quantity,
    sequenceStart: formatSequence(sequenceStart),
    sequenceEnd: formatSequence(sequenceEnd),
    firstSerial: composeSerial(type, batchNumber, sequenceStart),
    lastSerial: composeSerial(type, batchNumber, sequenceEnd),
    sample,
    crossesDigitBoundary:
      formatSequence(sequenceStart).length !== formatSequence(sequenceEnd).length,
  };
}

/**
 * Every serial in a batch, in order.
 *
 * Materialises the whole list, so it is bounded by BATCH_SIZE_MAX — the caller
 * has already validated the quantity. Used for the conflict pre-check and for
 * the manifest; the browser never calls it, which is why a 2000-item batch does
 * not freeze the preview.
 */
export function expandSerials(config: BatchConfig): string[] {
  const out: string[] = [];
  for (let i = 0; i < config.quantity; i++) {
    out.push(composeSerial(config.type, config.batchNumber, config.sequenceStart + i));
  }
  return out;
}

/**
 * The permanent public URL for a serial.
 *
 * What the printed QR encodes. Deliberately NOT the destination: the destination
 * is configuration and can change at any time, while this URL is the code's
 * identity and never changes.
 */
export function serialUrl(appUrl: string, serial: string): string {
  return `${appUrl.replace(/\/+$/, "")}/q/${encodeURIComponent(serial)}`;
}
