// QR Wallpaper island. The server picks a creative ART DIRECTION per brand and
// returns the AI background + real QR SVG + brand text + colours. This island
// composites a full branded poster on a 1080x1800 canvas — with a DISTINCT render
// pipeline per direction (signal / ember / neon / editorial / terrain) so brands
// don't all look alike. The QR and ALL text are drawn programmatically (never
// AI-drawn) so the code always scans and the wordmark/tagline are always correct.

type Direction = "signal" | "ember" | "neon" | "editorial" | "terrain";

interface WallpaperResponse {
  ok?: boolean;
  backgroundDataUrl?: string | null;
  aiBackground?: boolean;
  gradient?: { from: string; via: string; to: string };
  qrSvg?: string;
  title?: string;
  source?: string;
  target?: string;
  logo?: string;
  wordmark?: string;
  subtitle?: string;
  tagline?: string;
  glow?: string;
  direction?: Direction;
  dark?: boolean;
  error?: string;
}

const root = document;
const urlInput = root.getElementById("wp-url") as HTMLInputElement | null;
const brandInput = root.getElementById("wp-brand") as HTMLInputElement | null;
const genBtn = root.getElementById("wp-generate") as HTMLButtonElement | null;
const regenBtn = root.getElementById("wp-regen") as HTMLButtonElement | null;
const downloadBtn = root.getElementById("wp-download") as HTMLButtonElement | null;
const statusEl = root.getElementById("wp-status");
const actions = root.getElementById("wp-actions");
const canvas = root.getElementById("wp-canvas") as HTMLCanvasElement | null;
const empty = root.getElementById("wp-empty");

if (urlInput && genBtn && canvas) {
  let style = "auto";
  let lastSource = "wallpaper";
  const DEFAULT_GLOW = "#5B8CFF";
  type Ctx = CanvasRenderingContext2D;

  const setStatus = (m: string) => {
    if (statusEl) statusEl.textContent = m;
  };

  const wireChips = (attr: string, set: (v: string) => void) => {
    root.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((chip) => {
      chip.addEventListener("click", () => {
        root.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((c) => {
          c.classList.remove("wp-chip-on");
          c.setAttribute("aria-pressed", "false");
        });
        chip.classList.add("wp-chip-on");
        chip.setAttribute("aria-pressed", "true");
        set(chip.getAttribute(attr)!);
      });
    });
  };
  wireChips("data-wp-style", (v) => (style = v));

  // ---------------------------------------------------------------- colour utils
  function rgb(hex: string): [number, number, number] {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    const n = m ? parseInt(m[1], 16) : 0x5b8cff;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hexA(hex: string, a: number): string {
    const [r, g, b] = rgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }
  function toHex(r: number, g: number, b: number): string {
    const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  function lighten(hex: string, f: number): string {
    const [r, g, b] = rgb(hex);
    const L = (v: number) => v + (255 - v) * (f - 1);
    return toHex(L(r), L(g), L(b));
  }
  function lerp(a: string, b: string, t: number): string {
    const A = rgb(a),
      B = rgb(b);
    return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }
  function hue([r, g, b]: [number, number, number]): number {
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    if (d === 0) return 0;
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }
  function hueDist(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /** Primary + secondary vivid colours sampled from the logo (same-origin data URL). */
  function logoColors(img: HTMLImageElement): { primary: string; secondary: string } | null {
    try {
      const s = 46;
      const oc = document.createElement("canvas");
      oc.width = s;
      oc.height = s;
      const octx = oc.getContext("2d");
      if (!octx) return null;
      octx.drawImage(img, 0, 0, s, s);
      const d = octx.getImageData(0, 0, s, s).data;
      const samples: { r: number; g: number; b: number; w: number; h: number }[] = [];
      let pr = 0,
        pg = 0,
        pb = 0,
        pw = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i],
          g = d[i + 1],
          b = d[i + 2];
        if (d[i + 3] < 128) continue;
        const max = Math.max(r, g, b),
          min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        if (sat < 0.35 || max < 50 || max > 245) continue;
        const w = sat * (1 - Math.abs(max - 175) / 175);
        const h = hue([r, g, b]);
        samples.push({ r, g, b, w, h });
        pr += r * w;
        pg += g * w;
        pb += b * w;
        pw += w;
      }
      if (pw <= 0) return null;
      const primary = toHex(pr / pw, pg / pw, pb / pw);
      const ph = hue(rgb(primary));
      // secondary = vivid pixels whose hue differs most from primary
      let sr = 0,
        sg = 0,
        sb = 0,
        sw = 0;
      for (const p of samples) {
        if (hueDist(p.h, ph) < 45) continue;
        sr += p.r * p.w;
        sg += p.g * p.w;
        sb += p.b * p.w;
        sw += p.w;
      }
      const secondary = sw > pw * 0.12 ? toHex(sr / sw, sg / sw, sb / sw) : lighten(primary, 1.45);
      return { primary, secondary };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- draw helpers
  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load failed"));
      img.src = src;
    });
  }
  function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  async function ensureFonts() {
    try {
      const f = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (!f) return;
      await Promise.all(
        ["300 96px Inter", "400 22px Inter", "600 48px Inter", "700 52px Inter", "800 64px Inter", "900 80px Inter"].map(
          (s) => f.load(s),
        ),
      );
      await f.ready;
    } catch {
      /* system fonts */
    }
  }
  function coverDraw(ctx: Ctx, img: HTMLImageElement, W: number, H: number) {
    const scale = Math.max(W / img.width, H / img.height);
    const bw = img.width * scale,
      bh = img.height * scale;
    ctx.drawImage(img, (W - bw) / 2, (H - bh) / 2, bw, bh);
  }
  /** Wordmark = logo mark + name, on a baseline midY. align: center | left. */
  function wordmarkBlock(
    ctx: Ctx,
    data: WallpaperResponse,
    logoImg: HTMLImageElement | null,
    opts: { x: number; midY: number; align: "center" | "left"; size: number; weight: number; color: string; ls?: number; upper?: boolean },
  ) {
    let wm = data.wordmark || data.source || "";
    if (opts.upper) wm = wm.toUpperCase();
    const { size, weight, color } = opts;
    ctx.save();
    ctx.font = `${weight} ${size}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.letterSpacing = `${opts.ls ?? -1}px`;
    const textW = ctx.measureText(wm).width;
    let lw = 0,
      lh = 0,
      gap = 0;
    if (logoImg) {
      lh = Math.round(size * 1.08);
      lw = (logoImg.width / logoImg.height) * lh || lh;
      gap = Math.round(size * 0.26);
    }
    const totalW = (logoImg ? lw + gap : 0) + textW;
    let x = opts.align === "center" ? opts.x - totalW / 2 : opts.x;
    if (logoImg) {
      ctx.drawImage(logoImg, x, opts.midY - lh / 2, lw, lh);
      x += lw + gap;
    }
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 16;
    ctx.fillText(wm, x, opts.midY);
    ctx.restore();
  }
  function drawText(ctx: Ctx, text: string, x: number, y: number, o: { size: number; weight: number; color: string; ls?: number; align?: CanvasTextAlign; upper?: boolean }) {
    ctx.save();
    ctx.font = `${o.weight} ${o.size}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = o.color;
    ctx.textAlign = o.align ?? "center";
    ctx.textBaseline = "middle";
    ctx.letterSpacing = `${o.ls ?? 0}px`;
    ctx.fillText(o.upper ? text.toUpperCase() : text, x, y);
    ctx.restore();
  }
  /** A clean white quiet-zone card with the QR drawn inside. Always scannable. */
  function qrCard(ctx: Ctx, qr: HTMLImageElement, cx: number, cy: number, qrSize: number, o: { radius: number; pad?: number; fill?: string }) {
    const pad = o.pad ?? Math.round(qrSize * 0.11);
    const size = qrSize + pad * 2;
    roundRect(ctx, cx - size / 2, cy - size / 2, size, size, o.radius);
    ctx.fillStyle = o.fill ?? "#FFFFFF";
    ctx.fill();
    ctx.drawImage(qr, cx - qrSize / 2, cy - qrSize / 2, qrSize, qrSize);
    return size;
  }
  /** A white quiet-zone panel + QR, inset inside a coloured/frosted outer card. */
  function whiteInset(ctx: Ctx, qr: HTMLImageElement, cx: number, cy: number, qs: number, padFrac: number, r: number) {
    const inset = qs + Math.round(qs * padFrac);
    roundRect(ctx, cx - inset / 2, cy - inset / 2, inset, inset, r);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.drawImage(qr, cx - qs / 2, cy - qs / 2, qs, qs);
  }
  function tagWords(tagline?: string): string[] {
    return (tagline || "").split(/\s*[·.|]\s*/).filter(Boolean);
  }
  function drawTagline(ctx: Ctx, W: number, y: number, words: string[], a: string, b: string) {
    if (!words.length) return;
    const fs = Math.round(W * 0.0265);
    ctx.save();
    ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.letterSpacing = `${Math.round(fs * 0.1)}px`;
    const sep = "   ·   ";
    const sepW = ctx.measureText(sep).width;
    const ww = words.map((w) => ctx.measureText(w).width);
    const total = ww.reduce((s, v) => s + v, 0) + sepW * (words.length - 1);
    let x = (W - total) / 2;
    for (let i = 0; i < words.length; i++) {
      const t = words.length > 1 ? i / (words.length - 1) : 0;
      ctx.fillStyle = lerp(a, b, t);
      ctx.shadowColor = hexA(a, 0.5);
      ctx.shadowBlur = 12;
      ctx.fillText(words[i], x, y);
      x += ww[i];
      if (i < words.length - 1) {
        ctx.shadowBlur = 0;
        ctx.fillStyle = hexA(a, 0.4);
        ctx.fillText(sep, x, y);
        x += sepW;
      }
    }
    ctx.restore();
  }
  function darkFallback(ctx: Ctx, W: number, H: number, data: WallpaperResponse, glow: string) {
    const g = data.gradient ?? { from: "#0d0d12", via: "#1a2740", to: "#070709" };
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, g.from);
    grad.addColorStop(0.5, g.via);
    grad.addColorStop(1, g.to);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    const rg = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, W);
    rg.addColorStop(0, hexA(glow, 0.22));
    rg.addColorStop(1, hexA(glow, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }
  function scrim(ctx: Ctx, W: number, H: number, topA = 0.7, botA = 0.8) {
    const t = ctx.createLinearGradient(0, 0, 0, H * 0.34);
    t.addColorStop(0, `rgba(6,6,9,${topA})`);
    t.addColorStop(1, "rgba(6,6,9,0)");
    ctx.fillStyle = t;
    ctx.fillRect(0, 0, W, H * 0.34);
    const b = ctx.createLinearGradient(0, H * 0.62, 0, H);
    b.addColorStop(0, "rgba(6,6,9,0)");
    b.addColorStop(1, `rgba(6,6,9,${botA})`);
    ctx.fillStyle = b;
    ctx.fillRect(0, H * 0.62, W, H * 0.38);
  }

  // ---------------------------------------------------------------- directions
  // SIGNAL — dark technical grid, left-aligned, sharp double-ruled card + brackets
  function renderSignal(ctx: Ctx, W: number, H: number, data: WallpaperResponse, qr: HTMLImageElement, logo: HTMLImageElement | null, p: string) {
    // grid + vignette overlay (the AI/fallback background is already painted)
    ctx.save();
    ctx.strokeStyle = hexA(p, 0.1);
    ctx.lineWidth = 1;
    const step = 46;
    for (let x = 0; x <= W; x += step) ctx.strokeRect(x, 0, 0.01, H);
    for (let y = 0; y <= H; y += step) ctx.strokeRect(0, y, W, 0.01);
    ctx.restore();
    const vg = ctx.createRadialGradient(W / 2, H * 0.46, W * 0.2, W / 2, H * 0.5, W * 0.95);
    vg.addColorStop(0, "rgba(7,7,9,0)");
    vg.addColorStop(1, "rgba(7,7,9,0.92)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    const m = Math.round(W * 0.1);
    wordmarkBlock(ctx, data, logo, { x: m, midY: Math.round(H * 0.13), align: "left", size: Math.round(W * 0.05), weight: 700, color: "#fff", ls: 1, upper: true });
    if (data.subtitle) drawText(ctx, data.subtitle, m, Math.round(H * 0.175), { size: Math.round(W * 0.0185), weight: 400, color: p, ls: Math.round(W * 0.006), align: "left", upper: true });
    // rule above card
    ctx.save();
    ctx.strokeStyle = hexA(p, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(m, Math.round(H * 0.31));
    ctx.lineTo(W - m, Math.round(H * 0.31));
    ctx.stroke();
    ctx.restore();
    const cx = W / 2,
      cy = Math.round(H * 0.53),
      qs = Math.round(W * 0.44);
    const size = qrCard(ctx, qr, cx, cy, qs, { radius: 0 });
    // double-rule border + corner brackets
    ctx.save();
    ctx.strokeStyle = p;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
    ctx.strokeStyle = hexA(p, 0.5);
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - size / 2 - 7, cy - size / 2 - 7, size + 14, size + 14);
    const bl = 26;
    ctx.strokeStyle = p;
    ctx.lineWidth = 3;
    for (const [bx, by, dx, dy] of [
      [cx - size / 2 - 7, cy - size / 2 - 7, 1, 1],
      [cx + size / 2 + 7, cy - size / 2 - 7, -1, 1],
      [cx - size / 2 - 7, cy + size / 2 + 7, 1, -1],
      [cx + size / 2 + 7, cy + size / 2 + 7, -1, -1],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(bx + dx * bl, by);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx, by + dy * bl);
      ctx.stroke();
    }
    ctx.restore();
    const words = tagWords(data.tagline);
    if (words.length) {
      ctx.save();
      ctx.font = `300 ${Math.round(W * 0.018)}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = hexA(p, 0.9);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.letterSpacing = `${Math.round(W * 0.006)}px`;
      ctx.fillText(words.join("   /   ").toUpperCase(), W - m, Math.round(H * 0.88));
      ctx.restore();
    }
  }

  // EMBER — warm, centered, cream text, hang-tag card, logo-tile pattern
  function renderEmber(ctx: Ctx, W: number, H: number, data: WallpaperResponse, qr: HTMLImageElement, logo: HTMLImageElement | null, p: string) {
    const cream = "#FDF6EC";
    // soft warm vignette over the (already warm) bg
    const vg = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.5, W);
    vg.addColorStop(0, "rgba(20,10,4,0)");
    vg.addColorStop(1, "rgba(15,7,2,0.7)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    // logo-tile pattern
    if (logo) {
      ctx.save();
      ctx.globalAlpha = 0.06;
      ctx.translate(W / 2, H / 2);
      ctx.rotate(-Math.PI / 8);
      const ts = 120;
      for (let y = -H; y < H; y += ts) for (let x = -W; x < W; x += ts) ctx.drawImage(logo, x, y, 56, 56);
      ctx.restore();
    }
    const cx = W / 2;
    wordmarkBlock(ctx, data, logo, { x: cx, midY: Math.round(H * 0.17), align: "center", size: Math.round(W * 0.058), weight: 600, color: cream, ls: 0.5 });
    if (data.subtitle) drawText(ctx, data.subtitle, cx, Math.round(H * 0.215), { size: Math.round(W * 0.0195), weight: 300, color: hexA(cream, 0.8), ls: Math.round(W * 0.005), upper: true });
    // decorative divider with diamond
    ctx.save();
    ctx.strokeStyle = hexA(p, 0.55);
    ctx.fillStyle = p;
    ctx.lineWidth = 1.5;
    const dy = Math.round(H * 0.25),
      hw = Math.round(W * 0.16);
    ctx.beginPath();
    ctx.moveTo(cx - hw, dy);
    ctx.lineTo(cx - 14, dy);
    ctx.moveTo(cx + 14, dy);
    ctx.lineTo(cx + hw, dy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, dy - 6);
    ctx.lineTo(cx + 6, dy);
    ctx.lineTo(cx, dy + 6);
    ctx.lineTo(cx - 6, dy);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const cy = Math.round(H * 0.53),
      qs = Math.round(W * 0.46);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 36;
    ctx.shadowOffsetY = 16;
    const size = qrCard(ctx, qr, cx, cy, qs, { radius: 26, fill: cream });
    ctx.restore();
    // double label border + hang-tag holes
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = p;
    roundRect(ctx, cx - size / 2 + 8, cy - size / 2 + 8, size - 16, size - 16, 18);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.arc(cx - size * 0.3, cy - size / 2 + 2, 7, 0, Math.PI * 2);
    ctx.arc(cx + size * 0.3, cy - size / 2 + 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    drawTagline(ctx, W, Math.round(H * 0.84), tagWords(data.tagline), p, lighten(p, 1.4));
  }

  // NEON — very dark, oversized chroma-split wordmark, scanlines, neon-inset card
  function renderNeon(ctx: Ctx, W: number, H: number, data: WallpaperResponse, qr: HTMLImageElement, logo: HTMLImageElement | null, p: string, sec: string) {
    scrim(ctx, W, H, 0.66, 0.78);
    // scanlines
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    ctx.restore();
    const cx = W / 2;
    if (logo) {
      const lh = Math.round(W * 0.14),
        lw = (logo.width / logo.height) * lh || lh;
      ctx.drawImage(logo, cx - lw / 2, Math.round(H * 0.1), lw, lh);
    }
    // chroma-split wordmark
    const wm = (data.wordmark || data.source || "").toUpperCase();
    const fs = Math.round(W * 0.072);
    ctx.save();
    ctx.font = `900 ${fs}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.letterSpacing = "-1px";
    const wy = Math.round(H * 0.215);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = sec;
    ctx.fillText(wm, cx - 3, wy);
    ctx.fillStyle = lighten(p, 1.2);
    ctx.fillText(wm, cx + 3, wy);
    ctx.globalAlpha = 1;
    ctx.shadowColor = hexA(p, 0.7);
    ctx.shadowBlur = 24;
    ctx.fillStyle = "#fff";
    ctx.fillText(wm, cx, wy);
    ctx.restore();
    if (data.subtitle) drawText(ctx, data.subtitle, cx, Math.round(H * 0.265), { size: Math.round(W * 0.018), weight: 700, color: sec, ls: Math.round(W * 0.005), upper: true });
    // neon-bordered dark card with white inset QR panel
    const cy = Math.round(H * 0.54),
      qs = Math.round(W * 0.44),
      pad = Math.round(qs * 0.13),
      size = qs + pad * 2;
    ctx.save();
    ctx.shadowColor = p;
    ctx.shadowBlur = 45;
    roundRect(ctx, cx - size / 2, cy - size / 2, size, size, 18);
    ctx.fillStyle = "#0b0b10";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = p;
    ctx.stroke();
    ctx.restore();
    whiteInset(ctx, qr, cx, cy, qs, 0.08, 8);
    // tagline in translucent band
    const words = tagWords(data.tagline);
    if (words.length) {
      const by = Math.round(H * 0.84);
      ctx.fillStyle = "rgba(8,8,12,0.45)";
      ctx.fillRect(0, by - Math.round(W * 0.05), W, Math.round(W * 0.1));
      drawTagline(ctx, W, by, words, lighten(p, 1.2), sec);
    }
  }

  // EDITORIAL — light/paper, off-center oversized lightface, vertical tagline spine
  function renderEditorial(ctx: Ctx, W: number, H: number, data: WallpaperResponse, qr: HTMLImageElement, logo: HTMLImageElement | null, p: string) {
    const ink = "#1A1A1A";
    if (!data.backgroundDataUrl) {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "#F4F1EC");
      g.addColorStop(1, "#E7E2D8");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = "rgba(245,242,236,0.32)";
      ctx.fillRect(0, 0, W, H);
    }
    // ghost logo watermark
    if (logo) {
      ctx.save();
      ctx.globalAlpha = 0.05;
      const gs = Math.round(W * 0.8);
      ctx.drawImage(logo, W / 2 - gs / 2, H * 0.5 - gs / 2, gs, gs);
      ctx.restore();
    }
    const m = Math.round(W * 0.08);
    // small logo top-right
    if (logo) {
      const ls = Math.round(W * 0.07),
        lw = (logo.width / logo.height) * ls || ls;
      ctx.drawImage(logo, W - m - lw, Math.round(H * 0.08), lw, ls);
    }
    // oversized lightface wordmark, left
    drawText(ctx, data.wordmark || data.source || "", m, Math.round(H * 0.24), { size: Math.round(W * 0.108), weight: 300, color: ink, ls: Math.round(W * 0.004), align: "left", upper: true });
    if (data.subtitle) drawText(ctx, data.subtitle, m, Math.round(H * 0.3), { size: Math.round(W * 0.0165), weight: 400, color: hexA(ink, 0.7), ls: Math.round(W * 0.006), align: "left", upper: true });
    // QR card bottom-left with accent left-rule + hairline + shadow
    const qs = Math.round(W * 0.42),
      pad = Math.round(qs * 0.1),
      size = qs + pad * 2;
    const cardX = m,
      cardY = Math.round(H * 0.82) - size;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.18)";
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = "#fff";
    ctx.fillRect(cardX, cardY, size, size);
    ctx.restore();
    ctx.strokeStyle = "rgba(0,0,0,0.1)";
    ctx.lineWidth = 1;
    ctx.strokeRect(cardX + 0.5, cardY + 0.5, size - 1, size - 1);
    ctx.fillStyle = p;
    ctx.fillRect(cardX, cardY, 4, size);
    ctx.drawImage(qr, cardX + pad, cardY + pad, qs, qs);
    // vertical tagline spine on the right
    const words = tagWords(data.tagline);
    if (words.length) {
      ctx.save();
      ctx.translate(W - Math.round(W * 0.05), H * 0.5);
      ctx.rotate(Math.PI / 2);
      ctx.font = `300 ${Math.round(W * 0.016)}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = hexA(ink, 0.75);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.letterSpacing = `${Math.round(W * 0.008)}px`;
      ctx.fillText(words.join("   —   ").toUpperCase(), 0, 0);
      ctx.restore();
    }
  }

  // TERRAIN — pictorial full-bleed, frosted top/bottom bars, crosshair card
  function renderTerrain(ctx: Ctx, W: number, H: number, data: WallpaperResponse, qr: HTMLImageElement, logo: HTMLImageElement | null, p: string) {
    // light top + bottom gradient so frosted bars read, leave the middle painting clear
    const topH = Math.round(H * 0.17),
      botH = Math.round(H * 0.4);
    ctx.fillStyle = "rgba(10,12,16,0.5)";
    ctx.fillRect(0, 0, W, topH);
    ctx.save();
    ctx.fillStyle = "rgba(8,10,14,0.55)";
    ctx.fillRect(0, H - botH, W, botH);
    ctx.restore();
    // top bar: wordmark + subtitle
    wordmarkBlock(ctx, data, logo, { x: W / 2, midY: Math.round(topH * 0.42), align: "center", size: Math.round(W * 0.044), weight: 600, color: "#fff", ls: 0.5 });
    if (data.subtitle) drawText(ctx, data.subtitle, W / 2, Math.round(topH * 0.74), { size: Math.round(W * 0.0165), weight: 300, color: "rgba(255,255,255,0.8)", ls: Math.round(W * 0.005), upper: true });
    // bottom frosted bar: QR (frosted glass with white inset) + crosshair + tagline
    const cx = W / 2,
      cy = H - Math.round(botH * 0.56),
      qs = Math.round(W * 0.4),
      pad = Math.round(qs * 0.14),
      size = qs + pad * 2;
    ctx.save();
    roundRect(ctx, cx - size / 2, cy - size / 2, size, size, 22);
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.stroke();
    ctx.restore();
    // crosshair
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - size / 2);
    ctx.lineTo(cx, cy - qs / 2 - 6);
    ctx.moveTo(cx, cy + qs / 2 + 6);
    ctx.lineTo(cx, cy + size / 2);
    ctx.moveTo(cx - size / 2, cy);
    ctx.lineTo(cx - qs / 2 - 6, cy);
    ctx.moveTo(cx + qs / 2 + 6, cy);
    ctx.lineTo(cx + size / 2, cy);
    ctx.stroke();
    ctx.restore();
    whiteInset(ctx, qr, cx, cy, qs, 0.06, 10);
    drawTagline(ctx, W, H - Math.round(botH * 0.12), tagWords(data.tagline), "#ffffff", p);
  }

  async function compose(data: WallpaperResponse) {
    const ctx = canvas!.getContext("2d")!;
    const W = canvas!.width;
    const H = canvas!.height;
    await ensureFonts();
    ctx.clearRect(0, 0, W, H);

    const qr = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(data.qrSvg!));
    let logo: HTMLImageElement | null = null;
    if (data.logo) {
      try {
        logo = await loadImage(data.logo);
      } catch {
        logo = null;
      }
    }
    const cols = logo ? logoColors(logo) : null;
    const primary = cols?.primary || data.glow || DEFAULT_GLOW;
    const secondary = cols?.secondary || lighten(primary, 1.4);
    const direction = data.direction || "signal";

    // background
    if (data.backgroundDataUrl) {
      coverDraw(ctx, await loadImage(data.backgroundDataUrl), W, H);
    } else if (direction === "editorial") {
      // light fallback handled inside renderEditorial
    } else {
      darkFallback(ctx, W, H, data, primary);
    }

    switch (direction) {
      case "ember":
        renderEmber(ctx, W, H, data, qr, logo, primary);
        break;
      case "neon":
        renderNeon(ctx, W, H, data, qr, logo, primary, secondary);
        break;
      case "editorial":
        renderEditorial(ctx, W, H, data, qr, logo, primary);
        break;
      case "terrain":
        renderTerrain(ctx, W, H, data, qr, logo, primary);
        break;
      default:
        renderSignal(ctx, W, H, data, qr, logo, primary);
    }

    empty?.setAttribute("hidden", "");
    canvas!.style.display = "block";
    actions?.removeAttribute("hidden");
  }

  async function generate() {
    const url = (urlInput!.value || "").trim();
    if (!url) {
      setStatus("Add a destination URL first.");
      return;
    }
    const brandUrl = (brandInput?.value || "").trim();
    genBtn!.disabled = true;
    if (regenBtn) regenBtn.setAttribute("disabled", "");
    setStatus("Art-directing your poster… this takes a few seconds.");
    try {
      const res = await fetch("/api/wallpaper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, brandUrl, style }),
      });
      if (res.status === 429) {
        setStatus("Busy right now — give it a moment, then try again.");
        return;
      }
      const data = (await res.json()) as WallpaperResponse;
      if (!res.ok || !data.ok || !data.qrSvg) {
        setStatus("Couldn't generate that wallpaper — try another URL or style.");
        return;
      }
      lastSource = data.source || "wallpaper";
      await compose(data);
      const themed = data.wordmark || data.title || data.source || "your site";
      const dir = data.direction ? ` · ${data.direction} direction` : "";
      const decoupled = data.target && data.source && data.target !== data.source;
      const opens = decoupled ? ` Code opens ${data.target}.` : "";
      setStatus(`Styled like ${themed}${dir}.${opens} Set it as your wallpaper.`);
    } catch {
      setStatus("Couldn't reach the wallpaper service. Check your connection.");
    } finally {
      genBtn!.disabled = false;
      if (regenBtn) regenBtn.removeAttribute("disabled");
    }
  }

  genBtn.addEventListener("click", generate);
  regenBtn?.addEventListener("click", generate);

  downloadBtn?.addEventListener("click", () => {
    canvas!.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${lastSource}-sqanny-wallpaper.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  });
}
