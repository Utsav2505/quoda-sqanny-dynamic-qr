import { Hono } from "hono";
import type { Bindings, QrType } from "../../types";
import type { QrDesign, QrFields } from "../../lib/qr/types";
import { buildPayload } from "../../lib/qr/content";
import { encodeMatrix } from "../../lib/qr/encoder";
import { renderSvg } from "../../lib/qr/render-svg";
import { safePalette } from "../../lib/qr/scannability";

export const previewApi = new Hono<{ Bindings: Bindings }>();

// Public, unauthenticated live-preview endpoint powering the marketing
// generator. Renders a QR SVG for the supplied content + (optional) design.
// Rate-limited per client IP via the RATE_LIMIT KV so the open tool can't be
// abused as a free render farm.

/**
 * Requests allowed per IP per fixed window.
 *
 * Exported so the rate-limit test can assert against the real budget instead of
 * hardcoding a number that drifts whenever this is retuned. Raised from 60
 * because the studio's live preview now actually works, and a 350ms debounce
 * over a long typing burst exceeds 60/min on its own.
 */
export const RATE_LIMIT_MAX = 300;
/** Fixed window length in seconds. */
const RATE_WINDOW_SECONDS = 60;

/** Brand-safe default design when the client supplies none. */
const DEFAULT_DESIGN: QrDesign = {
  // Literal hex is correct here: this is the exported image asset (not UI
  // chrome). Dark modules on white — the invariant scannable palette.
  fg: "#0D0D0F",
  bg: "#FFFFFF",
  moduleShape: "square",
  eyeStyle: "square",
  ecc: "M",
  margin: 4,
};

interface PreviewBody {
  type?: unknown;
  fields?: unknown;
  design?: unknown;
  /** True when the code is dynamic. */
  isDynamic?: unknown;
  /**
   * The code's permanent short code. When supplied for a dynamic code the
   * preview renders the ACTUAL printed payload (/r/<code>) instead of the
   * content, so the studio shows exactly the image that gets printed.
   */
  shortCode?: unknown;
}

const KNOWN_TYPES: ReadonlySet<QrType> = new Set<QrType>([
  "url", "text", "wifi", "email", "tel", "sms", "vcard",
  "pdf", "menu", "business", "appstore", "social",
]);

/** Short codes are base62 and 4–32 chars; anything else is not one we issued. */
const SHORT_CODE_RE = /^[0-9A-Za-z]{4,32}$/;

/** Best-effort client IP for rate-limit bucketing. */
function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * Fixed-window rate limiter keyed by IP. Returns true when the request is
 * within the cap. KV has no atomic increment, so this is a read-modify-write;
 * a small amount of slop under heavy concurrency is acceptable for an abuse
 * guard on a public preview.
 */
async function withinRateLimit(env: Bindings, ip: string): Promise<boolean> {
  const windowId = Math.floor(Date.now() / 1000 / RATE_WINDOW_SECONDS);
  const key = `preview:${ip}:${windowId}`;
  const current = Number(await env.RATE_LIMIT.get(key)) || 0;
  if (current >= RATE_LIMIT_MAX) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), {
    // Expire shortly after the window closes so keys never accumulate.
    expirationTtl: RATE_WINDOW_SECONDS * 2,
  });
  return true;
}

/** Coerce an arbitrary record into a string->string field map. */
function toFields(input: unknown): QrFields {
  if (!input || typeof input !== "object") return {};
  const out: QrFields = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (v != null) out[k] = String(v);
  }
  return out;
}

/** Merge a (possibly partial) client design over the safe defaults. */
function resolveDesign(input: unknown): QrDesign {
  if (!input || typeof input !== "object") return { ...DEFAULT_DESIGN };
  const d = input as Partial<QrDesign>;
  const logo = typeof d.logo === "string" ? d.logo : undefined;
  return {
    fg: typeof d.fg === "string" ? d.fg : DEFAULT_DESIGN.fg,
    bg: typeof d.bg === "string" ? d.bg : DEFAULT_DESIGN.bg,
    moduleShape: d.moduleShape ?? DEFAULT_DESIGN.moduleShape,
    eyeStyle: d.eyeStyle ?? DEFAULT_DESIGN.eyeStyle,
    // A centered logo knocks out ~22% of modules; force max error correction so
    // the code still decodes. Otherwise honour the requested level.
    ecc: logo ? "H" : (d.ecc ?? DEFAULT_DESIGN.ecc),
    logo,
    frameLabel: typeof d.frameLabel === "string" ? d.frameLabel : undefined,
    size: typeof d.size === "number" ? d.size : undefined,
    // Never below the 4-module ISO quiet zone.
    margin: Math.max(4, typeof d.margin === "number" ? d.margin : DEFAULT_DESIGN.margin ?? 4),
  };
}

previewApi.post("/api/preview", async (c) => {
  const ip = clientIp(c.req.raw);
  if (!(await withinRateLimit(c.env, ip))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  let body: PreviewBody;
  try {
    body = await c.req.json<PreviewBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const type = (typeof body.type === "string" ? body.type : "url") as QrType;
  if (!KNOWN_TYPES.has(type)) {
    return c.json({ error: "invalid_type" }, 400);
  }

  const fields = toFields(body.fields);
  const design = safePalette(resolveDesign(body.design));

  // A dynamic code's printed image encodes its permanent redirect, NOT its
  // content. Rendering the content here is what made the studio show a code
  // that differed from the one actually on the label.
  const wantsDynamic = body.isDynamic === true;
  const shortCode = typeof body.shortCode === "string" ? body.shortCode : "";
  const isDynamicCode = wantsDynamic && SHORT_CODE_RE.test(shortCode);

  let payload: string;
  if (isDynamicCode) {
    payload = `${c.env.APP_URL}/r/${shortCode}`;
  } else if (wantsDynamic && !shortCode) {
    // Create mode for a code that defers its destination: there is no code and
    // no URL to encode yet. Say so explicitly rather than rendering a QR for an
    // empty string, which would look like a real (broken) code.
    return c.json({ error: "no_code_yet" }, 400);
  } else {
    try {
      payload = buildPayload(type, fields);
    } catch {
      // Missing/empty required field for this type — not an error the user needs
      // to see as a crash; surface a clean 400 the island can ignore silently.
      return c.json({ error: "incomplete" }, 400);
    }
  }

  let svg: string;
  try {
    const matrix = encodeMatrix(payload, design.ecc);
    svg = renderSvg(matrix, design);
  } catch {
    return c.json({ error: "encode_failed" }, 400);
  }

  return c.json({ svg, payload });
});
