import { Hono } from "hono";
import type { AppEnv } from "../../middleware/auth";
import { requireApiAuth } from "../../middleware/auth";
import {
  createQr,
  getQrById,
  updateQr,
  deleteQrForUser,
  upsertDynamicPage,
  getBusinessForUser,
  type QrRow,
  type DynamicPageKind,
} from "../../db/queries";
import {
  getRegistryByQrCodeId,
  moveAssetBusiness,
  setAssetDestination,
} from "../../db/qr-registry";
import { normalizeUrl } from "../../lib/validate";
import type { QrType } from "../../types";
import type { QrDesign, QrFields } from "../../lib/qr/types";
import { buildPayload } from "../../lib/qr/content";
import { encodeMatrix } from "../../lib/qr/encoder";
import { renderSvg } from "../../lib/qr/render-svg";
import { isScannable, safePalette } from "../../lib/qr/scannability";
import { ensureUniqueShortCode } from "../../lib/shortcode";
import { canCreateDynamic } from "../../lib/plans";

export const qrApi = new Hono<AppEnv>();
qrApi.use("/api/qr/*", requireApiAuth);

// ---------------------------------------------------------------------------
// Shared validation / normalisation
//
// `normalizeUrl` is imported from lib/validate rather than redefined. This file
// used to carry a third, looser policy that accepted `mailto:` and never
// required a host, while the claim flow required a dotted hostname â€” so one URL
// could be stored by this route and rejected by the other. One policy, one place.
// ---------------------------------------------------------------------------

const QR_TYPES: readonly QrType[] = [
  "url", "text", "wifi", "email", "tel", "sms", "vcard",
  "pdf", "menu", "business", "appstore", "social",
];

/** Rich types are always dynamic and host a landing page at /p/<short_code>. */
const RICH_TYPES: readonly QrType[] = ["pdf", "menu", "business", "appstore", "social"];

function isRich(type: QrType): boolean {
  return RICH_TYPES.includes(type);
}

const MODULE_SHAPES: ReadonlyArray<QrDesign["moduleShape"]> = ["square", "dots", "rounded"];
const EYE_STYLES: ReadonlyArray<QrDesign["eyeStyle"]> = ["square", "rounded", "circle"];
const ECCS: ReadonlyArray<QrDesign["ecc"]> = ["L", "M", "Q", "H"];

/** Brand-safe defaults so a half-filled design object never crashes the renderer. */
const DEFAULT_DESIGN: QrDesign = {
  fg: "#0D0D0F",
  bg: "#FFFFFF",
  moduleShape: "square",
  eyeStyle: "square",
  ecc: "M",
};

/** Coerce an arbitrary client object into a valid, fully-resolved QrDesign. */
function normalizeDesign(input: unknown): QrDesign {
  const d = (input ?? {}) as Record<string, unknown>;
  const fg = typeof d.fg === "string" && /^#?[0-9a-fA-F]{3,6}$/.test(d.fg)
    ? (d.fg.startsWith("#") ? d.fg : `#${d.fg}`)
    : DEFAULT_DESIGN.fg;
  const bg = typeof d.bg === "string" && /^#?[0-9a-fA-F]{3,6}$/.test(d.bg)
    ? (d.bg.startsWith("#") ? d.bg : `#${d.bg}`)
    : DEFAULT_DESIGN.bg;
  const moduleShape = MODULE_SHAPES.includes(d.moduleShape as QrDesign["moduleShape"])
    ? (d.moduleShape as QrDesign["moduleShape"])
    : DEFAULT_DESIGN.moduleShape;
  const eyeStyle = EYE_STYLES.includes(d.eyeStyle as QrDesign["eyeStyle"])
    ? (d.eyeStyle as QrDesign["eyeStyle"])
    : DEFAULT_DESIGN.eyeStyle;
  const ecc = ECCS.includes(d.ecc as QrDesign["ecc"])
    ? (d.ecc as QrDesign["ecc"])
    : DEFAULT_DESIGN.ecc;

  const design: QrDesign = { fg, bg, moduleShape, eyeStyle, ecc };
  if (typeof d.logo === "string" && d.logo.length > 0) {
    design.logo = d.logo;
    // A centered logo knocks out ~22% of modules â€” force max error correction
    // so the code still decodes regardless of the requested ECC level.
    design.ecc = "H";
  }
  if (typeof d.frameLabel === "string" && d.frameLabel.length > 0) {
    design.frameLabel = d.frameLabel.slice(0, 40);
  }
  if (typeof d.size === "number" && d.size > 0) design.size = d.size;
  // Clamp to the 4-module ISO quiet zone minimum (never below).
  design.margin = Math.max(4, typeof d.margin === "number" ? d.margin : 4);
  return design;
}

/**
 * Convert the studio's flat form fields into the STRUCTURED shape the hosted
 * landing pages (routes/pages.tsx) expect. The studio sends raw text fields
 * (e.g. a "Name | Price" textarea); pages.tsx renders sections[]/links[]/etc.
 * Without this transform the rich pages render empty.
 */
function normalizePageData(kind: DynamicPageKind, raw: unknown): Record<string, unknown> {
  const f = normalizeFields(raw);
  switch (kind) {
    case "menu":
      return {
        title: f.name || undefined,
        subtitle: f.tagline || undefined,
        currency: f.currency || undefined,
        sections: parseMenuSections(f.items ?? ""),
      };
    case "social":
      return {
        name: f.name || undefined,
        bio: f.bio || undefined,
        avatar: f.avatar || undefined,
        links: parseLabeledLinks(f.links ?? ""),
      };
    case "business":
      return {
        name: f.name || undefined,
        title: f.title || undefined,
        company: f.company || undefined,
        bio: f.bio || f.tagline || undefined,
        phone: f.phone || undefined,
        email: f.email || undefined,
        website: f.website ? normalizeUrl(f.website) : undefined,
        address: f.address || undefined,
        mapUrl: f.mapUrl || undefined,
      };
    case "appstore":
      return {
        appName: f.appName || f.name || undefined,
        tagline: f.tagline || undefined,
        icon: f.icon || undefined,
        iosUrl: f.iosUrl || undefined,
        androidUrl: f.androidUrl || undefined,
        fallbackUrl: f.fallbackUrl ? normalizeUrl(f.fallbackUrl) : undefined,
      };
    case "pdf":
      return {
        title: f.title || undefined,
        description: f.description || undefined,
        fileUrl: f.fileUrl || undefined,
        fileName: f.fileName || undefined,
      };
    default:
      return f;
  }
}

/**
 * Parse a menu textarea into sections. A line with "|" is "Name | Price"
 * (optionally "Name | Price | Description"); a line without "|" starts a new
 * named section. This supports both a flat list and a sectioned menu.
 */
function parseMenuSections(text: string): Array<{ title?: string; items: Array<{ name: string; price?: string; description?: string }> }> {
  const sections: Array<{ title?: string; items: Array<{ name: string; price?: string; description?: string }> }> = [];
  let current: { title?: string; items: Array<{ name: string; price?: string; description?: string }> } = { items: [] };
  for (const lineRaw of text.split("\n")) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.includes("|")) {
      const [name, price, description] = line.split("|").map((s) => s.trim());
      if (name) current.items.push({ name, ...(price ? { price } : {}), ...(description ? { description } : {}) });
    } else {
      // A bare line is a section heading; flush the current section first.
      if (current.items.length || current.title) sections.push(current);
      current = { title: line, items: [] };
    }
  }
  if (current.items.length || current.title) sections.push(current);
  return sections;
}

/** Parse a "Label | URL" (one per line) textarea into link objects. */
function parseLabeledLinks(text: string): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [];
  for (const lineRaw of text.split("\n")) {
    const line = lineRaw.trim();
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    const [label, url] = parts.length >= 2 ? parts : [parts[0], parts[0]];
    if (url) links.push({ label: label || url, url: normalizeUrl(url) ?? url });
  }
  return links;
}

/** Coerce client content into a flat string map (the QrFields contract). */
function normalizeFields(input: unknown): QrFields {
  const out: QrFields = {};
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Render the static image for a type+fields+design. Throws on invalid payload
 * (e.g. missing required field) so callers can surface a 400.
 */
function renderStatic(type: QrType, fields: QrFields, design: QrDesign): string {
  const payload = buildPayload(type, fields);
  const matrix = encodeMatrix(payload, design.ecc);
  return renderSvg(matrix, safePalette(design));
}

/** Render the image that encodes a dynamic redirect URL (so re-targeting never reprints). */
function renderDynamic(redirectUrl: string, design: QrDesign): string {
  const matrix = encodeMatrix(redirectUrl, design.ecc);
  return renderSvg(matrix, safePalette(design));
}

interface CreateBody {
  type?: string;
  title?: string;
  isDynamic?: boolean;
  destination?: string;
  content?: Record<string, unknown>;
  design?: Record<string, unknown>;
  /** rich page payload (menu/business/social/appstore/pdf) */
  page?: Record<string, unknown>;
  /** attach to a business on creation; null/undefined = not assigned */
  business_id?: string | null;
}

// ---------------------------------------------------------------------------
// POST /api/qr â€” create
// ---------------------------------------------------------------------------

qrApi.post("/api/qr", async (c) => {
  const user = c.get("user")!;
  let body: CreateBody;
  try {
    body = await c.req.json<CreateBody>();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const type = body.type as QrType;
  if (!type || !QR_TYPES.includes(type)) {
    return c.json({ ok: false, error: "Unknown QR type." }, 400);
  }

  const title = (body.title ?? "").trim() || titleFromType(type);
  const design = normalizeDesign(body.design);
  const fields = normalizeFields(body.content);

  // The business id arrives from the request body, so membership is verified
  // before it is written. Without this check a caller could file a code under
  // another tenant's business id and have it appear in their dashboard.
  let businessId: string | null = null;
  const requestedBusiness =
    typeof body.business_id === "string" ? body.business_id.trim() : "";
  if (requestedBusiness) {
    const business = await getBusinessForUser(
      c.env.DB,
      requestedBusiness,
      user.id,
    );
    if (!business || business.status !== "active") {
      return c.json(
        { ok: false, error: "That business isn't available." },
        400,
      );
    }
    businessId = business.id;
  }

  // Rich types are forced dynamic; otherwise honour the toggle.
  const rich = isRich(type);
  const wantDynamic = rich || body.isDynamic === true;

  // Plan gate for any dynamic code.
  if (wantDynamic) {
    const allowed = await canCreateDynamic(c.env, { id: user.id, plan_id: user.plan_id });
    if (!allowed) {
      return c.json(
        {
          ok: false,
          error: "You've reached your plan's dynamic QR limit. Upgrade to make more permanent.",
          code: "plan_limit",
        },
        402,
      );
    }
  }

  try {
    if (wantDynamic) {
      const short_code = await ensureUniqueShortCode(c.env.DB);
      // NULL means "deferred": the printed code is live but has nowhere to send
      // anyone yet, so /r/<code> renders the claim page instead of a 302.
      let destination: string | null;
      let dynamicKind: DynamicPageKind | null = null;

      if (rich) {
        // Rich page: the redirect points at the hosted landing /p/<code>.
        destination = `${c.env.APP_URL}/p/${short_code}`;
        dynamicKind = type as DynamicPageKind;
      } else {
        // Plain dynamic: redirect to the user's target. An empty value is the
        // studio's "set the destination later" signal, not an error â€” but a
        // non-empty value that is NOT a valid http(s) URL is a mistake worth
        // rejecting, because it would otherwise be stored and 302'd to later.
        const rawDest = (body.destination ?? "").trim() || (fields.url ?? "").trim();
        if (rawDest) {
          destination = normalizeUrl(rawDest);
          if (!destination) {
            return c.json(
              {
                ok: false,
                error: "That destination isn't a valid web address. Include https:// â€” or turn on 'Set the destination later' to leave it blank.",
              },
              400,
            );
          }
        } else {
          destination = null;
        }
      }

      // Validate the printed image encodes (the /r/<code> redirect).
      renderDynamic(`${c.env.APP_URL}/r/${short_code}`, design);

      const row = await createQr(c.env.DB, {
        user_id: user.id,
        type,
        title,
        is_dynamic: true,
        short_code,
        destination,
        content_json: JSON.stringify(fields),
        design_json: JSON.stringify(design),
        business_id: businessId,
      });

      if (rich) {
        // Use the rich form's own content fields when no explicit page payload
        // is sent, and normalize either into the structured page shape.
        await upsertDynamicPage(c.env.DB, {
          qr_id: row.id,
          kind: dynamicKind!,
          data_json: JSON.stringify(normalizePageData(dynamicKind!, body.page ?? fields)),
        });
      }

      return c.json({ ok: true, qr: row }, 201);
    }

    // Static QR â€” validate by rendering (throws on missing required field).
    renderStatic(type, fields, design);
    const row = await createQr(c.env.DB, {
      user_id: user.id,
      type,
      title,
      is_dynamic: false,
      content_json: JSON.stringify(fields),
      design_json: JSON.stringify(design),
      business_id: businessId,
    });
    return c.json({ ok: true, qr: row }, 201);
  } catch (err) {
    return c.json({ ok: false, error: messageOf(err) }, 400);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/qr/:id â€” update (ownership enforced)
// ---------------------------------------------------------------------------

interface PatchBody {
  title?: string;
  destination?: string;
  content?: Record<string, unknown>;
  design?: Record<string, unknown>;
  page?: Record<string, unknown>;
  /** reassign between businesses; null clears the assignment */
  business_id?: string | null;
}

/**
 * The registry row that owns this configuration, if any.
 *
 * A `source = 'registration'` row IS the configuration half of a physical stand.
 * Writing to it has to go through the registry service so `qr_registry` and
 * `qr_codes` cannot drift â€” otherwise the stand's business and status in the
 * ledger disagree with its actual configuration, and /qrs (which reads through
 * the ledger) shows the wrong business or "Setup pending" for a QR that is
 * already serving traffic.
 */
async function registryForQr(db: D1Database, qr: QrRow) {
  if (qr.source !== "registration") return null;
  return getRegistryByQrCodeId(db, qr.id);
}

qrApi.patch("/api/qr/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const qr = await getQrById(c.env.DB, id);
  if (!qr || qr.user_id !== user.id) {
    return c.json({ ok: false, error: "Not found." }, 404);
  }

  let body: PatchBody;
  try {
    body = await c.req.json<PatchBody>();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const registry = await registryForQr(c.env.DB, qr);
  // A retired stand must stay retired: an edit is not a reason to start serving
  // again. Refused before any field is written, so it is all-or-nothing.
  if (registry?.status === "archived") {
    return c.json(
      {
        ok: false,
        error:
          "This stand is retired, so it can't be edited. Restore it from your Sqanny Stands page first.",
        code: "archived",
      },
      409,
    );
  }

  const patch: Record<string, string | number | null> = {};

  if (typeof body.title === "string") {
    const t = body.title.trim();
    if (t) patch.title = t;
  }

  // Reassignment is membership-checked for the same reason creation is: the id
  // comes from the client, and a code filed under someone else's business would
  // surface in their dashboard. Only an explicit null (or "") clears it â€”
  // omitting the key leaves the assignment alone, so a partial PATCH that
  // happens not to mention a business cannot silently detach it.
  let moveTo: string | null | undefined;
  if (body.business_id !== undefined) {
    const requested =
      typeof body.business_id === "string" ? body.business_id.trim() : "";
    if (!requested) {
      moveTo = null;
    } else {
      const business = await getBusinessForUser(c.env.DB, requested, user.id);
      if (!business || business.status !== "active") {
        return c.json(
          { ok: false, error: "That business isn't available." },
          400,
        );
      }
      moveTo = business.id;
    }
    if (!registry) patch.business_id = moveTo;
  }

  if (typeof body.design === "object" && body.design !== null) {
    patch.design_json = JSON.stringify(normalizeDesign(body.design));
  }

  if (typeof body.content === "object" && body.content !== null) {
    patch.content_json = JSON.stringify(normalizeFields(body.content));
  }

  // Destination is only meaningful for plain (non-rich) dynamic codes.
  if (typeof body.destination === "string" && qr.is_dynamic === 1 && !isRich(qr.type)) {
    const dest = normalizeUrl(body.destination.trim());
    if (!dest) {
      return c.json({ ok: false, error: "Destination cannot be empty." }, 400);
    }
    patch.destination = dest;
  }

  if (Object.keys(patch).length > 0) {
    const ok = await updateQr(c.env.DB, id, user.id, patch);
    if (!ok) {
      return c.json({ ok: false, error: "Not found." }, 404);
    }
  }

  // The two registry-coupled writes go through the service, which keeps the
  // ledger in step. They run only after the generic patch has been accepted, so a
  // rejected field never leaves half the configuration applied.
  if (registry && moveTo !== undefined && moveTo !== qr.business_id) {
    const moved = await moveAssetBusiness(c.env.DB, {
      qrCodeId: qr.id,
      ownerId: user.id,
      businessId: moveTo,
    });
    if (!moved.ok) {
      return c.json(
        { ok: false, error: "That business isn't available." },
        400,
      );
    }
  }

  if (registry && typeof patch.destination === "string") {
    const set = await setAssetDestination(c.env.DB, {
      qrCodeId: qr.id,
      ownerId: user.id,
      destination: patch.destination,
    });
    if (!set.ok) {
      return c.json({ ok: false, error: "Not found." }, 404);
    }
  }

  // Rich page content lives in dynamic_pages; editing it never changes the QR image.
  if (typeof body.page === "object" && body.page !== null && isRich(qr.type)) {
    await upsertDynamicPage(c.env.DB, {
      qr_id: qr.id,
      kind: qr.type as DynamicPageKind,
      data_json: JSON.stringify(normalizePageData(qr.type as DynamicPageKind, body.page)),
    });
  }

  const updated = await getQrById(c.env.DB, id);
  return c.json({ ok: true, qr: updated });
});

// ---------------------------------------------------------------------------
// DELETE /api/qr/:id â€” delete (ownership enforced, stands exempt)
// ---------------------------------------------------------------------------

const DELETE_REASONS: Record<"is-stand" | "has-scans", string> = {
  "is-stand":
    "This is a Sqanny Stand, so it can't be deleted. Retire it from your Sqanny Stands page instead â€” that keeps its permanent code and its scan history.",
  "has-scans":
    "This code has scan history, which is kept for your records. Create a new code instead of deleting this one.",
};

qrApi.delete("/api/qr/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  // deleteQrForUser re-derives ownership, provenance and scan history in the
  // database rather than trusting this route's earlier read.
  const result = await deleteQrForUser(c.env.DB, id, user.id);

  if (!result.ok) {
    if (result.reason === "not-found") {
      return c.json({ ok: false, error: "Not found." }, 404);
    }
    return c.json(
      { ok: false, error: DELETE_REASONS[result.reason], code: result.reason },
      409,
    );
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/qr/preview â€” authed live preview (no strict rate-limit)
// ---------------------------------------------------------------------------

interface PreviewBody {
  type?: string;
  isDynamic?: boolean;
  content?: Record<string, unknown>;
  design?: Record<string, unknown>;
}

qrApi.post("/api/qr/preview", async (c) => {
  // Auth is enforced by qrApi.use("/api/qr/*", requireApiAuth); read the user to
  // make that explicit (and to keep parity with the other handlers).
  c.get("user");
  let body: PreviewBody;
  try {
    body = await c.req.json<PreviewBody>();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const type = body.type as QrType;
  if (!type || !QR_TYPES.includes(type)) {
    return c.json({ ok: false, error: "Unknown QR type." }, 400);
  }

  const design = normalizeDesign(body.design);
  const fields = normalizeFields(body.content);
  const scan = isScannable(design);
  const rich = isRich(type);
  const dynamic = rich || body.isDynamic === true;

  try {
    let svg: string;
    if (dynamic) {
      // Preview uses a stable placeholder code so the matrix looks representative.
      svg = renderDynamic(`${c.env.APP_URL}/r/preview1`, design);
    } else {
      svg = renderStatic(type, fields, design);
    }
    return c.json({
      ok: true,
      svg,
      scannable: scan.ok,
      warn: scan.warn,
      ratio: Math.round(scan.ratio * 100) / 100,
    });
  } catch (err) {
    // A missing required field is an expected, recoverable state while typing.
    return c.json({
      ok: false,
      error: messageOf(err),
      scannable: scan.ok,
      warn: scan.warn,
      ratio: Math.round(scan.ratio * 100) / 100,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/qr/:id.svg â€” the stored QR as a downloadable SVG image
// ---------------------------------------------------------------------------

qrApi.get("/api/qr/:id{.+\\.svg}", async (c) => {
  const user = c.get("user")!;
  const raw = c.req.param("id");
  const id = raw.replace(/\.svg$/, "");
  const qr = await getQrById(c.env.DB, id);
  if (!qr || qr.user_id !== user.id) {
    return c.text("Not Found", 404);
  }

  const design = parseDesign(qr.design_json);
  let svg: string;
  try {
    if (qr.is_dynamic === 1 && qr.short_code) {
      svg = renderDynamic(`${c.env.APP_URL}/r/${qr.short_code}`, design);
    } else {
      const fields = parseFields(qr.content_json);
      svg = renderStatic(qr.type, fields, design);
    }
  } catch {
    return c.text("Unable to render QR.", 422);
  }

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-store",
      // `attachment`, not `inline` — THIS IS THE DOWNLOAD BUG.
      //
      // A browser that NAVIGATES to a displayable content type displays it. An
      // SVG is displayable, so `inline` meant the "Download SVG" button opened
      // the code in a tab and the user had to right-click → Save As.
      //
      // `attachment` is the response header that makes the navigation a download.
      // The filename is derived from the QR's own title so it is deterministic
      // and meaningful, rather than "download.svg".
      //
      // A consumer that genuinely wants to EMBED the code (the studio preview,
      // an <img> tag) does not navigate here — it fetches the bytes or renders
      // its own preview, neither of which is affected by a disposition header.
      "content-disposition": `attachment; filename="${slugify(qr.title)}.svg"`,
    },
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDesign(json: string): QrDesign {
  try {
    return normalizeDesign(JSON.parse(json));
  } catch {
    return { ...DEFAULT_DESIGN };
  }
}

function parseFields(json: string): QrFields {
  try {
    return normalizeFields(JSON.parse(json));
  } catch {
    return {};
  }
}

function titleFromType(type: QrType): string {
  const labels: Record<QrType, string> = {
    url: "Website link",
    text: "Plain text",
    wifi: "Wi-Fi network",
    email: "Email",
    tel: "Phone number",
    sms: "Text message",
    vcard: "Contact card",
    pdf: "PDF document",
    menu: "Menu",
    business: "Business page",
    appstore: "App download",
    social: "Social links",
  };
  return labels[type] ?? "QR code";
}

function slugify(s: string): string {
  return (s || "sqanny-qr")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "sqanny-qr";
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Could not build this QR code. Check the fields and try again.";
}

export type { QrRow };
