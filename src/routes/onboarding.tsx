import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { QrType } from "../types";
import type { QrDesign, QrFields } from "../lib/qr/types";
import { requireAuth, type AppEnv } from "../middleware/auth";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { Icon } from "../ui/icons";
import type { IconName } from "../ui/icons";
import { QrPreview } from "../ui/components/qr-preview";
import {
  createQr,
  setOnboarded,
  upsertDynamicPage,
  type DynamicPageKind,
} from "../db/queries";
import { ensureUniqueShortCode } from "../lib/shortcode";
import { buildPayload } from "../lib/qr/content";
import { encodeMatrix } from "../lib/qr/encoder";
import { renderSvg } from "../lib/qr/render-svg";
import { safePalette } from "../lib/qr/scannability";

/**
 * Onboarding — a calm, encouraging 3-step guided first-QR flow.
 *
 *   1. Pick a type
 *   2. Enter content + light customization, with a live preview
 *   3. Confirm and "Make it permanent"
 *
 * The whole surface is one server-rendered page; a tiny self-contained island
 * (no build step) steps between the three panels and drives the live preview by
 * calling the public /api/preview endpoint. Submitting POSTs to
 * /onboarding/complete which creates the first QR, marks the user onboarded, and
 * redirects to /app/:id. The flow is skippable: "Skip for now" sets onboarded
 * and lands on /app.
 */
export const onboarding = new Hono<AppEnv>();
onboarding.use("/onboarding/*", requireAuth);

// ---------------------------------------------------------------------------
// Type catalogue offered in step 1. A focused, reliable starter set: the most
// common static/dynamic types plus one rich hosted page (link-in-bio).
// ---------------------------------------------------------------------------

interface TypeChoice {
  type: QrType;
  icon: IconName;
  label: string;
  blurb: string;
}

const CHOICES: TypeChoice[] = [
  { type: "url", icon: "url", label: "Website link", blurb: "Send a scan straight to any page — and change where it points later." },
  { type: "text", icon: "text", label: "Plain text", blurb: "Share a short message, code, or note." },
  { type: "wifi", icon: "wifi", label: "Wi-Fi", blurb: "Let guests join your network with one tap." },
  { type: "vcard", icon: "vcard", label: "Contact card", blurb: "Hand over your details — saved straight to their phone." },
  { type: "social", icon: "social", label: "Link in bio", blurb: "One page, all your links. Edit it anytime." },
];

// Per-type content fields rendered in step 2. Kept lightweight for a first run.
interface FieldSpec {
  name: string;
  label: string;
  placeholder: string;
  type?: "text" | "url" | "tel" | "email";
  required?: boolean;
}

const FIELDS: Record<string, FieldSpec[]> = {
  url: [{ name: "url", label: "Website URL", placeholder: "yourbrand.com", type: "url", required: true }],
  text: [{ name: "text", label: "Text", placeholder: "Anything you want to share", required: true }],
  wifi: [
    { name: "ssid", label: "Network name", placeholder: "MyCafe-Guest", required: true },
    { name: "password", label: "Password", placeholder: "••••••••" },
  ],
  vcard: [
    { name: "firstName", label: "First name", placeholder: "Ada", required: true },
    { name: "lastName", label: "Last name", placeholder: "Lovelace" },
    { name: "phone", label: "Phone", placeholder: "+1 555 0100", type: "tel" },
    { name: "email", label: "Email", placeholder: "ada@example.com", type: "email" },
  ],
  social: [
    { name: "name", label: "Display name", placeholder: "Your name or brand", required: true },
    { name: "link1", label: "First link", placeholder: "https://instagram.com/you", type: "url" },
    { name: "link2", label: "Second link", placeholder: "https://your-site.com", type: "url" },
  ],
};

const RICH_KINDS: ReadonlySet<QrType> = new Set<QrType>(["pdf", "menu", "business", "appstore", "social"]);

/** Brand-safe default design — dark modules on white (literal hex is the export asset). */
const DEFAULT_DESIGN: QrDesign = {
  fg: "#0D0D0F",
  bg: "#FFFFFF",
  moduleShape: "square",
  eyeStyle: "square",
  ecc: "M",
  margin: 4,
};

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const Stepper: FC<{ current: number }> = ({ current }) => (
  <ol class="ob-stepper" aria-label="Onboarding progress">
    {[
      { n: 1, label: "Pick a type" },
      { n: 2, label: "Add content" },
      { n: 3, label: "Make it permanent" },
    ].map((s) => (
      <li
        class={
          "ob-step" + (s.n === current ? " ob-step-current" : s.n < current ? " ob-step-done" : "")
        }
        aria-current={s.n === current ? "step" : undefined}
      >
        <span class="ob-step-dot" aria-hidden="true">
          {s.n < current ? <Icon name="check" size={14} /> : s.n}
        </span>
        <span class="ob-step-label t-body-sm">{s.label}</span>
      </li>
    ))}
  </ol>
);

const TypeCard: FC<{ choice: TypeChoice }> = ({ choice }) => (
  <button type="button" class="ob-type" data-ob-type={choice.type}>
    <span class="ob-type-icon" aria-hidden="true">
      <Icon name={choice.icon} size={22} />
    </span>
    <span class="ob-type-body">
      <span class="ob-type-label t-body">{choice.label}</span>
      <span class="ob-type-blurb t-body-sm text-secondary">{choice.blurb}</span>
    </span>
  </button>
);

const FieldRow: FC<{ choiceType: QrType; spec: FieldSpec }> = ({ choiceType, spec }) => {
  const id = `ob-${choiceType}-${spec.name}`;
  return (
    <div class="field" data-ob-field-for={choiceType}>
      <label class="field-label" for={id}>
        {spec.label}
        {spec.required ? (
          <span class="field-required" aria-hidden="true">
            {" *"}
          </span>
        ) : null}
      </label>
      <input
        class="text-input"
        id={id}
        type={spec.type ?? "text"}
        placeholder={spec.placeholder}
        data-ob-input={spec.name}
        autocomplete="off"
      />
    </div>
  );
};

onboarding.get("/onboarding", (c) => {
  const user = c.get("user")!;

  // A blank-but-valid placeholder QR so step 3 has something to show before the
  // live preview replaces it.
  const placeholderSvg = renderSvg(
    encodeMatrix("https://getsqanny.com", DEFAULT_DESIGN.ecc),
    DEFAULT_DESIGN,
  );

  return c.html(
    <AppShell user={user} title="Get started" active="new">
      <div class="ob" data-onboarding>
        <header class="ob-head">
          <h1 class="ob-title t-display-lg">Let’s make your first QR.</h1>
          <p class="ob-lede t-body-lg text-secondary">
            Three calm steps. We’ll have a code you can rely on in under a minute.
          </p>
        </header>

        <Stepper current={1} />

        <form
          method="post"
          action="/onboarding/complete"
          class="ob-form"
          data-ob-form
        >
          <input type="hidden" name="type" value="" data-ob-type-input />
          <input type="hidden" name="fields_json" value="{}" data-ob-fields-input />

          {/* ---------------------------------------------- Step 1: type */}
          <section class="ob-panel" data-ob-panel="1">
            <h2 class="ob-panel-title t-heading-sm">What should your QR do?</h2>
            <div class="ob-types">
              {CHOICES.map((choice) => (
                <TypeCard choice={choice} />
              ))}
            </div>
          </section>

          {/* ------------------------------------------- Step 2: content */}
          <section class="ob-panel" data-ob-panel="2" hidden>
            <div class="ob-grid">
              <div class="ob-grid-form">
                <h2 class="ob-panel-title t-heading-sm" data-ob-content-title>
                  Add your content
                </h2>
                <div class="ob-fields stack">
                  {CHOICES.map((choice) =>
                    (FIELDS[choice.type] ?? []).map((spec) => (
                      <FieldRow choiceType={choice.type} spec={spec} />
                    )),
                  )}
                </div>
                <p class="ob-hint t-body-sm text-secondary">
                  The preview updates as you type. You can fine-tune the design later in the studio.
                </p>
              </div>
              <div class="ob-grid-preview">
                <QrPreview svg={placeholderSvg} label="Live preview of your QR code" />
                <p class="ob-preview-note t-caption text-tertiary" data-ob-preview-note>
                  Start typing to see it come alive.
                </p>
              </div>
            </div>
          </section>

          {/* ------------------------------------------- Step 3: confirm */}
          <section class="ob-panel" data-ob-panel="3" hidden>
            <div class="ob-grid">
              <div class="ob-grid-form">
                <h2 class="ob-panel-title t-heading-sm">Ready when you are.</h2>
                <p class="ob-body t-body text-secondary">
                  Your code is set. Because it’s dynamic when it can be, you can change where it
                  points — without ever reprinting it. That’s the whole idea: a QR that never breaks.
                </p>
                <dl class="ob-summary">
                  <div class="ob-summary-row">
                    <dt class="t-body-sm text-secondary">Type</dt>
                    <dd class="t-body" data-ob-summary-type>
                      —
                    </dd>
                  </div>
                  <div class="ob-summary-row">
                    <dt class="t-body-sm text-secondary">Title</dt>
                    <dd class="t-body" data-ob-summary-title>
                      My first QR
                    </dd>
                  </div>
                </dl>
                <div class="field">
                  <label class="field-label" for="ob-title">
                    Give it a name
                  </label>
                  <input
                    class="text-input"
                    id="ob-title"
                    name="title"
                    type="text"
                    value="My first QR"
                    data-ob-title-input
                    autocomplete="off"
                  />
                </div>
              </div>
              <div class="ob-grid-preview">
                <QrPreview svg={placeholderSvg} label="Your finished QR code" />
              </div>
            </div>
          </section>

          {/* ------------------------------------------------ Nav footer */}
          <footer class="ob-nav">
            <a class="ob-skip t-body-sm text-secondary" href="/onboarding/skip">
              Skip for now
            </a>
            <div class="ob-nav-btns">
              <Button type="button" variant="ghost" class="ob-back" data-ob-back>
                Back
              </Button>
              <Button type="button" variant="primary" class="ob-next" data-ob-next disabled>
                Continue
              </Button>
              <Button
                type="submit"
                variant="primary"
                class="ob-submit"
                iconLeft={<Icon name="check" size={18} />}
                data-ob-submit
              >
                Make it permanent
              </Button>
            </div>
          </footer>
        </form>
      </div>

      <script dangerouslySetInnerHTML={{ __html: ONBOARDING_ISLAND }} />
    </AppShell>,
  );
});

// ---------------------------------------------------------------------------
// POST /onboarding/complete — create the first QR, mark onboarded, redirect.
// ---------------------------------------------------------------------------

/** Coerce a parsed fields object into a string->string map. */
function toFields(input: unknown): QrFields {
  if (!input || typeof input !== "object") return {};
  const out: QrFields = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (v != null) out[k] = String(v);
  }
  return out;
}

/** Build the social link-in-bio page data from the lightweight onboarding fields. */
function buildSocialData(fields: QrFields): { name: string; links: { label: string; url: string }[] } {
  const links: { label: string; url: string }[] = [];
  for (const key of ["link1", "link2", "link3"]) {
    const url = (fields[key] ?? "").trim();
    if (url) links.push({ label: hostLabel(url), url });
  }
  return { name: (fields.name ?? "").trim() || "My links", links };
}

/** A friendly label for a URL (its hostname, sans www). */
function hostLabel(url: string): string {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

onboarding.post("/onboarding/complete", async (c) => {
  const user = c.get("user")!;
  const now = Date.now();

  const form = await c.req.parseBody();
  const type = (typeof form.type === "string" ? form.type : "url") as QrType;
  const title =
    (typeof form.title === "string" && form.title.trim()) || "My first QR";

  let fields: QrFields = {};
  if (typeof form.fields_json === "string") {
    try {
      fields = toFields(JSON.parse(form.fields_json) as unknown);
    } catch {
      fields = {};
    }
  }

  const design = safePalette({ ...DEFAULT_DESIGN });
  const appUrl = c.env.APP_URL.replace(/\/+$/, "");

  let qrId: string;

  try {
  if (RICH_KINDS.has(type)) {
    // Rich hosted page: always dynamic. The printed QR encodes /r/<code> which
    // 302s to /p/<code>; destination is the hosted landing.
    const shortCode = await ensureUniqueShortCode(c.env.DB);
    const destination = `${appUrl}/p/${shortCode}`;
    const kind = type as DynamicPageKind;

    // For the onboarding starter set the only rich kind is "social".
    const data = kind === "social" ? buildSocialData(fields) : fields;

    const qr = await createQr(c.env.DB, {
      user_id: user.id,
      type,
      title,
      is_dynamic: true,
      short_code: shortCode,
      destination,
      content_json: JSON.stringify(data),
      design_json: JSON.stringify(design),
      created_at: now,
      updated_at: now,
    });
    qrId = qr.id;

    await upsertDynamicPage(c.env.DB, {
      qr_id: qr.id,
      kind,
      data_json: JSON.stringify(data),
    });
  } else if (type === "url") {
    // URL → dynamic by default (the reliability promise: change the target,
    // never the code). The printed QR encodes /r/<code>; destination is the
    // user's real target.
    const rawTarget = (fields.url ?? "").trim() || "https://getsqanny.com";
    const destination = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawTarget)
      ? rawTarget
      : `https://${rawTarget}`;
    const shortCode = await ensureUniqueShortCode(c.env.DB);

    const qr = await createQr(c.env.DB, {
      user_id: user.id,
      type,
      title,
      is_dynamic: true,
      short_code: shortCode,
      destination,
      content_json: JSON.stringify(fields),
      design_json: JSON.stringify(design),
      created_at: now,
      updated_at: now,
    });
    qrId = qr.id;
  } else {
    // Static types (text, wifi, vcard, …) — the image encodes the payload
    // directly; no short_code.
    const qr = await createQr(c.env.DB, {
      user_id: user.id,
      type,
      title,
      is_dynamic: false,
      content_json: JSON.stringify(fields),
      design_json: JSON.stringify(design),
      created_at: now,
      updated_at: now,
    });
    qrId = qr.id;
  }

  await setOnboarded(c.env.DB, user.id, now);
  } catch (err) {
    console.error(err);
    return c.html(
      <AppShell user={user} title="Get started" active="new">
        <div class="ob" data-onboarding>
          <header class="ob-head">
            <h1 class="ob-title t-display-lg">Something went wrong.</h1>
            <p class="ob-lede t-body-lg text-secondary">
              We couldn't create your QR — please try again.
            </p>
          </header>
          <div class="ob-nav">
            <Button href="/onboarding" variant="primary">
              Back to start
            </Button>
          </div>
        </div>
      </AppShell>,
      500,
    );
  }
  return c.redirect(`/app/${qrId}`, 302);
});

// ---------------------------------------------------------------------------
// GET /onboarding/skip — mark onboarded and go to the dashboard.
// ---------------------------------------------------------------------------

onboarding.get("/onboarding/skip", async (c) => {
  const user = c.get("user")!;
  await setOnboarded(c.env.DB, user.id, Date.now());
  return c.redirect("/app", 302);
});

// ---------------------------------------------------------------------------
// Self-contained onboarding island (no build step). Drives step navigation,
// live preview via /api/preview, and serializes the chosen fields into the
// hidden form inputs before submit.
// ---------------------------------------------------------------------------

const ONBOARDING_ISLAND = `(function(){
  var root=document.querySelector('[data-onboarding]');
  if(!root)return;
  var form=root.querySelector('[data-ob-form]');
  var typeInput=root.querySelector('[data-ob-type-input]');
  var fieldsInput=root.querySelector('[data-ob-fields-input]');
  var titleInput=root.querySelector('[data-ob-title-input]');
  var panels=Array.prototype.slice.call(root.querySelectorAll('[data-ob-panel]'));
  var steps=Array.prototype.slice.call(root.querySelectorAll('.ob-step'));
  var backBtn=root.querySelector('[data-ob-back]');
  var nextBtn=root.querySelector('[data-ob-next]');
  var submitBtn=root.querySelector('[data-ob-submit]');
  var previewNote=root.querySelector('[data-ob-preview-note]');
  var summaryType=root.querySelector('[data-ob-summary-type]');
  var summaryTitle=root.querySelector('[data-ob-summary-title]');
  var previewSurfaces=Array.prototype.slice.call(root.querySelectorAll('.qr-preview-surface'));
  var current=1, chosen='';
  var labels={url:'Website link',text:'Plain text',wifi:'Wi-Fi',vcard:'Contact card',social:'Link in bio'};
  var requiredField={url:'url',text:'text',wifi:'ssid',vcard:'firstName',social:'name'};
  var richKinds={social:1};

  function showPanel(n){
    current=n;
    panels.forEach(function(p){p.hidden=(p.getAttribute('data-ob-panel')!=String(n));});
    steps.forEach(function(s,i){
      s.classList.remove('ob-step-current','ob-step-done');
      var sn=i+1;
      if(sn===n)s.classList.add('ob-step-current');
      else if(sn<n)s.classList.add('ob-step-done');
      if(sn===n)s.setAttribute('aria-current','step');else s.removeAttribute('aria-current');
    });
    backBtn.style.display=(n>1)?'':'none';
    nextBtn.style.display=(n<3)?'':'none';
    submitBtn.style.display=(n===3)?'':'none';
    if(n===3){
      if(summaryType)summaryType.textContent=labels[chosen]||chosen;
      if(summaryTitle)summaryTitle.textContent=(titleInput&&titleInput.value)||'My first QR';
      refreshPreview();
    }
    validate();
    var first=panels[n-1]&&panels[n-1].querySelector('input,button');
    if(first&&n!==1)try{first.focus();}catch(e){}
  }

  function activeFields(){
    var out={};
    root.querySelectorAll('[data-ob-field-for="'+chosen+'"] [data-ob-input]').forEach(function(inp){
      out[inp.getAttribute('data-ob-input')]=inp.value;
    });
    return out;
  }

  function fieldVisibility(){
    root.querySelectorAll('[data-ob-field-for]').forEach(function(f){
      f.style.display=(f.getAttribute('data-ob-field-for')===chosen)?'':'none';
    });
  }

  function validate(){
    if(current===1){nextBtn.disabled=!chosen;return;}
    if(current===2){
      var req=requiredField[chosen];
      var f=activeFields();
      nextBtn.disabled=!(req&&f[req]&&f[req].trim());
      return;
    }
    nextBtn.disabled=false;
  }

  function previewType(){
    // Rich/dynamic kinds preview as a URL pointing at their future hosted page.
    return richKinds[chosen]?'url':chosen;
  }
  function previewFields(){
    if(richKinds[chosen]){
      var f=activeFields();
      return {url:(f.link1||f.link2||'https://getsqanny.com')};
    }
    return activeFields();
  }

  var previewTimer=null;
  function refreshPreview(){
    if(!chosen)return;
    if(previewTimer)clearTimeout(previewTimer);
    previewTimer=setTimeout(function(){
      fetch('/api/preview',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({type:previewType(),fields:previewFields()})})
        .then(function(r){return r.ok?r.json():null;})
        .then(function(d){
          if(d&&d.svg){previewSurfaces.forEach(function(s){s.innerHTML=d.svg;});
            if(previewNote)previewNote.textContent='Looking good — this is your code.';}
        }).catch(function(){});
    },180);
  }

  root.querySelectorAll('[data-ob-type]').forEach(function(card){
    card.addEventListener('click',function(){
      chosen=card.getAttribute('data-ob-type');
      root.querySelectorAll('[data-ob-type]').forEach(function(c){c.classList.remove('ob-type-selected');});
      card.classList.add('ob-type-selected');
      typeInput.value=chosen;
      fieldVisibility();
      validate();
      showPanel(2);
    });
  });

  root.querySelectorAll('[data-ob-field-for] [data-ob-input]').forEach(function(inp){
    inp.addEventListener('input',function(){validate();refreshPreview();});
  });
  if(titleInput)titleInput.addEventListener('input',function(){
    if(summaryTitle)summaryTitle.textContent=titleInput.value||'My first QR';
  });

  nextBtn.addEventListener('click',function(){if(!nextBtn.disabled)showPanel(current+1);});
  backBtn.addEventListener('click',function(){showPanel(Math.max(1,current-1));});

  form.addEventListener('submit',function(){
    typeInput.value=chosen;
    fieldsInput.value=JSON.stringify(activeFields());
    submitBtn.disabled=true;
  });

  fieldVisibility();
  showPanel(1);
})();`;
