// Studio island — drives type switching, live preview, scannability warnings,
// save, and SVG/PNG/PDF export. Dependency-free vanilla TS. Never fails silently.

interface QrDesign {
  fg: string;
  bg: string;
  moduleShape: string;
  eyeStyle: string;
  ecc: string;
  frameLabel?: string;
  logo?: string;
}

interface PreviewResponse {
  ok: boolean;
  svg?: string;
  scannable?: boolean;
  warn?: boolean;
  ratio?: number;
  error?: string;
}

const RICH_TYPES = new Set(["pdf", "menu", "business", "appstore", "social"]);

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-studio]");
  if (!root) return;

  const mode = root.getAttribute("data-mode") === "edit" ? "edit" : "new";
  const qrId = root.getAttribute("data-qr-id") || "";
  let activeType = root.getAttribute("data-active-type") || "url";

  const previewSurface = root.querySelector<HTMLElement>(".qr-preview-surface");
  const warnEl = root.querySelector<HTMLElement>("[data-scan-warn]");
  const errorEl = root.querySelector<HTMLElement>("[data-studio-error]");
  const titleInput = root.querySelector<HTMLInputElement>("[data-title]");
  const dynamicToggle = root.querySelector<HTMLInputElement>("[data-dynamic]");
  const dynamicPanel = root.querySelector<HTMLElement>("[data-dynamic-panel]");
  const saveBtn = root.querySelector<HTMLElement>(".studio-save");
  const logoInput = root.querySelector<HTMLInputElement>("[data-logo]");
  const logoHidden = root.querySelector<HTMLInputElement>('[data-design="logo"]');

  let debounceTimer: number | undefined;
  let lastSvg = previewSurface?.querySelector("svg")?.outerHTML ?? "";

  // -- read current design from the customization panel --------------------
  function readDesign(): QrDesign {
    const get = (k: string): string =>
      root!.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-design="${k}"]`)?.value ?? "";
    const design: QrDesign = {
      fg: get("fg") || "#0D0D0F",
      bg: get("bg") || "#FFFFFF",
      moduleShape: get("moduleShape") || "square",
      eyeStyle: get("eyeStyle") || "square",
      ecc: get("ecc") || "M",
    };
    const frame = get("frameLabel").trim();
    if (frame) design.frameLabel = frame;
    const logo = (logoHidden?.value || "").trim();
    if (logo) design.logo = logo;
    return design;
  }

  // -- read the active type's content fields -------------------------------
  function readContent(): Record<string, string> {
    const block = root!.querySelector<HTMLElement>(`[data-fields-for="${activeType}"]`);
    const out: Record<string, string> = {};
    if (!block) return out;
    block.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-field]").forEach((el) => {
      const key = el.getAttribute("data-field")!;
      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        out[key] = el.checked ? "true" : "false";
      } else {
        out[key] = el.value;
      }
    });
    return out;
  }

  function isDynamic(): boolean {
    if (RICH_TYPES.has(activeType)) return true;
    return !!dynamicToggle?.checked;
  }

  function showError(msg: string): void {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError(): void {
    if (errorEl) errorEl.hidden = true;
  }

  // -- live preview --------------------------------------------------------
  async function refreshPreview(): Promise<void> {
    const payload = {
      type: activeType,
      isDynamic: isDynamic(),
      content: readContent(),
      design: readDesign(),
    };
    try {
      const res = await fetch("/api/qr/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as PreviewResponse;

      // Scannability warning (shown whenever contrast is borderline).
      if (warnEl) {
        if (data.scannable === false) {
          warnEl.textContent = "These colors are too low-contrast to scan reliably. We'll fall back to safe colors on export.";
          warnEl.hidden = false;
          warnEl.setAttribute("data-tone", "danger");
        } else if (data.warn) {
          warnEl.textContent = `Contrast is a little low (${data.ratio ?? "?"}:1). It should still scan — aim for 7:1 or higher to be safe.`;
          warnEl.hidden = false;
          warnEl.setAttribute("data-tone", "warning");
        } else {
          warnEl.hidden = true;
        }
      }

      if (data.ok && data.svg && previewSurface) {
        previewSurface.innerHTML = data.svg;
        lastSvg = data.svg;
        clearError();
      } else if (!data.ok && data.error) {
        // Expected while a required field is still empty — keep last good SVG.
        clearError();
      }
    } catch {
      showError("Couldn't refresh the preview. Check your connection and keep editing.");
    }
  }

  function schedulePreview(): void {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(refreshPreview, 220);
  }

  // -- type switching ------------------------------------------------------
  function selectType(type: string): void {
    activeType = type;
    root!.setAttribute("data-active-type", type);
    root!.querySelectorAll<HTMLButtonElement>("[data-type-pick]").forEach((b) => {
      const on = b.getAttribute("data-type-pick") === type;
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
    root!.querySelectorAll<HTMLElement>("[data-fields-for]").forEach((f) => {
      f.hidden = f.getAttribute("data-fields-for") !== type;
    });
    // Rich types are always dynamic — lock the toggle on and hide the choice.
    const rich = RICH_TYPES.has(type);
    if (dynamicToggle) {
      if (rich) {
        dynamicToggle.checked = true;
        dynamicToggle.disabled = true;
      } else {
        dynamicToggle.disabled = false;
      }
    }
    if (dynamicPanel) dynamicPanel.hidden = rich;
    schedulePreview();
  }

  root.querySelectorAll<HTMLButtonElement>("[data-type-pick]").forEach((btn) => {
    btn.addEventListener("click", () => selectType(btn.getAttribute("data-type-pick")!));
  });

  // -- input wiring --------------------------------------------------------
  root.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t.matches("[data-field], [data-design], [data-dynamic]")) {
      schedulePreview();
    }
  });
  root.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    if (t.matches("[data-field], [data-design], [data-dynamic]")) {
      schedulePreview();
    }
  });

  // -- Brand Match ---------------------------------------------------------
  const brandBtn = root.querySelector<HTMLButtonElement>("#studio-brand");
  const brandNote = root.querySelector<HTMLElement>("#studio-brand-note");
  if (brandBtn) {
    brandBtn.addEventListener("click", async () => {
      const urlField =
        root!.querySelector<HTMLInputElement>(
          `[data-fields-for="${activeType}"] [data-field="url"]`,
        ) ?? root!.querySelector<HTMLInputElement>('[data-field="url"]');
      const url = (urlField?.value || "").trim();
      if (!url) {
        if (brandNote) brandNote.textContent = "Add a destination URL first, then Brand it.";
        return;
      }
      brandBtn.disabled = true;
      if (brandNote) brandNote.textContent = "Matching your brand…";
      try {
        const res = await fetch("/api/brand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          design?: QrDesign;
          logoDataUrl?: string | null;
          title?: string;
          source?: string;
        };
        if (!res.ok || !data.ok || !data.design) {
          if (brandNote) brandNote.textContent = "Couldn't read that site's brand — try another URL.";
          return;
        }
        const d = data.design;
        const set = (key: string, val: string | undefined) => {
          if (val == null) return;
          const el = root!.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-design="${key}"]`);
          if (el) el.value = val;
        };
        set("fg", d.fg);
        set("bg", d.bg);
        set("moduleShape", d.moduleShape);
        set("eyeStyle", d.eyeStyle);
        set("ecc", d.ecc);
        if (logoHidden) logoHidden.value = data.logoDataUrl || "";
        refreshPreview();
        if (brandNote) brandNote.textContent = `Matched to ${data.title || data.source || "your site"}.`;
      } catch {
        if (brandNote) brandNote.textContent = "Couldn't reach Brand Match. Check your connection.";
      } finally {
        brandBtn.disabled = false;
      }
    });
  }

  // -- logo upload ---------------------------------------------------------
  if (logoInput) {
    logoInput.addEventListener("change", async () => {
      const file = logoInput.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
        if (data.ok && data.url && logoHidden) {
          logoHidden.value = new URL(data.url, location.origin).href;
          schedulePreview();
        } else {
          showError(data.error || "Logo upload failed.");
        }
      } catch {
        showError("Logo upload failed. Try a smaller image.");
      }
    });
  }

  // -- save ----------------------------------------------------------------
  async function save(): Promise<void> {
    clearError();
    const body = {
      type: activeType,
      title: titleInput?.value ?? "",
      isDynamic: isDynamic(),
      content: readContent(),
      design: readDesign(),
      ...(RICH_TYPES.has(activeType) ? { page: readContent() } : {}),
      ...(isDynamic() && !RICH_TYPES.has(activeType)
        ? { destination: readContent().url ?? readContent().fileUrl ?? "" }
        : {}),
    };

    try {
      const url = mode === "edit" && qrId ? `/api/qr/${qrId}` : "/api/qr";
      const method = mode === "edit" && qrId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok: boolean; qr?: { id: string }; error?: string };
      if (data.ok && data.qr) {
        location.href = `/app/${data.qr.id}`;
      } else {
        showError(data.error || "Couldn't save this QR code.");
      }
    } catch {
      showError("Couldn't save. Check your connection and try again.");
    }
  }

  saveBtn?.addEventListener("click", save);

  // -- exports -------------------------------------------------------------
  function currentSvg(): string {
    return previewSurface?.querySelector("svg")?.outerHTML ?? lastSvg;
  }

  function exportName(): string {
    const t = (titleInput?.value || "sqanny-qr").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return t || "sqanny-qr";
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSvg(): void {
    const svg = currentSvg();
    if (!svg) return showError("Nothing to export yet.");
    downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${exportName()}.svg`);
  }

  // Rasterize the preview SVG onto a canvas at a fixed export resolution.
  function svgToCanvas(scale = 1024): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
      const svg = currentSvg();
      if (!svg) return reject(new Error("no svg"));
      // Ensure an explicit white background for the raster (scannability).
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = scale;
        canvas.height = scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          return reject(new Error("no 2d context"));
        }
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, scale, scale);
        ctx.drawImage(img, 0, 0, scale, scale);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image load failed"));
      };
      img.src = url;
    });
  }

  async function exportPng(): Promise<void> {
    try {
      const canvas = await svgToCanvas(1024);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `${exportName()}.png`);
        else showError("PNG export failed.");
      }, "image/png");
    } catch {
      showError("PNG export failed.");
    }
  }

  // Minimal single-page PDF embedding a JPEG of the code (no dependencies).
  // JPEG maps directly to PDF's DCTDecode filter, so no compression lib is needed.
  async function exportPdf(): Promise<void> {
    try {
      const canvas = await svgToCanvas(1024);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      const jpegBytes = dataUrlToBytes(dataUrl);
      const pdf = buildPdf(jpegBytes, 1024, 1024);
      downloadBlob(new Blob([pdf as BlobPart], { type: "application/pdf" }), `${exportName()}.pdf`);
    } catch {
      showError("PDF export failed.");
    }
  }

  root.querySelectorAll<HTMLElement>("[data-export]").forEach((el) => {
    el.closest(".btn")?.addEventListener("click", () => {
      const kind = el.getAttribute("data-export");
      if (kind === "svg") exportSvg();
      else if (kind === "png") void exportPng();
      else if (kind === "pdf") void exportPdf();
    });
  });

  // -- initial sync --------------------------------------------------------
  selectType(activeType);
}

// --- PDF helpers (tiny, image-only single page) ----------------------------

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a minimal valid PDF embedding a JPEG image (DCTDecode), centered on a square page. */
function buildPdf(jpeg: Uint8Array, imgW: number, imgH: number): Uint8Array {
  const encoder = new TextEncoder();
  // Page = 612x612pt (square), image scaled to 512pt centered.
  const page = 612;
  const drawn = 512;
  const off = (page - drawn) / 2;

  const objects: Array<Uint8Array> = [];
  const push = (s: string | Uint8Array) => objects.push(typeof s === "string" ? encoder.encode(s) : s);

  // 1: Catalog, 2: Pages, 3: Page, 4: Contents, 5: Image XObject
  push("<< /Type /Catalog /Pages 2 0 R >>");
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page} ${page}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
  const content = `q ${drawn} 0 0 ${drawn} ${off} ${off} cm /Im0 Do Q`;
  push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const imgHeader = `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`;

  // Assemble the file with a cross-reference table.
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const write = (b: Uint8Array) => { parts.push(b); pos += b.length; };

  write(encoder.encode("%PDF-1.4\n"));
  for (let i = 0; i < objects.length; i++) {
    offsets[i] = pos;
    if (i === 4) {
      // Image object: the embedded bytes are a JPEG, decoded by PDF's DCTDecode.
      write(encoder.encode(`${i + 1} 0 obj\n`));
      write(encoder.encode(imgHeader));
      write(jpeg);
      write(encoder.encode("\nendstream\nendobj\n"));
    } else {
      write(encoder.encode(`${i + 1} 0 obj\n`));
      write(objects[i]);
      write(encoder.encode("\nendobj\n"));
    }
  }
  const xrefPos = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  write(encoder.encode(xref));
  write(encoder.encode(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
