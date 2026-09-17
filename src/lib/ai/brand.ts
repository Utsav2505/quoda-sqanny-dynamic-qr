import type { Bindings } from "../../types";
import type { QrDesign } from "../qr/types";
import { isScannable, safePalette } from "../qr/scannability";

/**
 * Brand Match — turn a destination URL into an on-brand, still-scannable QR design.
 *
 * Pipeline (every AI step is best-effort with a safe fallback, so this never
 * throws and always returns a usable design):
 *   1. fetch the site HTML → extract theme-color, favicon/app-icon, og:image, title
 *   2. pick the best brand image; derive a palette (theme-color, else a vision model)
 *   3. embed the brand icon as the QR's centre logo (data URI)
 *   4. enforce scannability (safePalette + ECC=H when a logo is present)
 *
 * Models are native Workers AI (no gateway / no provider keys). The model ids are
 * isolated below so a hosted instance can later swap in premium models.
 */

// --- model ids (native Workers AI; gateway-free) ---
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export interface BrandKit {
  design: QrDesign;
  logoDataUrl?: string;
  /** URL of the brand image used (for downstream style/vibe analysis) */
  imageUrl?: string;
  /** site meta description — what the brand does (for thematic wallpaper motifs) */
  description?: string;
  palette: { fg: string; bg: string; accent: string };
  title: string;
  source: string;
  ai: boolean;
}

interface BrandSignals {
  title: string;
  themeColor?: string;
  iconUrls: string[];
  ogImage?: string;
  description?: string;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SAFE_FG = "#0D0D0F";
const SAFE_BG = "#FFFFFF";
const MAX_HTML_BYTES = 600_000;
const MAX_IMG_BYTES = 300_000;

/** Add a scheme to a bare host and return a URL, or null if unusable. */
export function normalizeUrl(raw: string): URL | null {
  const t = (raw || "").trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

/** Parse brand signals out of raw HTML (pure — no network). */
export function extractBrandSignals(html: string, base: URL): BrandSignals {
  const abs = (href: string): string | null => {
    try {
      return new URL(href, base).toString();
    } catch {
      return null;
    }
  };

  const titleMatch = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : base.hostname;

  // theme-color (content may precede or follow name=)
  let themeColor: string | undefined;
  const tc =
    /<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i.exec(html);
  if (tc && HEX_RE.test(tc[1].trim())) themeColor = tc[1].trim();

  // icons: collect <link rel="...icon...">, prefer apple-touch-icon and PNG/SVG
  const icons: { href: string; rel: string }[] = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const rel = /rel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!rel.includes("icon")) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    const a = abs(href);
    if (a) icons.push({ href: a, rel });
  }
  // og:image
  const og =
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i.exec(html);
  const ogImage = og ? abs(og[1]) ?? undefined : undefined;

  // description: what the brand does (meta description, else og:description) —
  // used to derive a thematic wallpaper motif.
  const desc =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i.exec(html) ||
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:description["']/i.exec(html);
  const description = desc ? decodeEntities(desc[1].trim()).slice(0, 300) : undefined;

  // Rank icons: apple-touch first, then non-.ico, then the rest. Always include
  // the conventional /favicon.ico as a last resort.
  const score = (i: { href: string; rel: string }): number => {
    let s = 0;
    if (i.rel.includes("apple-touch")) s += 4;
    if (/\.svg(\?|$)/i.test(i.href)) s += 3;
    if (/\.png(\?|$)/i.test(i.href)) s += 2;
    if (/\.ico(\?|$)/i.test(i.href)) s -= 2;
    return s;
  };
  const ranked = icons.sort((a, b) => score(b) - score(a)).map((i) => i.href);
  ranked.push(new URL("/favicon.ico", base).toString());

  return { title, themeColor, iconUrls: [...new Set(ranked)], ogImage, description };
}

/** Fetch an image and return it as a data URI if it's a usable raster/svg, else null. */
async function fetchImageDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cf: { cacheTtl: 3600 } as RequestInitCfProperties });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    // Only embed types that render reliably inside an SVG <image>.
    const ok = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"].some((t) =>
      ct.includes(t),
    );
    if (!ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMG_BYTES) return null;
    const b64 = base64(buf);
    const mime = ct.split(";")[0].trim();
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

/** Ask the vision model for a brand palette from an image. Best-effort. */
async function visionPalette(
  env: Bindings,
  imageUrl: string,
): Promise<{ fg?: string; bg?: string } | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.byteLength || buf.byteLength > MAX_IMG_BYTES) return null;
    const out = (await env.AI.run(VISION_MODEL, {
      image: [...buf],
      prompt:
        'This is a brand logo. Reply with ONLY compact JSON, no prose: {"primary":"#RRGGBB","background":"#RRGGBB"}. primary = the brand\'s main dark/saturated color; background = its light backdrop.',
      max_tokens: 120,
    })) as { response?: string };
    const txt = out?.response ?? "";
    const j = /\{[\s\S]*\}/.exec(txt);
    if (!j) return null;
    const parsed = JSON.parse(j[0]) as { primary?: string; background?: string };
    const fg = parsed.primary && HEX_RE.test(parsed.primary) ? parsed.primary : undefined;
    const bg = parsed.background && HEX_RE.test(parsed.background) ? parsed.background : undefined;
    return { fg, bg };
  } catch {
    return null;
  }
}

/**
 * Produce a brand-matched, scannable QR design for a destination URL.
 * Returns null only if the URL itself is invalid.
 */
export async function brandMatch(env: Bindings, rawUrl: string): Promise<BrandKit | null> {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  const source = url.hostname.replace(/^www\./, "");

  // 1) cache by host (versioned so signal/extraction changes take effect)
  const cacheKey = `brand:v2:${source}`;
  try {
    const cached = await env.SCAN_COUNTERS.get(cacheKey);
    if (cached) return JSON.parse(cached) as BrandKit;
  } catch {
    /* cache miss is fine */
  }

  // 2) fetch + parse the site (best-effort)
  let signals: BrandSignals = { title: source, iconUrls: [new URL("/favicon.ico", url).toString()] };
  try {
    const res = await fetch(url.toString(), {
      headers: {
        "user-agent": "SqannyBrandMatch/1.0 (+https://sqanny.codebyte.dev)",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
      const html = (await res.text()).slice(0, MAX_HTML_BYTES);
      signals = extractBrandSignals(html, new URL(res.url || url.toString()));
    }
  } catch {
    /* fall back to defaults */
  }

  // 3) centre logo: first icon/image that embeds cleanly
  let logoDataUrl: string | undefined;
  let imageUrl: string | undefined;
  const candidates = [...signals.iconUrls, ...(signals.ogImage ? [signals.ogImage] : [])];
  for (const c of candidates) {
    logoDataUrl = (await fetchImageDataUrl(c)) ?? undefined;
    if (logoDataUrl) {
      imageUrl = c;
      break;
    }
  }
  if (!imageUrl) imageUrl = signals.ogImage ?? candidates[0];

  // 4) palette: theme-color first, else vision model on the brand image
  let usedAI = false;
  let brandFg = signals.themeColor;
  let brandBg: string | undefined;
  if (!brandFg && candidates.length) {
    const v = await visionPalette(env, candidates[0]);
    if (v?.fg) {
      brandFg = v.fg;
      brandBg = v.bg;
      usedAI = true;
    }
  }

  // 5) build a scannable design. Brand color tints the modules only if it passes
  //    contrast on white; otherwise modules stay ink-dark (scannability is sacred).
  let fg = SAFE_FG;
  const bg = SAFE_BG;
  if (brandFg && HEX_RE.test(brandFg) && isScannable({ fg: brandFg, bg }).ok) {
    fg = brandFg;
  }
  const design: QrDesign = safePalette({
    fg,
    bg,
    moduleShape: "rounded",
    eyeStyle: "rounded",
    ecc: logoDataUrl ? "H" : "M",
    margin: 4,
    ...(logoDataUrl ? { logo: logoDataUrl } : {}),
  });

  const kit: BrandKit = {
    design,
    logoDataUrl,
    imageUrl,
    description: signals.description,
    palette: { fg, bg, accent: brandFg && HEX_RE.test(brandFg) ? brandFg : fg },
    title: signals.title || source,
    source,
    ai: usedAI,
  };

  // cache 24h (ignore failures)
  try {
    await env.SCAN_COUNTERS.put(cacheKey, JSON.stringify(kit), { expirationTtl: 86_400 });
  } catch {
    /* non-fatal */
  }
  return kit;
}

// --- helpers ---

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}
