import { Hono } from "hono";
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { getQrById, getDynamicPageByQrId, type QrRow } from "../db/queries";
import type { QrType } from "../types";
import type { QrDesign, QrFields } from "../lib/qr/types";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { QrPreview } from "../ui/components/qr-preview";
import { Icon, type IconName } from "../ui/icons";
import { encodeMatrix } from "../lib/qr/encoder";
import { renderSvg } from "../lib/qr/render-svg";
import { safePalette } from "../lib/qr/scannability";
import { buildPayload } from "../lib/qr/content";

export const studio = new Hono<AppEnv>();
studio.use("/app/*", requireAuth);

// ---------------------------------------------------------------------------
// Type catalogue
// ---------------------------------------------------------------------------

interface TypeDef {
  type: QrType;
  icon: IconName;
  label: string;
  blurb: string;
  /** rich types are always dynamic (hosted landing page) */
  rich: boolean;
}

const TYPES: TypeDef[] = [
  { type: "url", icon: "url", label: "Website", blurb: "Link to any URL", rich: false },
  { type: "text", icon: "text", label: "Text", blurb: "Plain text note", rich: false },
  { type: "wifi", icon: "wifi", label: "Wi-Fi", blurb: "Auto-join a network", rich: false },
  { type: "email", icon: "email", label: "Email", blurb: "Pre-filled message", rich: false },
  { type: "tel", icon: "tel", label: "Phone", blurb: "Tap to call", rich: false },
  { type: "sms", icon: "sms", label: "SMS", blurb: "Pre-filled text", rich: false },
  { type: "vcard", icon: "vcard", label: "Contact", blurb: "Save a vCard", rich: false },
  { type: "pdf", icon: "pdf", label: "PDF", blurb: "Host a document", rich: true },
  { type: "menu", icon: "menu", label: "Menu", blurb: "Digital menu page", rich: true },
  { type: "business", icon: "business", label: "Business", blurb: "Company landing", rich: true },
  { type: "appstore", icon: "appstore", label: "App", blurb: "Smart store redirect", rich: true },
  { type: "social", icon: "social", label: "Social", blurb: "All your links", rich: true },
];

// Per-type content fields. `kind` maps to the input control; `key` is the field
// name the content builder / dynamic page expects.
interface FieldDef {
  key: string;
  label: string;
  kind: "text" | "url" | "email" | "tel" | "password" | "textarea" | "select" | "checkbox";
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  hint?: string;
}

const FIELDS: Record<QrType, FieldDef[]> = {
  url: [{ key: "url", label: "Website URL", kind: "url", placeholder: "example.com", required: true }],
  text: [{ key: "text", label: "Text", kind: "textarea", placeholder: "Anything you like", required: true }],
  wifi: [
    { key: "ssid", label: "Network name (SSID)", kind: "text", placeholder: "My Network", required: true },
    { key: "password", label: "Password", kind: "password", placeholder: "••••••••" },
    {
      key: "auth", label: "Security", kind: "select",
      options: [
        { value: "WPA", label: "WPA/WPA2" },
        { value: "WEP", label: "WEP" },
        { value: "nopass", label: "Open (no password)" },
      ],
    },
    { key: "hidden", label: "Hidden network", kind: "checkbox" },
  ],
  email: [
    { key: "email", label: "To", kind: "email", placeholder: "you@example.com", required: true },
    { key: "subject", label: "Subject", kind: "text", placeholder: "Hello" },
    { key: "body", label: "Message", kind: "textarea", placeholder: "Your message" },
  ],
  tel: [{ key: "phone", label: "Phone number", kind: "tel", placeholder: "+1 555 000 1234", required: true }],
  sms: [
    { key: "phone", label: "Phone number", kind: "tel", placeholder: "+1 555 000 1234", required: true },
    { key: "message", label: "Message", kind: "textarea", placeholder: "Pre-filled text" },
  ],
  vcard: [
    { key: "firstName", label: "First name", kind: "text", placeholder: "Ada", required: true },
    { key: "lastName", label: "Last name", kind: "text", placeholder: "Lovelace" },
    { key: "org", label: "Organisation", kind: "text", placeholder: "Analytical Engines" },
    { key: "title", label: "Job title", kind: "text", placeholder: "Mathematician" },
    { key: "phone", label: "Phone", kind: "tel", placeholder: "+1 555 000 1234" },
    { key: "email", label: "Email", kind: "email", placeholder: "ada@example.com" },
    { key: "url", label: "Website", kind: "url", placeholder: "example.com" },
  ],
  pdf: [
    { key: "title", label: "Document title", kind: "text", placeholder: "Spring Catalogue", required: true },
    { key: "fileUrl", label: "PDF URL", kind: "url", placeholder: "https://…/file.pdf", required: true, hint: "The hosted page links here; the printed code never changes." },
    { key: "description", label: "Description", kind: "textarea", placeholder: "What's inside" },
  ],
  menu: [
    { key: "name", label: "Place name", kind: "text", placeholder: "Café Sqanny", required: true },
    { key: "tagline", label: "Tagline", kind: "text", placeholder: "Open daily 8–6" },
    { key: "items", label: "Menu items (one per line: Name | Price)", kind: "textarea", placeholder: "Espresso | 3.00\nFlat White | 4.20", required: true },
  ],
  business: [
    { key: "name", label: "Business name", kind: "text", placeholder: "Sqanny Inc.", required: true },
    { key: "tagline", label: "Tagline", kind: "text", placeholder: "The QR code that never breaks" },
    { key: "phone", label: "Phone", kind: "tel", placeholder: "+1 555 000 1234" },
    { key: "email", label: "Email", kind: "email", placeholder: "hello@example.com" },
    { key: "website", label: "Website", kind: "url", placeholder: "example.com" },
    { key: "address", label: "Address", kind: "textarea", placeholder: "1 Market St, San Francisco" },
  ],
  appstore: [
    { key: "name", label: "App name", kind: "text", placeholder: "Sqanny", required: true },
    { key: "iosUrl", label: "App Store URL", kind: "url", placeholder: "https://apps.apple.com/…" },
    { key: "androidUrl", label: "Google Play URL", kind: "url", placeholder: "https://play.google.com/…" },
    { key: "fallbackUrl", label: "Fallback URL", kind: "url", placeholder: "example.com", hint: "Shown on desktop and other devices." },
  ],
  social: [
    { key: "name", label: "Display name", kind: "text", placeholder: "Ada Lovelace", required: true },
    { key: "bio", label: "Bio", kind: "text", placeholder: "Builder of permanent things" },
    { key: "links", label: "Links (one per line: Label | URL)", kind: "textarea", placeholder: "Instagram | https://instagram.com/…\nWebsite | example.com", required: true },
  ],
};

// ---------------------------------------------------------------------------
// Default + placeholder design
// ---------------------------------------------------------------------------

const DEFAULT_DESIGN: QrDesign = {
  fg: "#0D0D0F",
  bg: "#FFFFFF",
  moduleShape: "square",
  eyeStyle: "square",
  ecc: "M",
};

/** A representative starting QR so the preview is never blank on first paint. */
function placeholderSvg(design: QrDesign): string {
  try {
    const matrix = encodeMatrix("https://getquoda.com", design.ecc);
    return renderSvg(matrix, safePalette(design));
  } catch {
    return "";
  }
}

/** Render the exact stored QR for edit-mode initial paint. */
function initialSvg(qr: QrRow, design: QrDesign, appUrl: string): string {
  try {
    if (qr.is_dynamic === 1 && qr.short_code) {
      const matrix = encodeMatrix(`${appUrl}/r/${qr.short_code}`, design.ecc);
      return renderSvg(matrix, safePalette(design));
    }
    const fields = safeJson<QrFields>(qr.content_json, {});
    const matrix = encodeMatrix(buildPayload(qr.type, fields), design.ecc);
    return renderSvg(matrix, safePalette(design));
  } catch {
    return placeholderSvg(design);
  }
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------

const FieldControl: FC<{ type: QrType; field: FieldDef; value?: string }> = ({ type, field, value }) => {
  const id = `f-${type}-${field.key}`;
  const common = {
    id,
    name: field.key,
    "data-field": field.key,
    class: "input",
  } as const;

  if (field.kind === "textarea") {
    return (
      <div class="field">
        <label class="field-label" for={id}>{field.label}{field.required ? <span class="field-required" aria-hidden="true"> *</span> : null}</label>
        <textarea {...common} class="textarea" rows={4} placeholder={field.placeholder}>{value ?? ""}</textarea>
        {field.hint ? <p class="field-hint">{field.hint}</p> : null}
      </div>
    );
  }

  if (field.kind === "select") {
    return (
      <div class="field">
        <label class="field-label" for={id}>{field.label}</label>
        <div class="select-wrap">
          <select {...common} class="select">
            {(field.options ?? []).map((o) => (
              <option value={o.value} selected={value === o.value}>{o.label}</option>
            ))}
          </select>
          <span class="select-chevron" aria-hidden="true"><Icon name="chevron" size={18} /></span>
        </div>
      </div>
    );
  }

  if (field.kind === "checkbox") {
    return (
      <div class="field studio-check">
        <label class="studio-check-row">
          <input type="checkbox" id={id} name={field.key} data-field={field.key} value="true" checked={value === "true"} />
          <span class="field-label">{field.label}</span>
        </label>
      </div>
    );
  }

  const htmlType = field.kind === "password" ? "password" : field.kind === "email" ? "email" : field.kind === "tel" ? "tel" : field.kind === "url" ? "url" : "text";
  return (
    <div class="field">
      <label class="field-label" for={id}>{field.label}{field.required ? <span class="field-required" aria-hidden="true"> *</span> : null}</label>
      <input {...common} type={htmlType} placeholder={field.placeholder} value={value ?? ""} />
      {field.hint ? <p class="field-hint">{field.hint}</p> : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Studio view
// ---------------------------------------------------------------------------

interface StudioViewProps {
  mode: "new" | "edit";
  activeType: QrType;
  fields: QrFields;
  design: QrDesign;
  isDynamic: boolean;
  title: string;
  qrId?: string;
  /**
   * The permanent short code, edit mode only. Its presence is what makes the
   * preview render the real printed payload (/r/<code>) rather than the
   * content, so the studio always shows what is on the label.
   */
  shortCode?: string;
  previewSvg: string;
}

/**
 * "Set the destination later" — sits directly beneath the URL field on the
 * Website type, and only there, because that is the only plain type with a bare
 * destination to defer. Rich types always host their own page.
 *
 * The URL input is disabled (not hidden) while this is on: the owner should be
 * able to see the field they deferred, and toggling back must restore whatever
 * they had typed rather than silently discarding it. The client island owns
 * that enable/disable; this is the markup and the explanation.
 */
const DeferredDestinationToggle: FC = () => (
  <div class="studio-deferred" data-deferred-panel>
    <div class="studio-toggle-row">
      <label class="studio-check-row" for="qr-deferred">
        <input type="checkbox" id="qr-deferred" data-deferred />
        <span>
          <span class="field-label">Set the destination later</span>
          <span class="t-body-sm text-secondary studio-toggle-help">
            Print the code now and decide where it goes later. Scans open a page
            where a signed-in person sets the destination.
          </span>
        </span>
      </label>
    </div>
    <p class="field-hint" data-deferred-note hidden>
      This code is forced dynamic — that is what lets the printed code be
      retargeted later without reprinting it.
    </p>
  </div>
);

const StudioView: FC<StudioViewProps> = ({ mode, activeType, fields, design, isDynamic, title, qrId, shortCode, previewSvg }) => {
  return (
    <div
      class="studio"
      data-studio
      data-mode={mode}
      data-qr-id={qrId ?? ""}
      data-short-code={shortCode ?? ""}
      data-active-type={activeType}
    >
      <header class="studio-head">
        <div>
          <h1 class="t-display-md">{mode === "edit" ? "Edit QR code" : "Create a QR code"}</h1>
          <p class="t-body text-secondary studio-sub">Pick a type, fill it in, make it yours. The preview updates as you type.</p>
        </div>
      </header>

      <div class="studio-grid">
        {/* ---- Left: type picker + content + customization ---- */}
        <div class="studio-controls stack">
          {/* Type picker */}
          <section class="studio-panel" aria-labelledby="sp-type">
            <h2 class="t-heading-sm studio-panel-title" id="sp-type">Type</h2>
            <div class="studio-types" role="radiogroup" aria-label="QR code type">
              {TYPES.map((t) => (
                <button
                  type="button"
                  class="studio-type"
                  data-type-pick={t.type}
                  data-rich={t.rich ? "true" : "false"}
                  role="radio"
                  aria-checked={t.type === activeType ? "true" : "false"}
                >
                  <span class="studio-type-icon" aria-hidden="true"><Icon name={t.icon} size={20} /></span>
                  <span class="studio-type-label t-ui-label">{t.label}</span>
                  <span class="studio-type-blurb t-caption text-secondary">{t.blurb}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Title */}
          <section class="studio-panel">
            <div class="field">
              <label class="field-label" for="qr-title">Name (for your dashboard)</label>
              <input class="input" id="qr-title" name="title" type="text" data-title placeholder="My QR code" value={title} />
            </div>
          </section>

          {/* Per-type content forms (one block per type, toggled by JS) */}
          <section class="studio-panel" aria-labelledby="sp-content">
            <h2 class="t-heading-sm studio-panel-title" id="sp-content">Content</h2>
            {TYPES.map((t) => (
              <div class="studio-fields" data-fields-for={t.type} hidden={t.type !== activeType}>
                {FIELDS[t.type].map((f) => (
                  <FieldControl type={t.type} field={f} value={t.type === activeType ? fields[f.key] : undefined} />
                ))}
                {t.type === "url" ? <DeferredDestinationToggle /> : null}
                {t.rich ? (
                  <p class="studio-rich-note t-body-sm text-secondary">
                    <Icon name="link" size={14} /> This type hosts a live page and is always dynamic — the printed code points to it and never changes when you edit.
                  </p>
                ) : null}
              </div>
            ))}
          </section>

          {/* Dynamic toggle */}
          <section class="studio-panel" data-dynamic-panel>
            <div class="studio-toggle-row">
              <label class="studio-check-row" for="qr-dynamic">
                <input type="checkbox" id="qr-dynamic" data-dynamic checked={isDynamic} />
                <span>
                  <span class="field-label">Make it dynamic</span>
                  <span class="t-body-sm text-secondary studio-toggle-help">
                    Editable later without reprinting, plus scan analytics. Static codes embed the data directly and work forever, but can't be changed.
                  </span>
                </span>
              </label>
            </div>
          </section>

          {/* Customization */}
          <section class="studio-panel" aria-labelledby="sp-design">
            <h2 class="t-heading-sm studio-panel-title" id="sp-design">Customize</h2>
            {/* Brand Match — AI styles the code to the destination's brand. */}
            <div class="studio-brand">
              <button type="button" class="btn btn-secondary btn-block" id="studio-brand" data-brand>
                <span class="btn-icon" aria-hidden="true"><Icon name="sparkles" /></span>
                <span class="btn-label">Brand it with AI</span>
              </button>
              <p class="studio-brand-note t-caption text-tertiary" id="studio-brand-note" role="status" aria-live="polite">
                Pulls colors + logo from your destination URL.
              </p>
            </div>
            <div class="studio-design-grid">
              <div class="field">
                <label class="field-label" for="d-fg">Foreground</label>
                <input class="studio-color" id="d-fg" type="color" data-design="fg" value={design.fg} />
              </div>
              <div class="field">
                <label class="field-label" for="d-bg">Background</label>
                <input class="studio-color" id="d-bg" type="color" data-design="bg" value={design.bg} />
              </div>
              <div class="field">
                <label class="field-label" for="d-shape">Module shape</label>
                <div class="select-wrap">
                  <select class="select" id="d-shape" data-design="moduleShape">
                    <option value="square" selected={design.moduleShape === "square"}>Square</option>
                    <option value="dots" selected={design.moduleShape === "dots"}>Dots</option>
                    <option value="rounded" selected={design.moduleShape === "rounded"}>Rounded</option>
                  </select>
                  <span class="select-chevron" aria-hidden="true"><Icon name="chevron" size={18} /></span>
                </div>
              </div>
              <div class="field">
                <label class="field-label" for="d-eye">Eye style</label>
                <div class="select-wrap">
                  <select class="select" id="d-eye" data-design="eyeStyle">
                    <option value="square" selected={design.eyeStyle === "square"}>Square</option>
                    <option value="rounded" selected={design.eyeStyle === "rounded"}>Rounded</option>
                    <option value="circle" selected={design.eyeStyle === "circle"}>Circle</option>
                  </select>
                  <span class="select-chevron" aria-hidden="true"><Icon name="chevron" size={18} /></span>
                </div>
              </div>
              <div class="field">
                <label class="field-label" for="d-ecc">Error correction</label>
                <div class="select-wrap">
                  <select class="select" id="d-ecc" data-design="ecc">
                    <option value="L" selected={design.ecc === "L"}>Low (7%)</option>
                    <option value="M" selected={design.ecc === "M"}>Medium (15%)</option>
                    <option value="Q" selected={design.ecc === "Q"}>Quartile (25%)</option>
                    <option value="H" selected={design.ecc === "H"}>High (30%)</option>
                  </select>
                  <span class="select-chevron" aria-hidden="true"><Icon name="chevron" size={18} /></span>
                </div>
              </div>
              <div class="field">
                <label class="field-label" for="d-frame">Frame label (optional)</label>
                <input class="input" id="d-frame" type="text" maxlength={24} data-design="frameLabel" placeholder="SCAN ME" value={design.frameLabel ?? ""} />
              </div>
            </div>

            <div class="field studio-logo-field">
              <label class="field-label" for="d-logo">Logo (optional)</label>
              <input class="input" id="d-logo" type="file" accept="image/*" data-logo />
              <p class="field-hint">Centered, with a clean quiet zone. PNG, JPG, WebP or SVG up to 1MB.</p>
              <input type="hidden" data-design="logo" value={design.logo ?? ""} />
            </div>
          </section>
        </div>

        {/* ---- Right: live preview + actions ---- */}
        <aside class="studio-preview-col">
          <div class="studio-preview-sticky stack">
            <QrPreview svg={previewSvg} label="Live QR preview" />

            {/* Tells the owner whether what they see is what they print. For a
                dynamic code the preview IS the printed code; for a static one
                the content is baked in and can never be changed. */}
            <p class="studio-preview-caption t-caption text-secondary" data-preview-caption role="status"></p>

            <p class="studio-warn" data-scan-warn hidden role="status"></p>

            <div class="studio-actions stack">
              <Button variant="primary" block iconLeft={<Icon name="check" size={18} />} class="studio-save">
                <span data-save-label>{mode === "edit" ? "Save changes" : "Make it permanent"}</span>
              </Button>
              <div class="studio-export">
                <Button variant="secondary" iconLeft={<Icon name="download" size={16} />} class="studio-export-btn"><span data-export="svg">SVG</span></Button>
                <Button variant="secondary" iconLeft={<Icon name="download" size={16} />} class="studio-export-btn"><span data-export="png">PNG</span></Button>
                <Button variant="secondary" iconLeft={<Icon name="download" size={16} />} class="studio-export-btn"><span data-export="pdf">PDF</span></Button>
              </div>
            </div>

            <p class="studio-error" data-studio-error hidden role="alert"></p>
          </div>
        </aside>
      </div>

      <div class="toast-stack" data-toast-stack aria-live="polite" aria-atomic="false"></div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

studio.get("/app/new", (c) => {
  const user = c.get("user")!;
  const typeParam = c.req.query("type") as QrType | undefined;
  const activeType: QrType = typeParam && FIELDS[typeParam] ? typeParam : "url";
  const design = { ...DEFAULT_DESIGN };
  const previewSvg = placeholderSvg(design);

  return c.html(
    <AppShell user={user} title="New QR code" active="new">
      <StudioView
        mode="new"
        activeType={activeType}
        fields={{}}
        design={design}
        isDynamic={TYPES.find((t) => t.type === activeType)?.rich ?? false}
        title=""
        previewSvg={previewSvg}
      />
      <script src="/js/studio.js" defer></script>
    </AppShell>,
  );
});

studio.get("/app/:id/edit", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const qr = await getQrById(c.env.DB, id);
  if (!qr || qr.user_id !== user.id) {
    return c.html(
      <AppShell user={user} title="Not found">
        <div class="empty-state">
          <h1 class="t-display-md">QR code not found</h1>
          <p class="t-body text-secondary">It may have been deleted, or it isn't yours.</p>
          <Button href="/app" variant="primary">Back to dashboard</Button>
        </div>
      </AppShell>,
      404,
    );
  }

  const design = { ...DEFAULT_DESIGN, ...safeJson<Partial<QrDesign>>(qr.design_json, {}) } as QrDesign;
  let fields = safeJson<QrFields>(qr.content_json, {});

  // For rich types, content is stored on the dynamic page, not content_json.
  const rich = TYPES.find((t) => t.type === qr.type)?.rich ?? false;
  if (rich) {
    const page = await getDynamicPageByQrId(c.env.DB, qr.id);
    if (page) fields = safeJson<QrFields>(page.data_json, {});
  }

  const previewSvg = initialSvg(qr, design, c.env.APP_URL);

  return c.html(
    <AppShell user={user} title="Edit QR code">
      {raw(`<script>window.__QR_INITIAL__=${JSON.stringify({ id: qr.id, type: qr.type, isDynamic: qr.is_dynamic === 1, rich })}</script>`)}
      <StudioView
        mode="edit"
        activeType={qr.type}
        fields={fields}
        design={design}
        isDynamic={qr.is_dynamic === 1}
        title={qr.title}
        qrId={qr.id}
        shortCode={qr.short_code ?? ""}
        previewSvg={previewSvg}
      />
      <script src="/js/studio.js" defer></script>
    </AppShell>,
  );
});
