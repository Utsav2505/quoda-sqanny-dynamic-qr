import { test, expect, type Page } from "@playwright/test";

// The scannability gate: a generated QR must actually decode back to its input.
// We render the real SVG the API produces, rasterize it in the browser to pixels,
// and decode with jsQR — the same path a phone camera takes.

const SIZE = 512;

/** Render an SVG string to ImageData in the page, then decode with jsQR. */
async function decodeSvg(page: Page, svg: string): Promise<string | null> {
  return page.evaluate(
    async ({ svg, size }) => {
      const blob = new Blob([svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.width = size;
      img.height = size;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("svg image load failed"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      // White backdrop so transparent quiet zones rasterize as light.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      const data = ctx.getImageData(0, 0, size, size);
      // jsQR is loaded onto window by the test via addScriptTag.
      const result = (window as unknown as { jsQR: typeof import("jsqr").default }).jsQR(
        data.data,
        size,
        size,
      );
      return result ? result.data : null;
    },
    { svg, size: SIZE },
  );
}

/** Fetch a preview SVG from the running worker for a given type/fields/design. */
async function previewSvg(
  page: Page,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await page.request.post("/api/preview", { data: body });
  expect(res.ok()).toBeTruthy();
  const json = (await res.json()) as { svg?: string };
  expect(json.svg, "preview returned an svg").toBeTruthy();
  return json.svg!;
}

test.describe("QR scannability — generated codes actually decode", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/"); // a real document so Image/canvas + jsQR work
    // jsQR exposes a global `jsQR` when loaded as a classic script.
    await page.addScriptTag({ path: "node_modules/jsqr/dist/jsQR.js" });
  });

  const url = "https://getsqanny.com/test-scan";

  test("default design (square modules)", async ({ page }) => {
    const svg = await previewSvg(page, { type: "url", fields: { url } });
    expect(await decodeSvg(page, svg)).toBe(url);
  });

  test("dots module shape", async ({ page }) => {
    const svg = await previewSvg(page, {
      type: "url",
      fields: { url },
      design: { moduleShape: "dots", ecc: "H" },
    });
    expect(await decodeSvg(page, svg)).toBe(url);
  });

  test("rounded modules + rounded eyes", async ({ page }) => {
    const svg = await previewSvg(page, {
      type: "url",
      fields: { url },
      design: { moduleShape: "rounded", eyeStyle: "rounded", ecc: "H" },
    });
    expect(await decodeSvg(page, svg)).toBe(url);
  });

  test("logo overlay still decodes (logo forces ECC=H)", async ({ page }) => {
    // A tiny inline SVG logo. Even on a short payload (small version), the
    // server forces ECC=H when a logo is present so the knockout is recoverable.
    const logo =
      "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2010%2010'%3E%3Crect%20width='10'%20height='10'%20fill='%230A7EA4'/%3E%3C/svg%3E";
    const svg = await previewSvg(page, {
      type: "url",
      fields: { url },
      design: { logo, ecc: "L" }, // request L; server must upgrade to H
    });
    expect(await decodeSvg(page, svg)).toBe(url);
  });

  test("margin below the ISO quiet zone is clamped (still decodes)", async ({ page }) => {
    const svg = await previewSvg(page, {
      type: "url",
      fields: { url },
      design: { margin: 0 },
    });
    expect(await decodeSvg(page, svg)).toBe(url);
  });

  test("wifi payload decodes to the canonical WIFI string", async ({ page }) => {
    const svg = await previewSvg(page, {
      type: "wifi",
      fields: { ssid: "Sqanny Cafe", password: "latte123", auth: "WPA" },
    });
    const decoded = await decodeSvg(page, svg);
    expect(decoded).toContain("WIFI:");
    expect(decoded).toContain("Sqanny Cafe");
  });
});

// The regression the studio bug caused: a dynamic code's PRINTED image must
// encode its permanent redirect, never its destination. When it encoded the
// content, the studio showed a different QR from the one on the label, and
// retargeting made it visibly change — the exact thing a dynamic code promises
// it will never do.
test.describe("dynamic codes — the printed image is stable", () => {
  const shortCode = "e2eStable01";

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.addScriptTag({ path: "node_modules/jsqr/dist/jsQR.js" });
  });

  test("decodes to the redirect URL, not the destination", async ({ page, baseURL }) => {
    const svg = await previewSvg(page, {
      type: "url",
      isDynamic: true,
      shortCode,
      fields: { url: "https://example.com/menu" },
    });
    const decoded = await decodeSvg(page, svg);
    // baseURL rather than a hardcoded host: APP_URL is the dev origin locally
    // and the custom domain in production, and this test must hold in both.
    expect(decoded).toBe(`${baseURL}/r/${shortCode}`);
    expect(decoded).not.toContain("example.com");
  });

  test("is byte-identical after the destination changes", async ({ page, baseURL }) => {
    // Retarget twice and prove the printed code does not move. This is the
    // guarantee the whole product rests on.
    const before = await decodeSvg(
      page,
      await previewSvg(page, {
        type: "url",
        isDynamic: true,
        shortCode,
        fields: { url: "https://one.test" },
      }),
    );
    const after = await decodeSvg(
      page,
      await previewSvg(page, {
        type: "url",
        isDynamic: true,
        shortCode,
        fields: { url: "https://two.test/some/deep/path?with=query" },
      }),
    );
    expect(before).toBe(after);
    expect(before).toBe(`${baseURL}/r/${shortCode}`);
  });

  test("a static code still decodes to its content", async ({ page }) => {
    // Guards against over-correcting: static codes must NOT be forced through
    // a redirect, or they would stop working entirely.
    const url = "https://example.com/static";
    const svg = await previewSvg(page, { type: "url", isDynamic: false, fields: { url } });
    expect(await decodeSvg(page, svg)).toBe(url);
  });

  test("a dynamic code with no short code yet renders no code", async ({ page }) => {
    // Create-mode deferred code: nothing real to encode, so the API must refuse
    // rather than hand back a QR for an empty string.
    const res = await page.request.post("/api/preview", {
      data: { type: "url", isDynamic: true, fields: { url: "" } },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no_code_yet");
  });
});
