// ZIP and manifest generation.
//
// The ZIP tests deliberately PARSE the output back rather than asserting on byte
// lengths. A structurally wrong archive can easily have the right total size —
// and it downloads successfully, so the user only finds out when the print shop
// cannot open it. Reading the central directory back is the only check that
// proves the file is real.

import { describe, it, expect } from "vitest";
import { createZip, crc32 } from "../src/lib/zip";
import {
  MANIFEST_COLUMNS,
  buildManifest,
  csvField,
  csvRow,
  isoTimestamp,
  type ManifestRow,
} from "../src/lib/manifest";

// ---------------------------------------------------------------------------
// A minimal ZIP reader, used only to verify what createZip wrote.
// ---------------------------------------------------------------------------

interface ReadEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  content: string;
}

interface ReadArchive {
  entries: ReadEntry[];
  eocdCount: number;
  centralOffset: number;
  centralSize: number;
}

/** Parse a ZIP from its End Of Central Directory record backwards. */
function readZip(bytes: Uint8Array): ReadArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);

  // EOCD is last, and its comment length tells us where it starts.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");

  const count = u16(eocd + 10);
  const centralSize = u32(eocd + 12);
  const centralOffset = u32(eocd + 16);
  if (eocd + 22 + u16(eocd + 20) !== bytes.length) {
    throw new Error("EOCD comment length does not reach the end of the file");
  }

  const entries: ReadEntry[] = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (u32(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const compressedSize = u32(p + 20);
    const uncompressedSize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOffset = u32(p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // Follow the local header to the data, honouring ITS name/extra lengths —
    // they can differ from the central record's.
    if (u32(localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localNameLen = u16(localOffset + 26);
    const localExtraLen = u16(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const content = new TextDecoder().decode(
      bytes.subarray(dataStart, dataStart + uncompressedSize),
    );

    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset, content });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return { entries, eocdCount: count, centralOffset, centralSize };
}

// ---------------------------------------------------------------------------

describe("CRC-32", () => {
  it("matches the known IEEE check value", () => {
    // The canonical check: CRC32("123456789") === 0xCBF43926.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("is zero for empty input and stable for repeated input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    const a = crc32(new TextEncoder().encode("SQ-GR-B01-001.svg"));
    const b = crc32(new TextEncoder().encode("SQ-GR-B01-001.svg"));
    expect(a).toBe(b);
  });
});

describe("createZip", () => {
  it("produces a readable archive with the expected entries", () => {
    const zip = createZip([
      { name: "SQ-GR-B01-001.svg", content: "<svg>1</svg>" },
      { name: "SQ-GR-B01-002.svg", content: "<svg>2</svg>" },
      { name: "manifest.csv", content: "serial_number\r\nSQ-GR-B01-001\r\n" },
    ]);

    const archive = readZip(zip);
    expect(archive.eocdCount).toBe(3);
    expect(archive.entries.map((e) => e.name)).toEqual([
      "SQ-GR-B01-001.svg",
      "SQ-GR-B01-002.svg",
      "manifest.csv",
    ]);
    expect(archive.entries[0].content).toBe("<svg>1</svg>");
    expect(archive.entries[2].content).toContain("serial_number");
  });

  it("records a correct CRC for every entry", () => {
    const contents = ["a", "bb", "ccc", "<svg>hello</svg>"];
    const zip = createZip(contents.map((c, i) => ({ name: `f${i}.txt`, content: c })));
    const archive = readZip(zip);
    for (const entry of archive.entries) {
      const expected = crc32(new TextEncoder().encode(entry.content));
      expect(entry.crc, entry.name).toBe(expected);
    }
  });

  it("uses STORE, so compressed and uncompressed sizes agree", () => {
    const zip = createZip([{ name: "a.svg", content: "<svg/>" }]);
    const entry = readZip(zip).entries[0];
    expect(entry.method).toBe(0);
    expect(entry.compressedSize).toBe(entry.uncompressedSize);
    expect(entry.uncompressedSize).toBe(new TextEncoder().encode("<svg/>").length);
  });

  it("is deterministic — the same input yields byte-identical output", () => {
    // This is what makes "Regenerate Assets" a meaningful operation rather than a
    // way to produce a different file for identical inputs.
    const entries = [
      { name: "SQ-GR-B01-001.svg", content: "<svg>1</svg>" },
      { name: "SQ-GR-B01-002.svg", content: "<svg>2</svg>" },
      { name: "manifest.csv", content: "a,b\r\n1,2\r\n" },
    ];
    const a = createZip(entries);
    const b = createZip(entries);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("handles a large batch without overflowing the 16-bit entry count", () => {
    // The batch ceiling is 2000, so a ZIP with that many entries plus a manifest
    // must still be writable.
    const entries = Array.from({ length: 2000 }, (_, i) => ({
      name: `SQ-GR-B01-${String(i + 1).padStart(3, "0")}.svg`,
      content: `<svg data-n="${i}"/>`,
    }));
    entries.push({ name: "manifest.csv", content: "serial_number\r\n" });

    const archive = readZip(createZip(entries));
    expect(archive.eocdCount).toBe(2001);
    expect(archive.entries[0].name).toBe("SQ-GR-B01-001.svg");
    expect(archive.entries[1999].name).toBe("SQ-GR-B01-2000.svg");
    expect(archive.entries[2000].name).toBe("manifest.csv");
  });

  it("handles a multi-megabyte entry", () => {
    const big = "x".repeat(4 * 1024 * 1024);
    const archive = readZip(createZip([{ name: "big.txt", content: big }]));
    expect(archive.entries[0].uncompressedSize).toBe(big.length);
    expect(archive.entries[0].content.length).toBe(big.length);
  });

  it("refuses to build an empty archive rather than emitting a broken one", () => {
    // A zero-entry ZIP is legal but useless, and every extractor handles it
    // differently. Failing here is clearer than downloading something empty.
    expect(() => createZip([])).toThrow(/empty/i);
  });

  it("preserves a UTF-8 filename, with the length in BYTES", () => {
    // ZIP records byte lengths. A name with a multi-byte character whose .length
    // was used instead of its byte length shifts every subsequent offset, and the
    // archive then extracts as garbage rather than failing loudly.
    const name = "SQ-GR-B01-café.svg";
    const archive = readZip(createZip([{ name, content: "<svg/>" }, { name: "b.svg", content: "x" }]));
    expect(archive.entries.map((e) => e.name)).toEqual([name, "b.svg"]);
    expect(archive.entries[1].content).toBe("x");
  });

  it("round-trips content containing newlines and quotes", () => {
    const awkward = 'line1\r\nline2 "quoted", commas\r\n';
    const archive = readZip(createZip([{ name: "a.txt", content: awkward }]));
    expect(archive.entries[0].content).toBe(awkward);
  });
});

// ---------------------------------------------------------------------------

/**
 * A real RFC 4180 field splitter.
 *
 * Needed because the naive `line.split(",")` is exactly the mistake the quoting
 * exists to prevent — a test written that way would "confirm" broken output. This
 * honours quotes, so the assertions below are about what a spreadsheet would
 * actually see.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let field = "";
  let quoted = false;
  while (i < line.length) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      out.push(field);
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  out.push(field);
  return out;
}

function parseCsv(csv: string): string[][] {
  return csv.trim().split("\r\n").map(parseCsvLine);
}

// ---------------------------------------------------------------------------

describe("manifest CSV", () => {
  const row = (over: Partial<ManifestRow> = {}): ManifestRow => ({
    serial_number: "SQ-GR-B01-001",
    qr_id: "reg-1",
    type: "GR",
    batch_number: "B01",
    sequence: "001",
    dynamic_url: "https://sqanny.test/q/SQ-GR-B01-001",
    destination_url: "https://example.com/menu",
    status: "active",
    created_at: "2026-10-03T09:00:00Z",
    ...over,
  });

  it("emits the documented columns in the documented order", () => {
    const csv = buildManifest([row()]);
    const header = csv.split("\r\n")[0];
    expect(header).toBe(MANIFEST_COLUMNS.join(","));
    expect(header).toBe(
      "serial_number,qr_id,type,batch_number,sequence,dynamic_url,destination_url,status,created_at",
    );
  });

  it("writes one row per QR with a trailing newline", () => {
    const csv = buildManifest([row(), row({ serial_number: "SQ-GR-B01-002", qr_id: "reg-2" })]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("SQ-GR-B01-001");
    expect(lines[2]).toContain("SQ-GR-B01-002");
    // RFC 4180 CRLF, and a final line break — some parsers drop the last row
    // without it.
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("appends custom metadata as extra columns, after the fixed ones", () => {
    const csv = buildManifest(
      [row()],
      [
        { name: "Manufacturing Line", value: "L02" },
        { name: "Production Run", value: "October-2026" },
      ],
    );
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "serial_number,qr_id,type,batch_number,sequence,dynamic_url,destination_url,status,created_at,Manufacturing Line,Production Run",
    );
    expect(lines[1].endsWith("L02,October-2026")).toBe(true);
  });

  it("quotes a value containing a comma, and does not shift the columns", () => {
    // The failure this prevents: an unquoted comma makes every column after it on
    // that row read the wrong value, and the inventory file silently lies.
    const line = csvRow(["a", "Line 2, North", "c"]);
    expect(line).toBe('a,"Line 2, North",c');
    // Parsed the way a spreadsheet would, the row still has three columns and
    // the comma is part of the value, not a separator.
    expect(parseCsvLine(line)).toEqual(["a", "Line 2, North", "c"]);
  });

  it("survives commas, quotes and newlines in every metadata column", () => {
    const csv = buildManifest([row()], [
      { name: "Notes", value: 'a, b "c"\nd' },
      { name: "Line", value: "L02" },
    ]);
    const parsed = parseCsv(csv);
    // The header is intact despite the newline inside a value.
    expect(parsed[0]).toHaveLength(11);
    expect(parsed[0].slice(9)).toEqual(["Notes", "Line"]);
    expect(parsed[1]).toHaveLength(11);
    expect(parsed[1][9]).toBe('a, b "c"\nd');
    expect(parsed[1][10]).toBe("L02");
  });

  it("doubles an embedded quote", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField("plain")).toBe("plain");
    expect(csvField(null)).toBe("");
    expect(parseCsvLine(csvField('say "hi"'))).toEqual(['say "hi"']);
  });

  it("neutralises a leading formula sigil", () => {
    // A manifest is exactly the kind of file someone double-clicks into a
    // spreadsheet, so a value beginning = + - @ must not be read as a formula.
    // The tab prefix ends up INSIDE the quotes when the value also needs quoting,
    // which is correct: the parsed value's first character is then a tab, and no
    // spreadsheet treats a tab-prefixed cell as a formula.
    for (const sigil of ["=", "+", "-", "@"]) {
      const parsed = parseCsvLine(csvField(`${sigil}HYPERLINK("http://evil","x")`));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].startsWith(`\t${sigil}`), sigil).toBe(true);
    }
    // A benign value is left completely alone — no stray tabs in normal data.
    expect(csvField("L02")).toBe("L02");
    expect(parseCsvLine(csvField("L02"))).toEqual(["L02"]);
  });

  it("carries no personal or account data", () => {
    // The archive goes to whoever prints and ships the labels. An inventory sheet
    // has no need for account data, and including it would turn a file that
    // circulates through a print shop into a copy of the customer database.
    const csv = buildManifest([row()]);
    for (const forbidden of ["email", "@", "owner", "phone", "created_by", "avatar"]) {
      const header = csv.split("\r\n")[0].toLowerCase();
      expect(header, `header must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("renders a stable ISO-8601 timestamp", () => {
    expect(isoTimestamp(1760000000000)).toBe("2025-10-09T08:53:20Z");
    // Lexicographic order must match chronological order, or a spreadsheet sort
    // produces nonsense.
    expect(isoTimestamp(1000) < isoTimestamp(2000)).toBe(true);
  });

  it("leaves a blank destination rather than inventing one", () => {
    const csv = buildManifest([row({ destination_url: "" })]);
    expect(csv).toContain("https://sqanny.test/q/SQ-GR-B01-001,,active");
  });
});
