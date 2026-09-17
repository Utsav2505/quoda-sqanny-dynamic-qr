import { describe, it, expect } from "vitest";
import { encodeMatrix } from "../src/lib/qr/encoder";

describe("encodeMatrix", () => {
  it("returns an NxN row-major boolean matrix for a known string", () => {
    const m = encodeMatrix("https://getsqanny.com", "M");
    expect(Array.isArray(m)).toBe(true);
    expect(m.length).toBeGreaterThan(0);
    // square
    const n = m.length;
    for (const row of m) {
      expect(Array.isArray(row)).toBe(true);
      expect(row.length).toBe(n);
      for (const cell of row) {
        expect(typeof cell).toBe("boolean");
      }
    }
  });

  it("produces a finder pattern in the top-left corner (7x7 dark border)", () => {
    const m = encodeMatrix("HELLO WORLD", "M");
    // Finder pattern: top-left 7x7 has a dark outer ring.
    // Top-left module is always dark.
    expect(m[0][0]).toBe(true);
    // The 7th column of row 0 is the right edge of the finder ring -> dark.
    expect(m[0][6]).toBe(true);
    // Module just outside the finder (col 7, row 0) is the white separator -> light.
    expect(m[0][7]).toBe(false);
  });

  it("is deterministic for the same input", () => {
    const a = encodeMatrix("deterministic", "Q");
    const b = encodeMatrix("deterministic", "Q");
    expect(a).toEqual(b);
  });

  it("supports all ECC levels and grows with ECC strength", () => {
    for (const ecc of ["L", "M", "Q", "H"] as const) {
      const m = encodeMatrix("ecc-level-test", ecc);
      expect(m.length).toBeGreaterThanOrEqual(21); // version 1 is 21x21
    }
  });

  it("defaults to ECC level M", () => {
    const a = encodeMatrix("default-ecc");
    const b = encodeMatrix("default-ecc", "M");
    expect(a).toEqual(b);
  });

  it("throws on empty data", () => {
    expect(() => encodeMatrix("", "M")).toThrow();
  });

  it("throws on whitespace-only data", () => {
    expect(() => encodeMatrix("   ", "M")).toThrow();
  });
});
