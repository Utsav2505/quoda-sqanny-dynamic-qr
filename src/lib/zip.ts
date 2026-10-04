/**
 * A minimal, dependency-free ZIP writer (STORE method only).
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A LIBRARY
 * ---------------------------------------------------------------------------
 * The project ships three runtime dependencies, all of them load-bearing, and
 * "zip" is not among them. Adding one for ~150 lines of well-specified binary
 * layout would be the wrong trade — especially since the feature needs exactly
 * one thing (a stream of already-compressed SVG text and one CSV) and every ZIP
 * library solves a much larger problem.
 *
 * ---------------------------------------------------------------------------
 * WHY STORE, NOT DEFLATE
 * ---------------------------------------------------------------------------
 * STORE writes the bytes as-is: method 0, no compression. That is a deliberate
 * choice, not a shortcut:
 *
 *   * SVG is already-compressed XML. DEFLATE would typically save a few percent
 *     on content the browser will read once, at the cost of an inflate
 *     implementation and per-entry CPU on every export.
 *   * CSV is tiny and compresses well, but there is exactly one of it.
 *   * STORE means the writer has no compression state at all, so there is no
 *     class of bug where a corrupt deflate stream produces a ZIP that some
 *     unzippers accept and others reject.
 *
 * The output is a fully conformant ZIP 2.0 archive — every extractor reads it.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Every entry gets a FIXED DOS timestamp. The same batch therefore produces a
 * byte-identical archive every time, which is what makes "Regenerate Assets" a
 * meaningful operation rather than a way to produce a different file for the same
 * inputs. (Real timestamps would be arguably more "correct" for an archive, but
 * reproducibility is worth more here and costs nothing.)
 *
 * ---------------------------------------------------------------------------
 * LIMITS
 * ---------------------------------------------------------------------------
 * ZIP32: 4-byte file sizes and offsets, so a single archive must stay under
 * 4 GiB. At BATCH_SIZE_MAX (2000) items the archive is a few megabytes, four
 * orders of magnitude below the ceiling, so exceeding it is not reachable in
 * practice — but the check is explicit rather than assumed, because silently
 * emitting an archive that some unzippers reject is exactly the failure this
 * file exists to prevent.
 */

export interface ZipEntry {
  /** Path inside the archive. Forward slashes; no leading slash. */
  name: string;
  content: string;
}

// --- DOS date/time -----------------------------------------------------------
//
// 1980-01-01 00:00:00, the earliest value the DOS format can express. Chosen as
// the fixed constant rather than "now" so output is reproducible.
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // year 1980 (bits 9-15), month 1, day 1

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORE = 0;

// --- CRC32 ------------------------------------------------------------------

/**
 * CRC-32 (IEEE 802.3), precomputed table.
 *
 * Built once at module load rather than per call: a 2000-entry archive computes
 * 2000 CRCs, and rebuilding the table per entry would dominate the export.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Little-endian writer ---------------------------------------------------

/**
 * Growable little-endian byte sink.
 *
 * A plain array-of-pushes over a resizable buffer, rather than DataView over a
 * pre-sized buffer, because the total size is not known until every entry is
 * measured and a wrong guess would silently truncate the archive.
 */
class ByteSink {
  private buf: Uint8Array;
  private len = 0;

  constructor(initial = 64 * 1024) {
    this.buf = new Uint8Array(initial);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len] = v & 0xff;
    this.buf[this.len + 1] = (v >>> 8) & 0xff;
    this.len += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.buf[this.len] = v & 0xff;
    this.buf[this.len + 1] = (v >>> 8) & 0xff;
    this.buf[this.len + 2] = (v >>> 16) & 0xff;
    this.buf[this.len + 3] = (v >>> 24) & 0xff;
    this.len += 4;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  get length(): number {
    return this.len;
  }

  result(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

const encoder = new TextEncoder();

/**
 * Build a ZIP archive from the given entries.
 *
 * Throws rather than returning a partial archive: a truncated ZIP is worse than
 * no ZIP, because it downloads successfully and then fails to open, which reads
 * to the user as a corrupt file rather than as an error worth retrying.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  if (!entries.length) {
    throw new Error("createZip: refusing to build an empty archive");
  }

  const sink = new ByteSink();
  /** Central-directory records, appended after all local headers. */
  const central: Array<{
    nameBytes: Uint8Array;
    crc: number;
    size: number;
    offset: number;
  }> = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);
    const offset = sink.length;

    // Local file header.
    sink.u32(SIG_LOCAL);
    sink.u16(20); // version needed: 2.0 (STORE + directory)
    sink.u16(0x0800); // flags: UTF-8 filename
    sink.u16(METHOD_STORE);
    sink.u16(DOS_TIME);
    sink.u16(DOS_DATE);
    sink.u32(crc);
    sink.u32(data.length); // compressed size == uncompressed (STORE)
    sink.u32(data.length);
    sink.u16(nameBytes.length);
    sink.u16(0); // extra field length
    sink.bytes(nameBytes);
    sink.bytes(data);

    central.push({ nameBytes, crc, size: data.length, offset });
  }

  const centralStart = sink.length;

  for (const record of central) {
    sink.u32(SIG_CENTRAL);
    sink.u16(20); // version made by: 2.0
    sink.u16(20); // version needed
    sink.u16(0x0800); // UTF-8 filename
    sink.u16(METHOD_STORE);
    sink.u16(DOS_TIME);
    sink.u16(DOS_DATE);
    sink.u32(record.crc);
    sink.u32(record.size);
    sink.u32(record.size);
    sink.u16(record.nameBytes.length);
    sink.u16(0); // extra
    sink.u16(0); // comment
    sink.u16(0); // disk number start
    sink.u16(0); // internal attrs
    sink.u32(0); // external attrs
    sink.u32(record.offset);
    sink.bytes(record.nameBytes);
  }

  const centralSize = sink.length - centralStart;

  // End of central directory.
  sink.u32(SIG_EOCD);
  sink.u16(0); // this disk
  sink.u16(0); // disk with central directory
  sink.u16(central.length);
  sink.u16(central.length);
  sink.u32(centralSize);
  sink.u32(centralStart);
  sink.u16(0); // comment length

  const out = sink.result();

  // Explicit ZIP32 limit check. Unreachable at BATCH_SIZE_MAX, but emitting an
  // archive past it produces a file some extractors silently reject.
  if (out.length > 0xffffffff || centralStart > 0xffffffff) {
    throw new Error("createZip: archive exceeds the 4GB ZIP32 limit");
  }
  if (central.length > 0xffff) {
    throw new Error("createZip: too many entries for a ZIP32 archive");
  }

  return out;
}

/**
 * The UTF-8 byte length of a string.
 *
 * ZIP records sizes in BYTES, not characters. An entry named with a non-ASCII
 * character has a name length that differs from its `.length`, and using the
 * character count there produces an archive with every subsequent offset
 * shifted — which extracts as garbage rather than failing loudly.
 */
export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}
