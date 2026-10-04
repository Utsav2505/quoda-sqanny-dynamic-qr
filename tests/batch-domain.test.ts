// Batch QR generation — the domain rules.
//
// These are the tests that matter most in the whole feature, because everything
// else is presentation around them. If `formatSequence(1000)` returned "000" the
// labels would be printed wrong and nothing else would notice: the codes would
// still resolve, the QR would still scan, and the damage would only surface at
// the printer.
//
// So the sequence rules are pinned hard here, including the specific failure the
// brief calls out by name (a 1000 -> 000 wrap).

import { describe, it, expect } from "vitest";
import {
  BATCH_METADATA_MAX,
  BATCH_SIZE_MAX,
  BATCH_SIZE_MULTIPLE,
  composeSerial,
  expandSerials,
  formatSequence,
  hasAmbiguousPadding,
  parseMetadata,
  parseSequence,
  parseSerial,
  previewBatch,
  resolveBatchNumber,
  resolveBatchSize,
  resolveBatchType,
  resolveMetadataFields,
  serializeMetadata,
  serialUrl,
  validateBatchForm,
  type BatchFormValues,
} from "../src/lib/batch";
import { isBatchSerial, normalizeIdentifier, serialFromPayload } from "../src/lib/qr-registration";

// ---------------------------------------------------------------------------

describe("the sequence has no three-digit ceiling", () => {
  it("pads to at least three digits and never fewer than the value needs", () => {
    expect(formatSequence(1)).toBe("001");
    expect(formatSequence(9)).toBe("009");
    expect(formatSequence(10)).toBe("010");
    expect(formatSequence(99)).toBe("099");
    expect(formatSequence(100)).toBe("100");
    expect(formatSequence(999)).toBe("999");
    // The specific failure the brief names: past 999 the value must keep growing.
    expect(formatSequence(1000)).toBe("1000");
    expect(formatSequence(1001)).toBe("1001");
    expect(formatSequence(10000)).toBe("10000");
    expect(formatSequence(123456)).toBe("123456");
  });

  it("never produces 000 for any positive sequence", () => {
    // Sweep the whole boundary region plus a wide spread, because "000" is the
    // signature of a modulo wrap and a handful of spot checks would miss one.
    for (const n of [1, 2, 9, 10, 99, 100, 998, 999, 1000, 1001, 1099, 1100, 9999, 10000]) {
      expect(formatSequence(n), `sequence ${n}`).not.toBe("000");
      expect(Number(formatSequence(n)), `sequence ${n} must round-trip`).toBe(n);
    }
  });

  it("never wraps or truncates at the 999 boundary", () => {
    // Every sequence across the boundary, checked for monotonic increase and for
    // a distinct printed value. A wrap would show up as a decrease; a truncation
    // would show up as two sequences sharing a printed value.
    let previous = 0;
    for (let n = 990; n <= 1010; n++) {
      const formatted = formatSequence(n);
      const asNumber = Number(formatted);
      expect(asNumber).toBe(n);
      expect(asNumber).toBeGreaterThan(previous);
      previous = asNumber;
    }
  });

  it("parses what it formats, for every value in the boundary region", () => {
    for (let n = 1; n <= 12; n++) {
      expect(parseSequence(formatSequence(n))).toBe(n);
    }
    for (let n = 990; n <= 1010; n++) {
      expect(parseSequence(formatSequence(n))).toBe(n);
    }
    for (const n of [9999, 10000, 123456]) {
      expect(parseSequence(formatSequence(n))).toBe(n);
    }
  });

  it("accepts a user typing a large sequence and rejects nonsense", () => {
    expect(parseSequence("1000")).toBe(1000);
    expect(parseSequence("10000")).toBe(10000);
    expect(parseSequence(" 1000 ")).toBe(1000);
    expect(parseSequence("1,000")).toBe(1000);

    expect(parseSequence("")).toBeNull();
    expect(parseSequence("0")).toBeNull();
    expect(parseSequence("-5")).toBeNull();
    expect(parseSequence("1.5")).toBeNull();
    expect(parseSequence("abc")).toBeNull();
    // parseInt would happily read "12abc" as 12.
    expect(parseSequence("12abc")).toBeNull();
    expect(parseSequence("١٢٣")).toBeNull(); // Arabic-Indic digits
    expect(parseSequence(1.5)).toBeNull();
    expect(parseSequence(Number.MAX_SAFE_INTEGER + 10)).toBeNull();
  });

  it("reports input whose padding would be silently rewritten", () => {
    // 007 round-trips, so it is accepted quietly.
    expect(hasAmbiguousPadding("007")).toBe(false);
    expect(parseSequence("007")).toBe(7);
    expect(formatSequence(7)).toBe("007");

    // 0007 would become 007, so the user must be able to see that.
    expect(hasAmbiguousPadding("0007")).toBe(true);
    expect(hasAmbiguousPadding("1")).toBe(false);
    expect(hasAmbiguousPadding("not a number")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("Type", () => {
  it("accepts exactly two letters and uppercases them", () => {
    for (const [input, expected] of [
      ["GR", "GR"],
      ["FB", "FB"],
      ["MN", "MN"],
      ["WA", "WA"],
      ["gr", "GR"],
      ["gr", "GR"],
      [" Wa ", "WA"],
    ] as const) {
      expect(resolveBatchType(input)).toEqual({ value: expected, error: null });
    }
  });

  it("rejects anything that is not two letters, with one clear message", () => {
    // Every invalid case the brief enumerates.
    for (const bad of ["G", "GRO", "G1", "12", "G-R", "GRX", "@@", "g r"]) {
      const result = resolveBatchType(bad);
      expect(result.value, `input ${JSON.stringify(bad)}`).toBeNull();
      expect(result.error, `input ${JSON.stringify(bad)}`).toBe("Type must contain exactly 2 letters.");
    }
    // Empty — and whitespace-only, which is empty once trimmed — is a distinct
    // state from malformed: "required" tells the user what to do, "exactly 2
    // letters" tells them how to format what they typed.
    expect(resolveBatchType("")).toEqual({ value: null, error: "Type is required." });
    expect(resolveBatchType("   ")).toEqual({ value: null, error: "Type is required." });
  });

  it("has no hard-coded list of acceptable types", () => {
    // The product treats the type as a user-supplied operational label. If a list
    // ever crept in, an unlisted-but-valid pair would start failing.
    for (const t of ["ZZ", "QQ", "XQ"]) {
      expect(resolveBatchType(t).value).toBe(t);
    }
  });
});

// ---------------------------------------------------------------------------

describe("Batch No.", () => {
  it("accepts the documented shapes and normalises case", () => {
    for (const [input, expected] of [
      ["B01", "B01"],
      ["B02", "B02"],
      ["B100", "B100"],
      ["JAN01", "JAN01"],
      ["b01", "B01"],
      ["  b01  ", "B01"],
    ] as const) {
      expect(resolveBatchNumber(input)).toEqual({ value: expected, error: null });
    }
  });

  it("rejects spaces and dashes rather than silently stripping them", () => {
    // A dash inside the token would make SQ-GR-A-1-001 ambiguous — two
    // configurations could produce the same string — so it must be refused, not
    // quietly replaced.
    expect(resolveBatchNumber("B 01").error).toMatch(/spaces/i);
    expect(resolveBatchNumber("B-01").error).toBeTruthy();
    expect(resolveBatchNumber("").error).toBe("Batch No. is required.");
  });

  it("rejects a token that is too long", () => {
    expect(resolveBatchNumber("B".repeat(13)).error).toBeTruthy();
    expect(resolveBatchNumber("B".repeat(12)).value).toBe("B".repeat(12));
  });
});

// ---------------------------------------------------------------------------

describe("Batch size", () => {
  it("accepts positive multiples of nine", () => {
    for (const n of [9, 18, 27, 36, 45, 54]) {
      expect(resolveBatchSize(String(n)), `size ${n}`).toEqual({ value: n, error: null });
    }
  });

  it("rejects everything that is not, and never rounds", () => {
    // Silently generating 9 for a requested 10 would hand over a box that does
    // not fit, so the refusal has to be exact.
    for (const n of [1, 2, 8, 10, 17, 20, 25]) {
      expect(resolveBatchSize(String(n)), `size ${n}`).toEqual({
        value: null,
        error: "Batch size must be a multiple of 9.",
      });
    }
  });

  it("distinguishes empty from invalid", () => {
    expect(resolveBatchSize("").error).toBe("Batch size is required.");
    expect(resolveBatchSize("  ").error).toBe("Batch size is required.");
    expect(resolveBatchSize("abc").error).toBe("Batch size must be a whole number.");
    expect(resolveBatchSize("0").error).toBe("Batch size must be greater than zero.");
  });

  it("communicates the documented cap instead of truncating", () => {
    const over = resolveBatchSize(String(BATCH_SIZE_MAX + 9));
    expect(over.value).toBeNull();
    // The message must tell the user what to do about it.
    expect(over.error).toContain("Split it into multiple batches");
    // The cap is a CEILING, not a permitted value: the largest legal size under it
    // is the largest multiple of nine that fits. 2000 itself is not a multiple of
    // nine, so it is correctly rejected for the multiple-of-nine reason — which is
    // checked first, because that is the more specific complaint.
    expect(resolveBatchSize(String(BATCH_SIZE_MAX)).error).toBe(
      "Batch size must be a multiple of 9.",
    );
    const largestLegal = Math.floor(BATCH_SIZE_MAX / BATCH_SIZE_MULTIPLE) * BATCH_SIZE_MULTIPLE;
    expect(resolveBatchSize(String(largestLegal)).value).toBe(largestLegal);
    expect(largestLegal).toBeLessThanOrEqual(BATCH_SIZE_MAX);
    // One multiple above the ceiling is refused by the CAP, not by rounding.
    expect(resolveBatchSize(String(largestLegal + BATCH_SIZE_MULTIPLE)).error).toContain(
      "Split it into multiple batches",
    );
  });
});

// ---------------------------------------------------------------------------

describe("serial composition", () => {
  it("builds SQ-TYPE-BATCH-SEQUENCE", () => {
    expect(composeSerial("GR", "B01", 1)).toBe("SQ-GR-B01-001");
    expect(composeSerial("GR", "B01", 18)).toBe("SQ-GR-B01-018");
    expect(composeSerial("GR", "B01", 1000)).toBe("SQ-GR-B01-1000");
    expect(composeSerial("FB", "JAN01", 10008)).toBe("SQ-FB-JAN01-10008");
  });

  it("round-trips through the parser", () => {
    for (const [t, b, s] of [
      ["GR", "B01", 1],
      ["GR", "B01", 999],
      ["GR", "B01", 1000],
      ["FB", "JAN01", 12345],
    ] as const) {
      expect(parseSerial(composeSerial(t, b, s))).toEqual({
        type: t,
        batchNumber: b,
        sequence: s,
      });
    }
  });

  it("does not mistake a random serial for a batch one", () => {
    expect(parseSerial("SQ-8F2K9A")).toBeNull();
    expect(isBatchSerial("SQ-8F2K9A")).toBe(false);
    expect(isBatchSerial("SQ-GR-B01-001")).toBe(true);
  });
});

describe("batch serials are a real identifier shape", () => {
  it("are accepted and canonicalised exactly like a random serial", () => {
    // This is the integration point with the rest of the product: a batch code has
    // to resolve at /q/:serial or the printed label points at nothing.
    expect(normalizeIdentifier("SQ-GR-B01-001")).toBe("SQ-GR-B01-001");
    expect(normalizeIdentifier("sq-gr-b01-001")).toBe("SQ-GR-B01-001");
    expect(normalizeIdentifier("SQ-GR-B01-1000")).toBe("SQ-GR-B01-1000");
    // Still accepts the pre-existing shape.
    expect(normalizeIdentifier("SQ-8F2K9A")).toBe("SQ-8F2K9A");
  });

  it("is found when scanned from the stand's own URL", () => {
    expect(serialFromPayload("https://sqanny.test/q/SQ-GR-B01-001")).toBe("SQ-GR-B01-001");
    expect(serialFromPayload("SQ-GR-B01-1000")).toBe("SQ-GR-B01-1000");
    expect(serialFromPayload("https://sqanny.test/q/SQ-GR-B01-1000?x=1")).toBe(
      "SQ-GR-B01-1000",
    );
  });

  it("still rejects arbitrary text", () => {
    expect(normalizeIdentifier("hello")).toBeNull();
    expect(normalizeIdentifier("SQ-GR-B01")).toBeNull();
    expect(normalizeIdentifier("SQ-GR-B01-0001")).toBe("SQ-GR-B01-0001");
    // An all-zero sequence is never issued, and must not be accepted as an
    // identifier either — otherwise this half of the system would accept a serial
    // that `composeSerial` cannot produce and `parseSequence` would reject.
    expect(normalizeIdentifier("SQ-GR-B01-000")).toBeNull();
    expect(normalizeIdentifier("SQ-GR-B01-00")).toBeNull();
    expect(parseSequence("000")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("preview", () => {
  const base: BatchFormValues = {
    sequenceStart: "1",
    batchNumber: "B01",
    type: "GR",
    batchSize: "9",
    destination: "",
    businessId: "",
    metadata: [],
  };

  it("computes the range locally, without generating anything", () => {
    const preview = previewBatch(base);
    expect(preview).not.toBeNull();
    expect(preview!.firstSerial).toBe("SQ-GR-B01-001");
    expect(preview!.lastSerial).toBe("SQ-GR-B01-009");
    expect(preview!.quantity).toBe(9);
    expect(preview!.sequenceStart).toBe("001");
    expect(preview!.sequenceEnd).toBe("009");
  });

  it("handles a large start without truncating", () => {
    const preview = previewBatch({ ...base, sequenceStart: "1000" });
    expect(preview!.firstSerial).toBe("SQ-GR-B01-1000");
    expect(preview!.lastSerial).toBe("SQ-GR-B01-1008");
    // 1000..1008 stays inside the 4-digit band, so nothing crosses. The codes are
    // simply longer than they were at 1..9 — which is the point.
    expect(preview!.crossesDigitBoundary).toBe(false);
  });

  it("flags a range that spans 3-digit into 4-digit sequences", () => {
    // The case where the user is most likely to think something is wrong.
    const crossing = previewBatch({ ...base, sequenceStart: "995", batchSize: "18" })!;
    expect(crossing.firstSerial).toBe("SQ-GR-B01-995");
    expect(crossing.lastSerial).toBe("SQ-GR-B01-1012");
    expect(crossing.crossesDigitBoundary).toBe(true);
  });

  it("stays inside the digit band when it does not cross", () => {
    expect(previewBatch({ ...base, sequenceStart: "10", batchSize: "18" })!.crossesDigitBoundary)
      .toBe(false);
    expect(previewBatch({ ...base, sequenceStart: "500", batchSize: "18" })!.crossesDigitBoundary)
      .toBe(false);
  });

  it("is null while the configuration is incomplete", () => {
    expect(previewBatch({ ...base, type: "" })).toBeNull();
    expect(previewBatch({ ...base, batchNumber: "" })).toBeNull();
    expect(previewBatch({ ...base, sequenceStart: "" })).toBeNull();
    expect(previewBatch({ ...base, batchSize: "10" })).toBeNull();
  });

  it("shows the normalised destination, not the raw input", () => {
    // Not asserted by previewBatch itself (it does not carry the destination),
    // but the validation contract is: what the form echoes must be what is stored.
    const { config } = validateBatchForm({ ...base, destination: "example.com/menu" });
    expect(config?.destination).toBe("https://example.com/menu");
  });
});

// ---------------------------------------------------------------------------

describe("whole-form validation", () => {
  const base: BatchFormValues = {
    sequenceStart: "1",
    batchNumber: "B01",
    type: "GR",
    batchSize: "9",
    destination: "",
    businessId: "",
    metadata: [],
  };

  it("returns a config only when everything passes", () => {
    const result = validateBatchForm(base);
    expect(result.ok).toBe(true);
    expect(result.config).not.toBeNull();
    expect(result.config!.sequenceStart).toBe(1);
    expect(result.config!.sequenceEnd).toBe(9);
    expect(result.config!.quantity).toBe(9);
  });

  it("reports every bad field at once rather than one at a time", () => {
    // One error per round trip is a miserable way to fill in a form.
    const result = validateBatchForm({
      ...base,
      type: "GRO",
      batchNumber: "",
      batchSize: "10",
      sequenceStart: "0",
    });
    expect(result.ok).toBe(false);
    expect(result.config).toBeNull();
    expect(result.errors.type).toBeTruthy();
    expect(result.errors.batchNumber).toBeTruthy();
    expect(result.errors.batchSize).toBeTruthy();
    expect(result.errors.sequenceStart).toBeTruthy();
  });

  it("distinguishes a missing sequence from a malformed one", () => {
    expect(validateBatchForm({ ...base, sequenceStart: "" }).errors.sequenceStart).toBe(
      "Starting sequence is required.",
    );
    expect(validateBatchForm({ ...base, sequenceStart: "abc" }).errors.sequenceStart).toMatch(
      /number/i,
    );
    expect(validateBatchForm({ ...base, sequenceStart: "0" }).errors.sequenceStart).toMatch(
      /1 or greater/,
    );
  });

  it("treats the destination as optional but validated when present", () => {
    expect(validateBatchForm(base).config?.destination).toBeNull();
    expect(
      validateBatchForm({ ...base, destination: "https://x.test" }).config?.destination,
    ).toBe("https://x.test");
    expect(validateBatchForm({ ...base, destination: "javascript:alert(1)" }).errors.destination)
      .toBeTruthy();
  });

  it("refuses a range that would run past the sequence ceiling", () => {
    // Individually valid, jointly impossible. Without this the range would
    // silently lose precision.
    const result = validateBatchForm({
      ...base,
      sequenceStart: String(Number.MAX_SAFE_INTEGER - 2),
      batchSize: "9",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.sequenceStart).toMatch(/maximum sequence/);
  });
});

// ---------------------------------------------------------------------------

describe("custom metadata fields", () => {
  it("accepts zero, one, many", () => {
    expect(resolveMetadataFields([]).fields).toEqual([]);
    expect(resolveMetadataFields([{ name: "Line", value: "L02" }]).fields).toEqual([
      { name: "Line", value: "L02" },
    ]);
    const many = Array.from({ length: BATCH_METADATA_MAX }, (_, i) => ({
      name: `Field ${i}`,
      value: `v${i}`,
    }));
    expect(resolveMetadataFields(many).fields).toHaveLength(BATCH_METADATA_MAX);
    expect(resolveMetadataFields(many).errors).toEqual([]);
  });

  it("refuses more than the documented maximum, with a clear message", () => {
    const tooMany = Array.from({ length: BATCH_METADATA_MAX + 1 }, (_, i) => ({
      name: `F${i}`,
      value: "v",
    }));
    const result = resolveMetadataFields(tooMany);
    expect(result.fields).toEqual([]);
    expect(result.errors[0]).toBe(
      "You've reached the maximum number of custom fields (20).",
    );
  });

  it("treats a named field with no value as an error the user can see", () => {
    const result = resolveMetadataFields([{ name: "Line", value: "  " }]);
    expect(result.fields).toEqual([]);
    expect(result.errors[0]).toContain("needs a value");
  });

  it("drops a half-typed row rather than storing a nameless column", () => {
    expect(resolveMetadataFields([{ name: "", value: "orphan" }]).fields).toEqual([]);
  });

  it("de-duplicates names case-insensitively, first wins", () => {
    const result = resolveMetadataFields([
      { name: "Line", value: "L02" },
      { name: "line", value: "L09" },
    ]);
    expect(result.fields).toEqual([{ name: "Line", value: "L02" }]);
  });

  it("rejects a name that cannot be a CSV column", () => {
    expect(resolveMetadataFields([{ name: 'a,b"c', value: "v" }]).errors[0]).toBeTruthy();
  });

  it("round-trips through serialise/parse, and survives a corrupt column", () => {
    const fields = [
      { name: "Line", value: "L02" },
      { name: "Run", value: "October-2026" },
    ];
    expect(parseMetadata(serializeMetadata(fields))).toEqual(fields);
    expect(parseMetadata(null)).toEqual([]);
    expect(parseMetadata("{not json")).toEqual([]);
    expect(parseMetadata('{"not":"an array"}')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("expansion and URLs", () => {
  it("expands a full batch in order", () => {
    const { config } = validateBatchForm({
      sequenceStart: "1",
      batchNumber: "B01",
      type: "GR",
      batchSize: "9",
      destination: "",
      businessId: "",
      metadata: [],
    });
    expect(expandSerials(config!)).toEqual([
      "SQ-GR-B01-001",
      "SQ-GR-B01-002",
      "SQ-GR-B01-003",
      "SQ-GR-B01-004",
      "SQ-GR-B01-005",
      "SQ-GR-B01-006",
      "SQ-GR-B01-007",
      "SQ-GR-B01-008",
      "SQ-GR-B01-009",
    ]);
  });

  it("expands a large-start batch with no wrap", () => {
    const { config } = validateBatchForm({
      sequenceStart: "1000",
      batchNumber: "B01",
      type: "GR",
      batchSize: "9",
      destination: "",
      businessId: "",
      metadata: [],
    });
    const serials = expandSerials(config!);
    expect(serials).toHaveLength(9);
    expect(serials[0]).toBe("SQ-GR-B01-1000");
    expect(serials[8]).toBe("SQ-GR-B01-1008");
    // Every one is distinct — no two entries share a printed code.
    expect(new Set(serials).size).toBe(9);
  });

  it("builds the permanent URL a batch QR encodes", () => {
    // NOT the destination: that is configuration and can change. This is identity.
    expect(serialUrl("https://sqanny.test", "SQ-GR-B01-001")).toBe(
      "https://sqanny.test/q/SQ-GR-B01-001",
    );
    expect(serialUrl("https://sqanny.test/", "SQ-GR-B01-001")).toBe(
      "https://sqanny.test/q/SQ-GR-B01-001",
    );
  });
});

// ---------------------------------------------------------------------------

describe("acceptance: the brief's own worked examples", () => {
  it("§47 GR/B01/start 1/size 9 produces exactly nine codes", () => {
    const preview = previewBatch({
      sequenceStart: "1",
      batchNumber: "B01",
      type: "GR",
      batchSize: "9",
      destination: "",
      businessId: "",
      metadata: [],
    })!;
    const expected = [
      "SQ-GR-B01-001", "SQ-GR-B01-002", "SQ-GR-B01-003",
      "SQ-GR-B01-004", "SQ-GR-B01-005", "SQ-GR-B01-006",
      "SQ-GR-B01-007", "SQ-GR-B01-008", "SQ-GR-B01-009",
    ];
    const { config } = validateBatchForm({
      sequenceStart: "1", batchNumber: "B01", type: "GR", batchSize: "9",
      destination: "", businessId: "", metadata: [],
    });
    expect(expandSerials(config!)).toEqual(expected);
    expect(preview.firstSerial).toBe(expected[0]);
    expect(preview.lastSerial).toBe(expected[8]);
  });

  it("§48 GR/B01/start 1000/size 9 produces 1000..1008", () => {
    const { config } = validateBatchForm({
      sequenceStart: "1000", batchNumber: "B01", type: "GR", batchSize: "9",
      destination: "", businessId: "", metadata: [],
    });
    expect(expandSerials(config!)).toEqual([
      "SQ-GR-B01-1000", "SQ-GR-B01-1001", "SQ-GR-B01-1002",
      "SQ-GR-B01-1003", "SQ-GR-B01-1004", "SQ-GR-B01-1005",
      "SQ-GR-B01-1006", "SQ-GR-B01-1007", "SQ-GR-B01-1008",
    ]);
  });

  it("§49 accepts 9/18/27/36 and refuses 8/10/17/20", () => {
    for (const n of [9, 18, 27, 36]) {
      expect(validateBatchForm({
        sequenceStart: "1", batchNumber: "B01", type: "GR", batchSize: String(n),
        destination: "", businessId: "", metadata: [],
      }).ok, `size ${n}`).toBe(true);
    }
    for (const n of [8, 10, 17, 20]) {
      expect(validateBatchForm({
        sequenceStart: "1", batchNumber: "B01", type: "GR", batchSize: String(n),
        destination: "", businessId: "", metadata: [],
      }).ok, `size ${n}`).toBe(false);
    }
  });

  it("§50 accepts GR/FB/MN/WA, refuses G/GRO/G1/12/G-R, and uppercases gr", () => {
    for (const t of ["GR", "FB", "MN", "WA"]) {
      expect(resolveBatchType(t).value).toBe(t);
    }
    for (const t of ["G", "GRO", "G1", "12", "G-R"]) {
      expect(resolveBatchType(t).value, t).toBeNull();
    }
    expect(resolveBatchType("gr").value).toBe("GR");
  });

  it("§51 adding then removing a custom field leaves generation intact", () => {
    const withFields = resolveMetadataFields([
      { name: "Manufacturing Line", value: "L02" },
      { name: "Production Run", value: "October-2026" },
    ]);
    expect(withFields.fields).toHaveLength(2);

    // Remove the second row — exactly what the Remove control does.
    const afterRemove = resolveMetadataFields([withFields.fields[0]]);
    expect(afterRemove.fields).toEqual([{ name: "Manufacturing Line", value: "L02" }]);
    expect(afterRemove.errors).toEqual([]);

    const { config, ok } = validateBatchForm({
      sequenceStart: "1", batchNumber: "B01", type: "GR", batchSize: "9",
      destination: "", businessId: "", metadata: afterRemove.fields,
    });
    expect(ok).toBe(true);
    expect(config!.metadata).toHaveLength(1);
    expect(expandSerials(config!).length).toBe(9);
  });
});
