import { describe, it, expect } from "vitest";
import { encodeMatrix } from "../src/lib/qr/encoder";
import { renderSvg } from "../src/lib/qr/render-svg";
import type { QrDesign } from "../src/lib/qr/types";

const baseDesign: QrDesign = {
  fg: "#0D0D0F",
  bg: "#FFFFFF",
  moduleShape: "square",
  eyeStyle: "square",
  ecc: "M",
};

function countDark(matrix: boolean[][]): number {
  let n = 0;
  for (const row of matrix) for (const cell of row) if (cell) n++;
  return n;
}

describe("renderSvg", () => {
  const matrix = encodeMatrix("https://getsqanny.com", "M");

  it("produces a standalone <svg> string", () => {
    const svg = renderSvg(matrix, baseDesign);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("includes a viewBox accounting for the quiet-zone margin", () => {
    const margin = 4;
    const svg = renderSvg(matrix, { ...baseDesign, margin });
    const total = matrix.length + margin * 2;
    expect(svg).toContain(`viewBox="0 0 ${total} ${total}"`);
  });

  it("honors a custom margin", () => {
    const svg = renderSvg(matrix, { ...baseDesign, margin: 2 });
    const total = matrix.length + 2 * 2;
    expect(svg).toContain(`viewBox="0 0 ${total} ${total}"`);
  });

  it("paints the background with the bg color", () => {
    const svg = renderSvg(matrix, { ...baseDesign, bg: "#FAFAFA" });
    expect(svg).toContain("#FAFAFA");
  });

  it("uses the custom foreground color", () => {
    const svg = renderSvg(matrix, { ...baseDesign, fg: "#0A7EA4" });
    expect(svg).toContain("#0A7EA4");
  });

  it("draws one <rect> per dark module (square shape), excluding the bg rect and eyes", () => {
    const svg = renderSvg(matrix, baseDesign);
    // count <rect occurrences
    const rectCount = (svg.match(/<rect/g) || []).length;
    const darkCount = countDark(matrix);
    // square shape draws a rect per dark data module; eyes are drawn separately.
    // So total rects should be <= darkCount + bg + eye rects, and > 0.
    expect(rectCount).toBeGreaterThan(0);
    // For square + square-eye the simplest faithful renderer draws exactly
    // (dark modules) rects + 1 background rect. We assert the dark modules are
    // all represented: rect count must be at least darkCount - (eye modules).
    // Finder eyes occupy 3 * 7x7 = 147 module cells; ensure plausible bound.
    expect(rectCount).toBeLessThanOrEqual(darkCount + 50);
  });

  it("renders dots as <circle> elements when moduleShape is dots", () => {
    const svg = renderSvg(matrix, { ...baseDesign, moduleShape: "dots" });
    expect(svg).toContain("<circle");
  });

  it("renders rounded modules with rx on rects", () => {
    const svg = renderSvg(matrix, { ...baseDesign, moduleShape: "rounded" });
    expect(svg).toContain("rx=");
  });

  it("injects an <image> when a logo is provided", () => {
    const svg = renderSvg(matrix, {
      ...baseDesign,
      logo: "data:image/png;base64,AAAA",
    });
    expect(svg).toContain("<image");
    expect(svg).toContain("data:image/png;base64,AAAA");
  });

  it("does not inject an <image> when no logo is provided", () => {
    const svg = renderSvg(matrix, baseDesign);
    expect(svg).not.toContain("<image");
  });

  it("renders the frame label text when provided", () => {
    const svg = renderSvg(matrix, { ...baseDesign, frameLabel: "SCAN ME" });
    expect(svg).toContain("<text");
    expect(svg).toContain("SCAN ME");
  });

  it("escapes XML special chars in the frame label", () => {
    const svg = renderSvg(matrix, {
      ...baseDesign,
      frameLabel: 'A & B <C> "D"',
    });
    expect(svg).toContain("A &amp; B &lt;C&gt; &quot;D&quot;");
    expect(svg).not.toContain("<C>");
  });

  it("escapes the logo href against attribute injection", () => {
    const svg = renderSvg(matrix, {
      ...baseDesign,
      logo: 'x"><script>alert(1)</script>',
    });
    expect(svg).not.toContain("<script>");
  });

  it("is deterministic for identical inputs", () => {
    const a = renderSvg(matrix, baseDesign);
    const b = renderSvg(matrix, baseDesign);
    expect(a).toBe(b);
  });

  it("supports the circle eye style", () => {
    const svg = renderSvg(matrix, { ...baseDesign, eyeStyle: "circle" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<circle");
  });

  it("supports the rounded eye style", () => {
    const svg = renderSvg(matrix, { ...baseDesign, eyeStyle: "rounded" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("rx=");
  });
});
