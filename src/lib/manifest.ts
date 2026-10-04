/**
 * The batch manifest: an inventory CSV that travels with the QR assets.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN IT, AND WHY
 * ---------------------------------------------------------------------------
 * Inventory columns are the ones needed to answer "which physical code is this,
 * where does it point, and when did we make it" — serial, id, type, batch,
 * sequence, dynamic URL, destination, status, created-at. Custom batch metadata
 * is appended as extra columns, because a printer or an operator opening the
 * manifest is exactly who needs "Manufacturing Line = L02" next to the serial.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT IN IT
 * ---------------------------------------------------------------------------
 * No owner name, no email, no phone, no business address, no avatar, no scan
 * analytics. The archive is handed to whoever prints and ships the labels, so it
 * leaves the system: an inventory sheet has no need for account data, and
 * including it would turn a file that circulates through a print shop into a
 * copy of the customer database.
 *
 * The destination URL is included because the manifest's whole purpose is to
 * document what each label currently resolves to. If a destination were
 * considered sensitive, the correct fix is to not put it in the QR — not to
 * silently omit it from an inventory file and leave the sheet unable to explain
 * itself.
 *
 * ---------------------------------------------------------------------------
 * CSV CORRECTNESS
 * ---------------------------------------------------------------------------
 * RFC 4180 quoting: a field containing a comma, a double quote, CR or LF is
 * wrapped in double quotes, and an embedded quote is doubled. Metadata values
 * are free text typed by the user, so they will eventually contain a comma —
 * an unquoted value there silently shifts every column after it on that row,
 * which is the classic way an inventory file becomes untrustworthy.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a tab. This is the CSV
 * injection guard: a spreadsheet treats `=HYPERLINK(...)` as a formula, and a
 * manifest is exactly the kind of file someone opens by double-clicking.
 */

import type { BatchMetadataField } from "./batch";

export const MANIFEST_COLUMNS = [
  "serial_number",
  "qr_id",
  "type",
  "batch_number",
  "sequence",
  "dynamic_url",
  "destination_url",
  "status",
  "created_at",
] as const;

export interface ManifestRow {
  serial_number: string;
  qr_id: string;
  type: string;
  batch_number: string;
  sequence: string;
  dynamic_url: string;
  destination_url: string;
  status: string;
  created_at: string;
}

/** ISO-8601 UTC, which sorts lexicographically and parses everywhere. */
export function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Quote one CSV field.
 *
 * Exported for tests, because the quoting rules are the part of this file most
 * likely to be broken by an innocuous-looking edit and the part hardest to
 * eyeball in the output.
 */
export function csvField(value: unknown): string {
  let s = value == null ? "" : String(value);

  // Formula-injection guard. A tab prefix keeps the text visible and neutralises
  // the leading sigil for spreadsheet parsers.
  if (/^[=+\-@\t\r]/.test(s)) s = `\t${s}`;

  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Join one CSV row. */
export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(",");
}

/**
 * Build the manifest.
 *
 * `metadata` supplies the extra columns; they are placed AFTER the fixed
 * inventory columns so the leading columns are identical across every batch,
 * which is what lets a downstream script read the file without knowing which
 * custom fields a particular run used.
 */
export function buildManifest(
  rows: ManifestRow[],
  metadata: BatchMetadataField[] = [],
): string {
  const extraColumns = metadata.map((m) => m.name);
  const header = csvRow([...MANIFEST_COLUMNS, ...extraColumns]);

  const lines = [header];
  for (const row of rows) {
    lines.push(
      csvRow([
        row.serial_number,
        row.qr_id,
        row.type,
        row.batch_number,
        row.sequence,
        row.dynamic_url,
        row.destination_url,
        row.status,
        row.created_at,
        // One value per metadata column, blank where a QR carries none. Every
        // QR in a batch shares its metadata, so in practice these are uniform —
        // emitted per row anyway so the file stays valid if that ever changes.
        ...metadata.map((m) => m.value),
      ]),
    );
  }

  // Trailing CRLF: RFC 4180 specifies CRLF, and a missing final newline makes
  // some parsers drop the last row.
  return `${lines.join("\r\n")}\r\n`;
}
