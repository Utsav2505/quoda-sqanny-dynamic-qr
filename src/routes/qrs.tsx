// The 4-step QR claim/registration flow, and the public page a physical stand
// resolves to.
//
// WHY THIS IS A SERVER-RENDERED CHAIN OF GET/POST AND NOT A CLIENT ROUTER
// ---------------------------------------------------------------------------
// Every step is a real URL and a real form. The camera island's entire job is
// to decode a code into the same field a human would type into, so with
// scripting disabled the flow is identical, just slower. That is also what makes
// "Back" free: each step carries the accumulated values in hidden fields, so
// going back never loses the scanned serial or the half-typed details.
//
//   GET  /qrs/claim                 step 1  scan
//   GET  /qrs/claim/business?qr=    step 2  pick a business
//   POST /qrs/claim/business        step 2 -> 3 (also creates a business)
//   GET  /qrs/claim/details?qr=&business=
//   POST /qrs/claim/review          step 3 -> 4
//   POST /qrs/claim                 step 4  the atomic claim
//   GET  /qrs/claim/success?qr=
//
// Every step re-derives the serial and the business from the DATABASE before
// rendering. Nothing carried in a hidden field is believed: the serial decides
// what is possible, and the business id is re-checked for membership. A user who
// edits a hidden field gets a correct page, not a claim on someone else's QR.

import { Hono } from "hono";
import type { FC, PropsWithChildren } from "hono/jsx";
import { requireAuth, type AppEnv } from "../middleware/auth";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { Card } from "../ui/components/card";
import { Input } from "../ui/components/input";
import { EmptyState } from "../ui/components/empty-state";
import {
  BusinessForm,
  type BusinessFormErrors,
  type BusinessFormValues,
} from "../ui/components/business-form";
import { Icon } from "../ui/icons";
import {
  claimQr,
  resolveAsset,
  validateClaimInput,
  type AssetResolution,
  type ClaimErrors,
} from "../lib/claim";

import {
  categoryOptions,
  categoryLabel,
  destinationLabel,
  isQrStatus,
  normalizeIdentifier,
  PLACEMENT_SUGGESTIONS,
  QR_NAME_MAX,
  QR_PLACEMENT_MAX,
  QR_STATUS_LABELS,
  validateDestination,
  type QrCategory,
  type QrStatus,
} from "../lib/qr-registration";

import { categoryLabel as businessCategoryLabel, businessLocation } from "../lib/business";
import { createBusiness, listBusinessesForUser, getBusinessForUser } from "../db/queries";
import { echoValues, parseBusiness } from "./businesses";
import { withFlash } from "../lib/flash";
import { LIMITS, cleanText } from "../lib/validate";
import { isHostedDestination, logScan, scanCookie } from "../lib/analytics";
import { getUserFromRequest } from "../lib/auth/session";
import {
  archiveAsset,
  countAssetsForOwner,
  getAssetViewByIdentifier,
  getAssetViewForOwner,
  listAssetsForOwner,
  restoreAsset,
  updateAssetConfig,
  type QrAssetView,
} from "../db/qr-registry";

export const qrs = new Hono<AppEnv>();

// ===========================================================================
// Public entry point: GET /q/:identifier
// ===========================================================================

/**
 * The URL printed on a physical stand.
 *
 * This is the OTHER half of the identity split. A stand has two URLs that mean
 * different things:
 *
 *   /q/SQ-8F2K9A  the permanent, printed one. Never changes.
 *   /r/<short>    the internal redirect key. Changes if the record is rebuilt.
 *
 * Because the printed URL is stable, a stand that has been claimed and later
 * archived still has to answer — and it must answer "retired", not quietly
 * redirect somewhere the owner never intended.
 *
 * An unauthenticated visitor gets one of: a 302 to the destination (claimed and
 * live), the sign-in wall (claimable), or a plain refusal (someone else's, or
 * retired). It never learns who owns anything.
 */
qrs.get("/q/:identifier", async (c) => {
  const identifier = normalizeIdentifier(c.req.param("identifier") ?? "");
  if (!identifier) return c.text("Not Found", 404);

  let asset;
  try {
    asset = await getAssetViewByIdentifier(c.env.DB, identifier);
  } catch (err) {
    console.error(`[q] lookup failed for ${identifier}:`, err);
    return c.text("Temporarily unavailable", 503);
  }

  if (!asset) return c.text("Not Found", 404);

  // Retired stands stop serving. A 410 rather than a 404: the code genuinely
  // exists, and telling the owner it is retired is more useful than pretending
  // it was never printed. Anonymous visitors get the bare status.
  if (asset.status === "archived") {
    return c.text("This QR has been retired.", 410);
  }

  const viewer = await getUserFromRequest(c.env, c.req.raw);

  // Not live yet, so there is no destination to send anyone to. This is the
  // half-finished state, and it has to be split by ownership, because the two
  // halves mean opposite things to the person holding the phone:
  //
  //   owner_id === null   free to claim. Not sensitive - it is a stand still in
  //                       its box - so anyone may be walked into the flow.
  //   owner_id === me     I claimed it and never finished. Resume setup.
  //   owner_id === other  Not ours, and confirming it exists would leak, so this
  //                       is a flat 404 for every viewer, signed in or not.
  if (!asset.destination) {
    const mine = viewer !== null && asset.owner_id === viewer.id;
    if (asset.owner_id !== null && !mine) return c.text("Not Found", 404);
    if (!viewer) {
      return c.redirect(
        `/login?next=${encodeURIComponent(`/qrs/claim?qr=${identifier}`)}`,
        302,
      );
    }
    return c.redirect(mine ? `/qrs/claim/details?qr=${identifier}` : `/qrs/claim?qr=${identifier}`, 302);
  }

  // Live: log the scan and get out of the way, exactly like /r/:code. The scan
  // id is minted synchronously so the hosted-destination correlation cookie can
  // be set before logScan runs in the background.
  const scanId = crypto.randomUUID();
  c.executionCtx.waitUntil(
    logScan(c.env, { id: asset.qr_code_id! }, c.req.raw, scanId).catch((err) =>
      console.error("[q] scan log error:", err),
    ),
  );

  if (isHostedDestination(asset.destination, c.env.APP_URL)) {
    c.header("Set-Cookie", scanCookie(scanId, c.env.APP_URL.startsWith("https://")));
  }

  return c.redirect(asset.destination, 302);
});

/**
 * Step names, in order. Used only for the "Step 2 of 4" label and the
 * progressbar, which is deliberately NOT a set of links: the wizard is
 * sequential, and a stepper that lets you jump ahead would skip the mandatory
 * business step. There is no GET route for step 4 either - review is reached by
 * submitting step 3, so it has no standalone URL to link to.
 */
const STEPS = [
  { n: 1, label: "Scan QR" },
  { n: 2, label: "Select Business" },
  { n: 3, label: "Configure QR" },
  { n: 4, label: "Review" },
] as const;

// ===========================================================================
// Chrome
// ===========================================================================

/** Section 21: "Step 2 of 4", plus a bar. Collapses to the text on mobile. */
const Stepper: FC<{ current: number }> = ({ current }) => {
  const pct = Math.round(((current - 1) / (STEPS.length - 1)) * 100);
  return (
    <div class="claim-progress">
      <p class="claim-progress-text t-body-sm text-secondary">
        Step {current} of {STEPS.length} ·{" "}
        <span class="claim-progress-step">{STEPS[current - 1].label}</span>
      </p>
      <div
        class="claim-progress-track"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={STEPS.length}
        aria-valuenow={current}
        aria-label={`Step ${current} of ${STEPS.length}: ${STEPS[current - 1].label}`}
      >
        <span class="claim-progress-fill" style={`width:${pct}%`} />
      </div>
    </div>
  );
};

interface FrameProps {
  user: Parameters<typeof AppShell>[0]["user"];
  step: number;
  businesses?: Parameters<typeof AppShell>[0]["businesses"];
  notice?: string;
  /** the two-column split from section 33: instructions beside the work */
  aside?: import("hono/jsx").Child;
  formIsland?: boolean;
  scannerIsland?: boolean;
}

const Frame: FC<PropsWithChildren<FrameProps>> = ({
  user,
  step,
  businesses,
  notice,
  aside,
  formIsland,
  scannerIsland,
  children,
}) => (
  <AppShell
    user={user}
    title="Claim a QR"
    active="dashboard"
    businesses={businesses}
    notice={notice}
    formIsland={formIsland}
    scannerIsland={scannerIsland}
  >
    <div class="claim">
      <header class="claim-head">
        <h1 class="t-heading-sm claim-title">Claim a Sqanny QR</h1>
        <p class="claim-sub t-body text-secondary">
          Connect a Sqanny Stand to your account. The code on the stand keeps
          working even if you change where it points later.
        </p>
      </header>
      <Stepper current={step} />
      {aside ? (
        <div class="claim-split">
          <div class="claim-split-main">{children}</div>
          <aside class="claim-split-aside">{aside}</aside>
        </div>
      ) : (
        children
      )}
    </div>
  </AppShell>
);

/** The serial, shown on every step after the scan so it stays visible. */
const SerialChip: FC<{ identifier: string }> = ({ identifier }) => (
  <p class="claim-serial">
    <span class="claim-serial-label t-body-sm text-secondary">QR ID</span>
    <code class="claim-serial-value tnum">{identifier}</code>
  </p>
);

// ===========================================================================
// Step 1 — scan
// ===========================================================================

qrs.get("/qrs/claim", requireAuth, async (c) => {
  const user = c.get("user")!;
  const businesses = await listBusinessesForUser(c.env.DB, user.id);
  // A serial can already be in hand: someone followed /q/<serial> or the sign-in
  // wall sent them back here. Pre-filling it saves a pointless re-scan, and the
  // value is still submitted as a plain form field.
  const prefill = normalizeIdentifier(c.req.query("qr") ?? "") ?? "";
  const notice =
    c.req.query("notice") ??
    (prefill ? "We've filled in the code from your stand. Continue to pick a business." : undefined);
  return c.html(
    <Frame
      user={user}
      step={1}
      businesses={businesses}
      notice={notice}
      scannerIsland
    >
      <Card class="claim-card">
        {/* The scanner is progressive enhancement. This form is the real
            submit path; the island only fills in `qr`. */}
        <form method="get" action="/qrs/claim/business" data-scan-form data-validate>
          <div class="claim-viewport" data-scanner data-scanner-state="idle">
            <video
              class="claim-video"
              data-scan-video
              muted
              playsinline
              aria-label="Camera preview of the QR code on your Sqanny Stand"
            />
            <div class="claim-viewport-empty">
              <span class="claim-viewport-glyph" aria-hidden="true">
                <Icon name="qr" size={30} />
              </span>
              <p class="claim-scan-title t-body" data-scan-title>
                Point your camera at the QR code.
              </p>
              <p class="claim-scan-hint t-body-sm text-secondary" data-scan-hint>
                The code is on the Sqanny Stand you want to connect.
              </p>
            </div>
            <p class="visually-hidden" role="status" aria-live="polite" data-scan-live />
          </div>

          <div class="claim-scan-actions">
            <Button type="button" data-scan-start iconLeft={<Icon name="qr" size={16} />}>
              Scan with camera
            </Button>
          </div>

          {/* Deliberately NOT hidden in the markup. The manual field is the
              real submit path and must work with scripting disabled, so it is
              simply always on screen; the camera is an accelerator that fills
              it in. Hiding it behind `hidden` (or behind a click) would mean
              the no-JS user has no way to enter their code at all. */}
          <div class="claim-manual" data-scan-manual-panel>
            <div class="field">
              <label class="field-label" for="claim-qr">
                Sqanny QR code
              </label>
              <input
                class="input"
                id="claim-qr"
                name="qr"
                value={prefill}
                data-scan-input
                placeholder="SQ-8F2K9A"
                autocomplete="off"
                autocapitalize="characters"
                spellcheck={false}
                inputMode="text"
                required
                maxlength={64}
                aria-describedby="claim-qr-hint"
              />
              <p class="field-hint" id="claim-qr-hint">
                Printed under the QR on your stand. The dash is optional.
              </p>
              <p class="field-error" data-error-for="qr" role="alert" />
            </div>
            <Button type="submit" block>
              Continue
            </Button>
          </div>
        </form>
      </Card>
    </Frame>,
  );
});

// ===========================================================================
// Step 2 — where should this QR belong?
// ===========================================================================

interface BusinessChoice {
  id: string;
  name: string;
  category: string;
  custom_category: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

const BusinessRadioCard: FC<{ b: BusinessChoice; checked: boolean }> = ({ b, checked }) => (
  // Selection is styled in CSS off :has(.claim-biz-input:checked), so choosing a
  // different business highlights immediately without a script. `checked` is
  // still rendered on the input: it is the only thing that survives a no-JS
  // re-render, and it is what the form actually submits.
  <label class="claim-biz">
    <input
      class="claim-biz-input"
      type="radio"
      name="business_id"
      value={b.id}
      checked={checked}
      required
    />
    <span class="claim-biz-body">
      <span class="claim-biz-name t-body">{b.name}</span>
      <span class="claim-biz-meta t-body-sm text-secondary">
        {businessCategoryLabel(b.category, b.custom_category)}
        {businessLocation(b) !== "-" ? ` · ${businessLocation(b)}` : ""}
      </span>
    </span>
    <span class="claim-biz-check" aria-hidden="true">
      <Icon name="check" size={15} />
    </span>
  </label>
);

// ---------------------------------------------------------------------------
// Step 2 — pick a business, or create one
// ---------------------------------------------------------------------------

/**
 * A fresh create form. `category` is pre-filled because it is required: leaving
 * the select blank means a no-JS user has to guess which option is the default.
 */
function emptyBusinessValues(): BusinessFormValues {
  return { category: "cafe" };
}

/**
 * Render step 2.
 *
 * Shared by the GET and the POST so a validation failure re-renders the page the
 * user was already looking at, with their answers intact. Redirecting back with
 * only an error code — which is what this did first — throws away everything
 * they just typed, so fixing a missing category cost them the business name,
 * the address and the upload too.
 */
function renderBusinessStep(opts: {
  user: FrameProps["user"];
  identifier: string;
  businesses: Parameters<typeof Frame>[0]["businesses"];
  creating: boolean;
  preselect: string | null;
  values: BusinessFormValues;
  errors: BusinessFormErrors;
  notice?: string;
}) {
  const { user, identifier, businesses, creating, preselect, values, errors, notice } = opts;
  const hasBusinesses = Boolean(businesses && businesses.length > 0);
  const step2Query = `qr=${encodeURIComponent(identifier)}`;

  return (
    <Frame user={user} step={2} businesses={businesses} notice={notice}>
      <SerialChip identifier={identifier} />

      {hasBusinesses ? (
        <Card title="Where should this QR belong?">
          <form method="post" action="/qrs/claim/business" data-validate data-guard-submit>
            <input type="hidden" name="qr" value={identifier} />
            <fieldset class="claim-fieldset">
              <legend class="claim-legend t-body-sm text-secondary">
                Pick the business this stand belongs to
              </legend>
              <div class="claim-biz-list">
                {(businesses ?? []).map((b) => (
                  <BusinessRadioCard
                    b={b as unknown as BusinessChoice}
                    checked={preselect === b.id}
                  />
                ))}
              </div>
            </fieldset>
            <p class="field-error" data-error-for="business_id" role="alert" />

            <div class="form-actions">
              <Button type="submit" data-busy-label="Continuing…">
                Continue
              </Button>
              {creating ? null : (
                <a
                  class="btn btn-ghost"
                  href={`/qrs/claim/business?${step2Query}&creating=1`}
                  role="button"
                >
                  Create a new business
                </a>
              )}
              <a class="btn btn-ghost" href={`/qrs/claim`} role="button">
                Back to scanning
              </a>
            </div>
          </form>
        </Card>
      ) : null}

      {creating ? (
        <Card title={hasBusinesses ? "Add a business" : "Create your first business"}>
          <p class="page-lede t-body text-secondary">
            {hasBusinesses
              ? "The stand will be attached to whichever business you save here."
              : "Every QR belongs to exactly one business — that is what keeps its scans separate from your other locations. Just the name and address are needed now; the rest can wait."}
          </p>

          <BusinessForm
            action="/qrs/claim/business"
            uid="claim-biz"
            values={values}
            errors={errors}
            submitLabel="Create business and continue"
            busyLabel="Creating…"
            cancelHref={`/qrs/claim?qr=${encodeURIComponent(identifier)}`}
            cancelLabel="Back"
            hidden={
              <>
                {/* These live inside BusinessForm's own <form>. Wrapping it in
                    another form would nest them, and a browser drops the inner
                    form without warning — which is exactly the bug onboarding
                    already hit once. */}
                <input type="hidden" name="qr" value={identifier} />
                <input type="hidden" name="create" value="1" />
              </>
            }
          />
        </Card>
      ) : null}
    </Frame>
  );
}

/**
 * Step 2 as a URL. A business is mandatory — a QR with no owner business cannot
 * be scoped on the dashboard — so there is deliberately no "skip" path here
 * even though a previous draft offered one.
 */
qrs.get("/qrs/claim/business", requireAuth, async (c) => {
  const user = c.get("user")!;
  const identifier = normalizeIdentifier(c.req.query("qr") ?? "");
  if (!identifier) {
    return c.redirect(withFlash("/qrs/claim", "qr-invalid"), 302);
  }

  const resolution = await resolveAsset(c.env.DB, identifier, user.id);
  // Re-resolve rather than trusting that step 1 saw the right thing: this is
  // what makes a hand-edited ?qr= harmless.
  if (resolution.state !== "claimable" && !(resolution.state === "yours" && !resolution.configured)) {
    return c.redirect(withFlash("/qrs/claim", flashForResolution(resolution)), 302);
  }

  const businesses = await listBusinessesForUser(c.env.DB, user.id);
  // `creating=1` is a link target, not hidden state, so the open form survives a
  // refresh. With no businesses to choose from it is the only sensible action,
  // so it is shown on arrival.
  const creating = c.req.query("creating") === "1" || businesses.length === 0;

  return c.html(
    renderBusinessStep({
      user,
      identifier,
      businesses,
      creating,
      preselect: c.req.query("business") ?? null,
      values: creating ? emptyBusinessValues() : emptyBusinessValues(),
      errors: {},
      notice: c.req.query("notice") ?? undefined,
    }),
  );
});

/**
 * Step 2 submit: attach an existing business, or create one and attach that.
 *
 * Section 12: creating a business here must NOT eject the user from the claim
 * flow. The business is created, selected, and the flow continues to step 3
 * carrying the new id.
 */
qrs.post("/qrs/claim/business", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const identifier = normalizeIdentifier(body.qr);
  if (!identifier) return c.redirect(withFlash("/qrs/claim", "qr-invalid"), 302);

  const resolution = await resolveAsset(c.env.DB, identifier, user.id);
  if (resolution.state !== "claimable" && !(resolution.state === "yours" && !resolution.configured)) {
    return c.redirect(withFlash("/qrs/claim", flashForResolution(resolution)), 302);
  }

  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  if (body.create) {
    // Reuse the canonical parser so this cannot drift from
    // /app/businesses/new. echoValues gives back exactly what was typed, so the
    // re-render below is the form they filled in rather than a blank one.
    const parsed = await parseBusiness(body, c.env, user.id);
    if (Object.keys(parsed.errors).length > 0) {
      return c.html(
        renderBusinessStep({
          user,
          identifier,
          businesses,
          creating: true,
          preselect: null,
          values: echoValues(body),
          errors: parsed.errors,
          notice: "business-save-failed",
        }),
      );
    }

    let created;
    try {
      created = await createBusiness(c.env.DB, user.id, parsed.patch);
    } catch (err) {
      console.error("[claim] business create failed:", err);
      // Same page, same values — a storage failure should not cost the user
      // their typing either.
      return c.html(
        renderBusinessStep({
          user,
          identifier,
          businesses,
          creating: true,
          preselect: null,
          values: echoValues(body),
          errors: {},
          notice: "business-save-failed",
        }),
      );
    }

    // Select it automatically: making the user hunt for the business they just
    // created in a list is the exact friction section 12 asks us to remove.
    return c.redirect(
      withFlash(
        `/qrs/claim/details?qr=${encodeURIComponent(identifier)}&business=${encodeURIComponent(created.id)}`,
        "business-created",
      ),
      302,
    );
  }

  const businessId = typeof body.business_id === "string" ? body.business_id : "";
  // Membership is re-checked here, on the server, from the id in the form. A
  // tampered business_id resolves to null and is treated as "none selected",
  // because a QR must never be filed under another tenant's business.
  const business = businessId ? await getBusinessForUser(c.env.DB, businessId, user.id) : null;
  if (!business || business.status !== "active") {
    return c.html(
      renderBusinessStep({
        user,
        identifier,
        businesses,
        creating: businesses.length === 0,
        preselect: null,
        values: emptyBusinessValues(),
        errors: { business_id: "Choose the business this QR belongs to." },
        notice: "business-required",
      }),
    );
  }

  return c.redirect(
    withFlash(
      `/qrs/claim/details?qr=${encodeURIComponent(identifier)}&business=${encodeURIComponent(business.id)}`,
      "business-selected",
    ),
    302,
  );
});

// ===========================================================================
// Step 3 — tell us about this QR
// ===========================================================================

interface DetailsValues {
  name: string;
  category: string;
  custom_category: string;
  placement: string;
  destination: string;
}

/**
 * Render step 3.
 *
 * Shared with the claim handler's validation branch so a rejected submission
 * comes back as the same form the user filled in, with the failing fields
 * marked. Redirecting with the values in the query string and no error codes
 * (which is what this did first) meant the form came back looking untouched, so
 * a user who had left the destination blank had no idea which field was at
 * fault.
 */
function renderDetailsStep(opts: {
  user: FrameProps["user"];
  identifier: string;
  business: { id: string; name: string };
  businesses: Parameters<typeof Frame>[0]["businesses"];
  values: DetailsValues;
  errors: ClaimErrors;
  notice?: string;
}) {
  const { user, identifier, business, businesses, values, errors, notice } = opts;
  const e = (k: keyof ClaimErrors) => errors[k] ?? undefined;

  // Mirrors Input's own error handling for the fields written as raw elements
  // here, so a server message is announced and visibly attached to its control.
  const fieldError = (k: keyof ClaimErrors) =>
    e(k) ? <p class="field-error" data-error-for={k} role="alert">{e(k)}</p> : null;

  return (
    <Frame user={user} step={3} businesses={businesses} notice={notice} formIsland>
      <SerialChip identifier={identifier} />
      <Card title="Tell us about this QR">
        <p class="claim-context t-body-sm text-secondary">
          Adding to <strong>{business.name}</strong>
          {" · "}
          <a href={`/qrs/claim/business?qr=${encodeURIComponent(identifier)}`}>change</a>
        </p>

        <form method="post" action="/qrs/claim/review" data-validate data-guard-submit>
          <input type="hidden" name="qr" value={identifier} />
          <input type="hidden" name="business_id" value={business.id} />

          <div class="field">
            <Input
              id="qr-name"
              name="name"
              label="QR Name"
              required
              maxlength={QR_NAME_MAX}
              placeholder="Counter"
              value={values.name}
              error={e("name")}
              hint="What is this stand for? Reception, Counter, Table 04…"
            />
            {fieldError("name")}
          </div>

          <div class="field-row">
            <div class="field">
              <label class="field-label" for="qr-category">
                QR Category <span class="field-req" aria-hidden="true">*</span>
              </label>
              {/* A native select, and the custom-text field beside it is simply
                  always present rather than conditionally revealed. Revealing it
                  needs JavaScript, and a field that only exists with scripting is
                  a field some users can never fill in. */}
              <select
                class="input select"
                id="qr-category"
                name="category"
                required
                aria-invalid={e("category") ? "true" : undefined}
              >
                {categoryOptions().map((o) => (
                  <option value={o.value} selected={o.value === values.category}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p class="field-hint">What a customer should do when they scan it.</p>
              {fieldError("category")}
            </div>
            <div class="field">
              <label class="field-label" for="qr-custom-category">
                Custom category
              </label>
              <input
                class="input"
                id="qr-custom-category"
                name="custom_category"
                maxlength={LIMITS.customCategory}
                placeholder="Wayfinding"
                value={values.custom_category}
              />
              <p class="field-hint">
                Only used if you chose <strong>Custom</strong> above.
              </p>
            </div>
          </div>

          <div class="field">
            <label class="field-label" for="qr-placement">Location / Placement</label>
            <input
              class="input"
              id="qr-placement"
              name="placement"
              maxlength={QR_PLACEMENT_MAX}
              placeholder="Cash Desk"
              value={values.placement}
              list="qr-placement-options"
              aria-describedby="qr-placement-hint"
            />
            <datalist id="qr-placement-options">
              {PLACEMENT_SUGGESTIONS.map((p) => (
                <option value={p} />
              ))}
            </datalist>
            <p class="field-hint" id="qr-placement-hint">
              Where the stand physically is. Optional, but it saves hunting for it
              later. Try {PLACEMENT_SUGGESTIONS.slice(0, 3).join(", ")}.
            </p>
            {fieldError("placement")}
          </div>

          <div class="field">
            <label class="field-label" for="qr-destination">
              Destination URL <span class="field-req" aria-hidden="true">*</span>
            </label>
            <input
              class="input"
              id="qr-destination"
              name="destination"
              type="url"
              inputmode="url"
              required
              maxlength={LIMITS.url}
              placeholder="https://"
              value={values.destination}
              aria-invalid={e("destination") ? "true" : undefined}
              aria-describedby="qr-destination-hint"
            />
            <p class="field-hint" id="qr-destination-hint">
              Where should customers go when they scan this QR? We&rsquo;ll add
              <code>https://</code> if you leave it off.
            </p>
            {fieldError("destination")}
          </div>

          <div class="form-actions">
            <Button type="submit" data-busy-label="Checking…">
              Review
            </Button>
            <a
              class="btn btn-ghost"
              href={`/qrs/claim/business?qr=${encodeURIComponent(identifier)}`}
              role="button"
            >
              Back
            </a>
          </div>
        </form>
      </Card>
    </Frame>
  );
}

qrs.get("/qrs/claim/details", requireAuth, async (c) => {
  const user = c.get("user")!;
  const identifier = normalizeIdentifier(c.req.query("qr") ?? "");
  if (!identifier) return c.redirect(withFlash("/qrs/claim", "qr-invalid"), 302);

  const resolution = await resolveAsset(c.env.DB, identifier, user.id);
  if (resolution.state !== "claimable" && !(resolution.state === "yours" && !resolution.configured)) {
    return c.redirect(withFlash("/qrs/claim", flashForResolution(resolution)), 302);
  }

  const businessId = c.req.query("business") ?? "";
  const business = businessId ? await getBusinessForUser(c.env.DB, businessId, user.id) : null;

  // A business is mandatory, so arriving without a valid one is a dead end we
  // bounce rather than a form we render. The old copy ("you can add one later")
  // promised a path the claim itself would then reject.
  if (!business || business.status !== "active") {
    return c.redirect(
      withFlash(`/qrs/claim/business?qr=${encodeURIComponent(identifier)}`, "business-required"),
      302,
    );
  }

  // Pre-fill from the query string when coming back from a validation failure so
  // one bad field does not cost the other four. Only the owner's own stored name
  // is ever used as a pre-fill.
  const existingName = resolution.state === "yours" ? (resolution.asset.name ?? "") : "";
  const values: DetailsValues = {
    name: cleanText(c.req.query("name") ?? existingName, QR_NAME_MAX),
    category: c.req.query("category") ?? "reviews",
    custom_category: c.req.query("custom_category") ?? "",
    placement: c.req.query("placement") ?? "",
    destination: c.req.query("destination") ?? "",
  };

  return c.html(
    renderDetailsStep({
      user,
      identifier,
      business: { id: business.id, name: business.name },
      businesses: await listBusinessesForUser(c.env.DB, user.id),
      values,
      errors: {},
      notice: c.req.query("notice") ?? undefined,
    }),
  );
});

/**
 * Map a claim rejection onto the flash code that explains it.
 *
 * Written as an exhaustive switch ending in a `never` check on purpose. The
 * first draft built the code as `qr-claim-${reason}`, which meant a reason
 * added to the service later would produce a code with no entry in the flash
 * table — and an unknown code renders NOTHING, so the user would have been
 * bounced back to the scanner with no explanation at all. Now a new reason is a
 * compile error instead of a silent blank.
 */
function flashForClaimFailure(reason: string): string {
  switch (reason) {
    case "invalid":
      return "qr-claim-invalid";
    case "not-found":
      return "qr-claim-not-found";
    case "already-claimed":
      return "qr-claim-already-claimed";
    case "archived":
      return "qr-claim-archived";
    case "business-forbidden":
      return "qr-claim-business-forbidden";
    case "not-claimable":
      return "qr-claim-not-claimable";
    default:
      // Unreachable for a typed reason; a plain string is tolerated because
      // this receives the widened reason from a failed result.
      return "qr-claim-unknown";
  }
}

function flashForResolution(resolution: AssetResolution): string {
  switch (resolution.state) {
    case "not-a-sqanny-qr":
      return "qr-invalid";
    case "unregistered":
      return "qr-not-recognised";
    case "taken":
      return "qr-already-claimed";
    case "archived":
      return "qr-archived";
    case "yours":
      return "qr-already-yours";
    default:
      return "qr-invalid";
  }
}

// ===========================================================================
// Step 4 — review
// ===========================================================================

/**
 * Reject an incomplete claim HERE, at the review step, rather than letting it
 * reach the final POST.
 *
 * The review page promises "this is the last step — the QR is claimed when you
 * confirm", so it must not render a ready-to-confirm summary of a claim with no
 * destination. It used to show an em-dash for the missing field and let the user
 * press the button, only for the final step to refuse and bounce them back to
 * step 3 — technically correct, but it spent two round trips to say something
 * the review page could already see, and it did that on the one screen whose
 * whole purpose is to be trustworthy about what is about to happen.
 *
 * The same validator the claim service uses, so the two cannot disagree about
 * whether something is claimable.
 */
function reviewIsClaimable(input: Record<string, string>): ClaimErrors | null {
  const { errors } = validateClaimInput({
    identifier: input.qr,
    businessId: input.business_id,
    name: input.name,
    category: input.category,
    customCategory: input.custom_category,
    placement: input.placement,
    destination: input.destination,
  });
  return Object.keys(errors).length ? (errors as ClaimErrors) : null;
}

qrs.post("/qrs/claim/review", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const str = (k: string) => (typeof body[k] === "string" ? String(body[k]) : "");

  const identifier = normalizeIdentifier(str("qr"));
  if (!identifier) return c.redirect(withFlash("/qrs/claim", "qr-invalid"), 302);

  const resolution = await resolveAsset(c.env.DB, identifier, user.id);
  if (resolution.state !== "claimable" && !(resolution.state === "yours" && !resolution.configured)) {
    return c.redirect(withFlash("/qrs/claim", flashForResolution(resolution)), 302);
  }

  const businessId = str("business_id");
  const business = businessId ? await getBusinessForUser(c.env.DB, businessId, user.id) : null;
  // Mandatory, and re-checked here rather than trusted from step 3: a review
  // page reached with a tampered hidden field must not render "None yet" and
  // let the user submit a claim the service will only reject.
  if (!business || business.status !== "active") {
    return c.redirect(
      withFlash(`/qrs/claim/business?qr=${encodeURIComponent(identifier)}`, "business-required"),
      302,
    );
  }

  // Send an incomplete claim back to the form that can fix it, with the values
  // intact — not forward to a summary that cannot be confirmed.
  const fieldErrors = reviewIsClaimable({
    qr: str("qr"),
    business_id: str("business_id"),
    name: str("name"),
    category: str("category"),
    custom_category: str("custom_category"),
    placement: str("placement"),
    destination: str("destination"),
  });
  if (fieldErrors) {
    const params = new URLSearchParams({
      qr: str("qr"),
      business: str("business_id"),
      notice: "qr-check-failed",
    });
    for (const key of ["name", "category", "custom_category", "placement", "destination"] as const) {
      params.set(key, str(key));
    }
    return c.html(
      renderDetailsStep({
        user,
        identifier,
        business: { id: business.id, name: business.name },
        businesses: await listBusinessesForUser(c.env.DB, user.id),
        values: {
          name: str("name"),
          category: str("category"),
          custom_category: str("custom_category"),
          placement: str("placement"),
          destination: str("destination"),
        },
        errors: fieldErrors,
        notice: "qr-check-failed",
      }),
    );
  }

  // The review shows the NORMALISED destination, and submits the same value
  // forward, so what the user confirms is literally what gets stored. Typing
  // "example.com/menu" and seeing "example.com/menu" confirmed here would leave
  // them unable to tell whether the scheme was added — and this is the last
  // screen before the claim becomes irreversible.
  const normalized = validateDestination(str("destination"));
  const destination = normalized.url ?? str("destination").trim();

  return c.html(
    <Frame
      user={user}
      step={4}
      businesses={await listBusinessesForUser(c.env.DB, user.id)}
      formIsland
    >
      <Card title="Review your QR setup">
        <p class="claim-review-lead t-body text-secondary">
          Everything look correct? This is the last step — the QR is claimed to your
          account when you confirm.
        </p>
        <dl class="claim-recap">
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">QR</dt>
            <dd class="tnum">{identifier}</dd>
          </div>
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">Business</dt>
            <dd>{business.name}</dd>
          </div>
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">Name</dt>
            <dd>{cleanText(str("name"), QR_NAME_MAX)}</dd>
          </div>
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">Category</dt>
            <dd>{categoryLabel(str("category"), str("custom_category"))}</dd>
          </div>
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">Placement</dt>
            <dd>{cleanText(str("placement"), 60) || "—"}</dd>
          </div>
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">Destination</dt>
            <dd class="claim-recap-url">{destination || "—"}</dd>
          </div>
        </dl>

<form method="post" action="/qrs/claim" data-validate data-dirty-guard data-guard-submit>
          {/* The destination is submitted in its NORMALISED form — the same
              string the recap above shows. Round-tripping the raw input instead
              would mean the confirmed value and the stored value could differ. */}
          {(
            [
              "qr",
              "business_id",
              "name",
              "category",
              "custom_category",
              "placement",
            ] as const
          ).map((k) => (
            <input type="hidden" name={k} value={str(k)} />
          ))}
          <input type="hidden" name="destination" value={destination} />
          <div class="form-actions">
            <Button type="submit" data-busy-label="Claiming…">
              Claim &amp; Activate QR
            </Button>
            <a
              class="btn btn-ghost"
              href={`/qrs/claim/details?qr=${encodeURIComponent(identifier)}&business=${encodeURIComponent(business.id)}`}
              role="button"
            >
              Back
            </a>
          </div>
        </form>
      </Card>
    </Frame>,
  );
});

// ===========================================================================
// The claim itself
// ===========================================================================

/**
 * Section 18/20. The atomic work is in claimQr(); this handler's job is to
 * report the outcome honestly and never leave a partial record.
 *
 * Every failure sends the user back to the scanner with an explanation rather
 * than a dead end, because a claim can be lost to another account between the
 * review screen and this POST and the user's own retry may be the only way
 * forward.
 */
qrs.post("/qrs/claim", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const str = (k: string) => (typeof body[k] === "string" ? String(body[k]) : "");

  const result = await claimQr(c.env.DB, {
    identifier: str("qr"),
    viewerId: user.id,
    businessId: str("business_id"),
    name: str("name"),
    category: str("category"),
    customCategory: str("custom_category"),
    placement: str("placement"),
    destination: str("destination"),
  });

  if (result.ok) {
    return c.redirect(
      `/qrs/claim/success?qr=${encodeURIComponent(result.asset.qr_identifier)}`,
      302,
    );
  }

  if (result.reason === "validation") {
    // Field-level: re-render step 3 with what they typed and the exact fields at
    // fault, so they fix one input instead of retyping the form or guessing.
    const identifier = normalizeIdentifier(str("qr"));
    if (!identifier) return c.redirect(withFlash("/qrs/claim", "qr-invalid"), 302);

    const resolution = await resolveAsset(c.env.DB, identifier, user.id);
    if (resolution.state !== "claimable" && !(resolution.state === "yours" && !resolution.configured)) {
      // The stand changed hands while the form sat open. That is a state
      // conflict, not a field problem, so say so instead of rendering errors
      // for fields the user never got wrong.
      return c.redirect(withFlash("/qrs/claim", flashForResolution(resolution)), 302);
    }

    const business = await getBusinessForUser(c.env.DB, str("business_id"), user.id);
    if (!business) {
      return c.redirect(
        withFlash(`/qrs/claim/business?qr=${encodeURIComponent(identifier)}`, "business-required"),
        302,
      );
    }

    return c.html(
      renderDetailsStep({
        user,
        identifier,
        business: { id: business.id, name: business.name },
        businesses: await listBusinessesForUser(c.env.DB, user.id),
        values: {
          name: str("name"),
          category: str("category"),
          custom_category: str("custom_category"),
          placement: str("placement"),
          destination: str("destination"),
        },
        errors: result.errors,
        notice: "qr-check-failed",
      }),
    );
  }

  // Everything else is a state conflict, not a field problem, so the honest
  // move is back to the scanner with the reason.
  return c.redirect(withFlash("/qrs/claim", flashForClaimFailure(result.reason)), 302);
});

qrs.get("/qrs/claim/success", requireAuth, async (c) => {
  const user = c.get("user")!;
  const identifier = normalizeIdentifier(c.req.query("qr") ?? "") ?? "";
  const asset = await getAssetViewByIdentifier(c.env.DB, identifier);
  // Only ever describe a stand that is actually yours.
  const mine = asset && asset.owner_id === user.id ? asset : null;

  // A serial that is missing, unknown, or someone else's must NOT get a
  // "successfully connected" page. This URL is guessable, and an earlier draft
  // rendered the generic success card for any input at all — so anyone could
  // mint a convincing "you claimed a QR" screen from a made-up serial.
  if (!mine) {
    return c.redirect(withFlash("/qrs", "qr-not-yours"), 302);
  }

  return c.html(
    <Frame user={user} step={4} businesses={await listBusinessesForUser(c.env.DB, user.id)}>
      <Card class="claim-success">
        <span class="claim-success-glyph" aria-hidden="true">
          <Icon name="check" size={26} />
        </span>
        <h2 class="t-heading-sm">QR successfully connected</h2>
        <p class="t-body text-secondary claim-success-lead">
          Your Sqanny QR is now connected to {mine.business_name ?? "your account"}.
        </p>
        <dl class="claim-recap">
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">QR ID</dt>
            <dd class="tnum">{mine.qr_identifier}</dd>
          </div>
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">Business</dt>
            <dd>{mine.business_name ?? "—"}</dd>
          </div>
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">Category</dt>
            <dd>{categoryLabel(mine.category, mine.custom_category)}</dd>
          </div>
          <div class="claim-recap-row">
            <dt class="t-body-sm text-secondary">Destination</dt>
            <dd class="claim-recap-url">{mine.destination ?? "—"}</dd>
          </div>
        </dl>
        <div class="form-actions">
          <Button href={`/qrs/${mine.id}`}>View QR</Button>
          <Button href="/app" variant="secondary">
            Go to Dashboard
          </Button>
          <Button href="/qrs/claim" variant="ghost">
            Claim Another QR
          </Button>
        </div>
      </Card>
    </Frame>,
  );
});

// ===========================================================================
// Management: /qrs and /qrs/:id
// ===========================================================================
//
// The claim flow is how a stand becomes yours. These two pages are what you
// come back to: every stand you own, and the one screen where a printed code
// can be retargeted, retired, or brought back.
//
// Both are scoped by `owner_id` in SQL, not by a check in the route. A stand
// belonging to another account is a 404 here, never a 403, so the URL cannot be
// used to discover that somebody else's stand exists.

/**
 * Status is shown with the shared Badge, whose vocabulary is a tone
 * (neutral/accent/success/warning/danger) rather than a lifecycle state. Mapping
 * explicitly keeps a future status from silently rendering an unstyled badge,
 * which is why this is a total Record and not a fallback.
 */
const STATUS_TONES: Record<QrStatus, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  unclaimed: "neutral",
  claimed: "warning",
  active: "success",
  archived: "neutral",
};

const QrStatusBadge: FC<{ status: QrStatus }> = ({ status }) => (
  <span class={`badge badge-${STATUS_TONES[status]}`}>{QR_STATUS_LABELS[status]}</span>
);


/** One row in the management list. */
const AssetRow: FC<{ asset: QrAssetView }> = ({ asset }) => (
  <li class="qrs-row">
    <div class="qrs-row-main">
      <a class="qrs-row-name" href={`/qrs/${asset.id}`}>
        {asset.name}
      </a>
      {/* Serial, placement, business, destination. Placement is the one that
          answers "which stand am I holding?" — with twenty stands in a box, the
          name and the serial are what you wrote down, and where it physically
          sits is what you need. */}
      <p class="qrs-row-meta t-body-sm text-secondary">
        <code class="qrs-row-serial tnum">{asset.qr_identifier}</code>
        {asset.placement ? <> · {asset.placement}</> : null}
        {asset.business_name ? <> · {asset.business_name}</> : null}
        {asset.destination ? <> · {destinationLabel(asset.destination)}</> : null}
      </p>
    </div>
    <div class="qrs-row-side">
      <QrStatusBadge status={asset.status} />
      <span class="qrs-row-scans t-body-sm text-secondary tnum">
        {asset.scan_count} scan{asset.scan_count === 1 ? "" : "s"}
      </span>
    </div>
  </li>
);

/** GET /qrs - every stand you own, with the filters that list actually needs. */
qrs.get("/qrs", requireAuth, async (c) => {
  const user = c.get("user")!;
  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  // Filter values are user input, so each one is validated against the domain
  // vocabularies before it reaches SQL. An unknown status is dropped rather
  // than passed through, which would otherwise produce a confusing empty list
  // instead of an error.
  const statusParam = c.req.query("status");
  const status = isQrStatus(statusParam) ? statusParam : null;
  const businessId = c.req.query("business") || null;
  const search = (c.req.query("q") ?? "").trim() || null;

  const [assets, counts] = await Promise.all([
    listAssetsForOwner(c.env.DB, user.id, { businessId, status, search }),
    countAssetsForOwner(c.env.DB, user.id),
  ]);
  const total = counts.total;


  return c.html(
<AppShell
      user={user}
      title="My Sqanny QRs"
      active="stands"
      businesses={businesses}
      notice={c.req.query("notice") ?? undefined}
      switchReturnTo="/qrs"
    >
      <div class="qrs">
        <header class="dash-header">

          <div>
            <h1 class="t-heading-sm">Sqanny Stands</h1>
            <p class="dash-sub t-body text-secondary">
              {total === 0
                ? "The printed stands connected to your account."
                : `${total} stand${total === 1 ? "" : "s"} connected to your account.`}
            </p>
          </div>
          <div class="dash-header-actions">
            <Button href="/qrs/claim" iconLeft={<Icon name="qr" size={16} />}>
              Claim a printed stand
            </Button>
          </div>
        </header>

        {assets.length === 0 ? (
          <EmptyState
            icon="qr"
            title={total === 0 ? "No stands yet" : "Nothing matches those filters"}
            body={
              total === 0
                ? "Scan the code printed on your Sqanny Stand to connect it. The code on the stand keeps working even if you change where it points later."
                : "Try a different search term, or clear the filters to see all of your stands."
            }
            action={
              total === 0 ? (
                <Button href="/qrs/claim" size="lg">
                  Claim your first stand
                </Button>
              ) : (
                <Button href="/qrs" size="lg" variant="secondary">
                  Clear filters
                </Button>
              )
            }
          />
        ) : (
          <>
            <form class="qrs-filters" method="get" action="/qrs" role="search">
              <div class="field qrs-filter-search">
                <label class="field-label" for="qrs-search">
                  Search
                </label>
                <input
                  class="input"
                  id="qrs-search"
                  type="search"
                  name="q"
                  value={search ?? ""}
                  placeholder="Name or QR ID"
                />
              </div>
              <div class="field">
                <label class="field-label" for="qrs-business">
                  Business
                </label>
                <select class="select" id="qrs-business" name="business">
                  <option value="">All businesses</option>
                  {businesses.map((b) => (
                    <option value={b.id} selected={b.id === businessId}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="qrs-status">
                  Status
                </label>
                <select class="select" id="qrs-status" name="status">
                  <option value="">Any status</option>
                  {(
                    ["active", "claimed", "archived"] as const
                  ).map((s) => (
                    <option value={s} selected={s === status}>
                      {QR_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div class="qrs-filter-actions">
                <Button type="submit" variant="secondary">
                  Apply
                </Button>
                {search || businessId || status ? (
                  <Button href="/qrs" variant="ghost">
                    Clear
                  </Button>
                ) : null}
              </div>
            </form>

            <ul class="qrs-list">
              {assets.map((a) => (
                <AssetRow asset={a} />
              ))}
            </ul>
          </>
        )}
      </div>
    </AppShell>,
  );
});

/**
 * Values a rejected edit came back with, so nothing the user typed is lost.
 *
 * This is the whole reason the page exists in this shape. The previous version
 * redirected to `/qrs/:id?err_name=…&err_destination=…` and the GET re-rendered
 * from the STORED row — which meant one bad destination cost the name, the
 * category, the placement and the business they had just changed, with no
 * indication which field was wrong (`err_name` was set by the handler and never
 * rendered by the page).
 *
 * Every field the form renders is therefore round-tripped, and every field the
 * form can reject is rendered as an error.
 */
interface EditValues {
  name: string;
  category: string;
  custom_category: string;
  placement: string;
  business_id: string;
  destination: string;
}

interface EditErrors {
  name?: string;
  category?: string;
  custom_category?: string;
  placement?: string;
  business_id?: string;
  destination?: string;
}

function editValuesFromQuery(q: Record<string, string | undefined>): EditValues {
  return {
    name: q.name ?? "",
    category: q.category ?? "",
    custom_category: q.custom_category ?? "",
    placement: q.placement ?? "",
    business_id: q.business_id ?? "",
    destination: q.destination ?? "",
  };
}

function editValuesFromAsset(asset: QrAssetView): EditValues {
  return {
    name: asset.name,
    category: asset.category ?? "reviews",
    custom_category: asset.custom_category ?? "",
    placement: asset.placement ?? "",
    business_id: asset.business_id ?? "",
    destination: asset.destination ?? "",
  };
}

/** Which fields were submitted, so the re-render knows to prefer them. */
function hasSubmittedFields(q: Record<string, string | undefined>): boolean {
  return Object.values(q).some((v) => typeof v === "string" && v.length > 0);
}

/**
 * GET /qrs/:id - one stand: its permanent code, where it points, and the
 * controls to change either. Editing here is a POST, so the destination can only
 * be changed by submitting a form; there is no client-side "save" that could
 * quietly drop an edit.
 */
qrs.get("/qrs/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const asset = await getAssetViewForOwner(c.env.DB, c.req.param("id"), user.id);

  // Not yours, or no longer exists. The same answer for both, so this URL
  // cannot be used to probe for other accounts' stands.
  if (!asset) return c.text("Not Found", 404);

  const businesses = await listBusinessesForUser(c.env.DB, user.id);
  // The only businesses a stand may sit under are ones the caller is a member
  // of, and the current one first so an unchanged edit is valid.
  const assignable = businesses.some((b) => b.id === asset.business_id)
    ? businesses
    : [...businesses, { id: asset.business_id ?? "", name: asset.business_name ?? "—" }];

  // A rejected edit comes back with the submitted values in the query string.
  // Anything else renders the stored row.
  const q = c.req.query();
  const rejected = hasSubmittedFields(q);
  const values = rejected ? editValuesFromQuery(q) : editValuesFromAsset(asset);
  const errors: EditErrors = rejected
    ? {
        name: q.err_name,
        category: q.err_category,
        custom_category: q.err_custom_category,
        placement: q.err_placement,
        business_id: q.err_business,
        destination: q.err_destination,
      }
    : {};
  const dirty = rejected;

  return c.html(
    <AppShell
      user={user}
      title={asset.name}
      active="stands"
      businesses={businesses}
      notice={c.req.query("notice") ?? undefined}
      switchReturnTo={`/qrs/${asset.id}`}
    >
      <div class="qrs">

        <p class="qrs-crumbs t-body-sm text-secondary">
          <a href="/qrs">Sqanny Stands</a>
        </p>

        <header class="dash-header">
          <div>
            <h1 class="t-heading-sm">
              {asset.name} <QrStatusBadge status={asset.status} />
            </h1>
            <p class="dash-sub t-body text-secondary">
              {categoryLabel(asset.category, asset.custom_category)}
              {asset.placement ? ` · ${asset.placement}` : ""}
            </p>
          </div>
        </header>

        <Card title="Permanent code">
          <p class="qrs-why t-body text-secondary">
            This is the code printed on the stand. It never changes, so you can
            repoint the stand below without reprinting anything.
          </p>
          <dl class="claim-recap">
            <div class="claim-recap-row">
              <dt class="t-body-sm text-secondary">QR ID</dt>
              <dd class="qrs-row-serial tnum">{asset.qr_identifier}</dd>
            </div>
            <div class="claim-recap-row">
              <dt class="t-body-sm text-secondary">Public link</dt>
              <dd class="claim-recap-url">{new URL(`/q/${asset.qr_identifier}`, c.env.APP_URL).href}</dd>
            </div>
            <div class="claim-recap-row">
              <dt class="t-body-sm text-secondary">Business</dt>
              <dd>{asset.business_name ?? "·"}</dd>
            </div>
            <div class="claim-recap-row">
              <dt class="t-body-sm text-secondary">Scans</dt>
              <dd class="tnum">{asset.scan_count}</dd>
            </div>
            {asset.last_scanned_at ? (
              <div class="claim-recap-row">
                <dt class="t-body-sm text-secondary">Last scanned</dt>
                <dd>{new Date(asset.last_scanned_at).toLocaleDateString("en-IN")}</dd>
              </div>
            ) : null}
          </dl>
        </Card>

{asset.status === "archived" ? (
          <Card title="This stand is retired">
            <p class="qrs-why t-body text-secondary">
              It is not serving its destination any more. Bring it back to start
              redirecting again.
            </p>
            <div class="form-actions">
              <form method="post" action={`/qrs/${asset.id}/restore`} data-guard-submit>
                <Button type="submit">Restore this stand</Button>
              </form>
              <Button href="/qrs" variant="secondary">
                Back to all stands
              </Button>
            </div>
          </Card>
        ) : (
          <Card title="Where this stand points">
            {/* An aria-live summary of a rejected save, so a screen-reader user
                is told what happened without having to hunt for each field. */}
            {dirty && Object.values(errors).some(Boolean) ? (
              <p class="qrs-form-error-summary" role="alert">
                {Object.values(errors).filter(Boolean).length === 1
                  ? "One field needs fixing."
                  : `${Object.values(errors).filter(Boolean).length} fields need fixing.`}{" "}
                Your other changes are still here — fix the highlighted fields and
                save again.
              </p>
            ) : null}
            <form method="post" action={`/qrs/${asset.id}/edit`} data-validate data-guard-submit>
              <div class="field">
                <Input
                  id="edit-name"
                  name="name"
                  label="QR Name"
                  required
                  maxlength={QR_NAME_MAX}
                  value={values.name}
                  error={errors.name}
                />
              </div>
              <div class="field">
                <label class="field-label" for="edit-business">
                  Business
                </label>
                <select
                  class="select"
                  id="edit-business"
                  name="business_id"
                  required
                  aria-invalid={errors.business_id ? "true" : undefined}
                  aria-describedby={errors.business_id ? "edit-business-error" : undefined}
                >
                  {assignable
                    .filter((b) => b.id)
                    .map((b) => (
                      <option
                        value={b.id}
                        selected={b.id === (values.business_id || asset.business_id)}
                      >
                        {b.name}
                      </option>
                    ))}
                </select>
                {errors.business_id ? (
                  <p class="field-error" id="edit-business-error" role="alert">
                    {errors.business_id}
                  </p>
                ) : null}
              </div>
              <div class="field-row">
                <div class="field">
                  <label class="field-label" for="edit-category">
                    Category
                  </label>
                  <select
                    class="select"
                    id="edit-category"
                    name="category"
                    required
                    aria-invalid={errors.category ? "true" : undefined}
                    aria-describedby={errors.category ? "edit-category-error" : undefined}
                  >
                    {categoryOptions().map((o) => (
                      <option
                        value={o.value}
                        selected={o.value === (values.category || asset.category)}
                      >
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {errors.category ? (
                    <p class="field-error" id="edit-category-error" role="alert">
                      {errors.category}
                    </p>
                  ) : null}
                </div>
                <div class="field">
                  <label class="field-label" for="edit-custom-category">
                    Custom category
                  </label>
                  <input
                    class="input"
                    id="edit-custom-category"
                    name="custom_category"
                    maxlength={LIMITS.customCategory}
                    placeholder="Wayfinding"
                    value={values.custom_category}
                    aria-invalid={errors.custom_category ? "true" : undefined}
                  />
                  <p class="field-hint">Only used if you chose Custom.</p>
                  {errors.custom_category ? (
                    <p class="field-error" role="alert">
                      {errors.custom_category}
                    </p>
                  ) : null}
                </div>
              </div>
              <div class="field">
                <Input
                  id="edit-placement"
                  name="placement"
                  label="Placement"
                  maxlength={QR_PLACEMENT_MAX}
                  value={values.placement}
                  error={errors.placement}
                  hint="Where the stand sits, e.g. Cash Desk."
                />
              </div>
              <div class="field">
                <Input
                  id="edit-destination"
                  name="destination"
                  label="Destination URL"
                  type="url"
                  required
                  maxlength={LIMITS.url}
                  value={values.destination}
                  error={errors.destination}
                  hint="Change this any time. The printed code keeps working."
                />
              </div>
              <div class="form-actions">
                <Button type="submit" data-busy-label="Saving…">
                  Save changes
                </Button>
                <Button href="/qrs" variant="secondary">
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        )}

        {asset.status !== "archived" ? (
          <Card title="Retire this stand">
            <p class="qrs-why t-body text-secondary">
              Retiring stops the code from redirecting. The stand keeps its
              history and its permanent code, so you can bring it back later.
            </p>
            {/* A confirm step, because this is the one action here that takes
                a printed code offline and cannot be undone from a phone. */}
            <details class="qrs-danger">
              <summary class="btn btn-secondary">Retire this stand</summary>
              <form method="post" action={`/qrs/${asset.id}/archive`} data-guard-submit>
                <p class="qrs-why t-body text-secondary">
                  {asset.name} will stop redirecting immediately.
                </p>
                <div class="form-actions">
                  <Button type="submit" variant="secondary">
                    Yes, retire it
                  </Button>
                  <Button href={`/qrs/${asset.id}`} variant="ghost">
                    Keep it live
                  </Button>
                </div>
              </form>
            </details>
          </Card>
        ) : null}
      </div>
    </AppShell>,
  );
});

/**
 * POST /qrs/:id/edit - repoint an existing stand.
 *
 * Runs the SAME validators the claim flow uses, via the same
 * `validateClaimInput` service, so a destination that was legal when a stand was
 * claimed is still legal when it is changed, and the category and name limits
 * cannot be bypassed by posting a different value than the form offered.
 *
 * That reuse is the fix for a real hole: this handler used to take
 * `body.category` verbatim and store it, so a hand-crafted POST could put
 * arbitrary text in a column every filter, label and group-by reads as a
 * controlled key.
 *
 * On failure it redirects back carrying every submitted field AND every field
 * error, so the page re-renders what the user typed rather than the stored row.
 */
qrs.post("/qrs/:id/edit", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const asset = await getAssetViewForOwner(c.env.DB, id, user.id);
  if (!asset) return c.text("Not Found", 404);

  if (asset.status === "archived") {
    return c.redirect(withFlash(`/qrs/${id}`, "qr-retired"), 302);
  }

  const body = await c.req.parseBody();
  const raw = (k: string): string =>
    typeof body[k] === "string" ? String(body[k]) : "";

  // Round-trip the submitted values first, so they survive whatever fails. Trim
  // to the same limits the service applies, but never truncate a value in a way
  // that hides the reason it was rejected.
  const submitted: EditValues = {
    name: raw("name").trim().slice(0, QR_NAME_MAX * 2),
    category: raw("category"),
    custom_category: raw("custom_category").trim().slice(0, LIMITS.customCategory * 2),
    placement: raw("placement").trim().slice(0, QR_PLACEMENT_MAX * 2),
    business_id: raw("business_id"),
    destination: raw("destination").trim().slice(0, LIMITS.url * 2),
  };

  // A rejected edit must not cost the user their other answers, so every
  // failure path returns through here carrying what they submitted.
  const back = (errors: Partial<Record<keyof EditValues, string>>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(submitted)) params.set(k, v);
    for (const [k, v] of Object.entries(errors)) {
      if (v) params.set(`err_${k}`, v);
    }
    return c.redirect(`/qrs/${id}?${params.toString()}`, 302);
  };

  const { clean, errors } = validateClaimInput({
    identifier: asset.qr_identifier,
    businessId: submitted.business_id,
    name: submitted.name,
    category: submitted.category,
    customCategory: submitted.custom_category,
    placement: submitted.placement,
    destination: submitted.destination,
  });

  // The business id came from the request, so membership is re-derived here for
  // the same reason the SQL re-derives it: a hand-edited field must not be able
  // to move a stand to another tenant. Rejecting it as a FIELD error (rather
  // than a flash) keeps everything else the user typed.
  const business = submitted.business_id
    ? await getBusinessForUser(c.env.DB, submitted.business_id, user.id)
    : null;
  if (!business || business.status !== "active") {
    return back({ business_id: "Choose one of your own businesses." });
  }

  if (!clean) {
    return back(errors as Partial<Record<keyof EditValues, string>>);
  }

  const result = await updateAssetConfig(c.env.DB, {
    registryId: id,
    ownerId: user.id,
    name: clean.name,
    category: clean.category,
    customCategory: clean.customCategory,
    placement: clean.placement,
    destination: clean.destination,
    businessId: business.id,
  });

  if (!result.ok) {
    const code = result.reason === "business-forbidden" ? "qr-claim-business-forbidden" : "qr-save-failed";
    return c.redirect(withFlash(`/qrs/${id}`, code), 302);
  }

  return c.redirect(withFlash(`/qrs/${id}`, "qr-saved"), 302);
});

/** POST /qrs/:id/archive - stop serving a stand, keeping its code and history. */
qrs.post("/qrs/:id/archive", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const result = await archiveAsset(c.env.DB, id, user.id);

  // The service returns the current status, so an already-archived stand is
  // reported rather than silently accepted as a fresh retirement.
  if (result.status === "archived") {
    const code = result.ok ? "qr-retired" : "qr-already-archived";
    return c.redirect(withFlash(`/qrs/${id}`, code), 302);
  }
  return c.redirect(withFlash(`/qrs/${id}`, "qr-not-yours"), 302);
});

/** POST /qrs/:id/restore - start serving a retired stand again. */
qrs.post("/qrs/:id/restore", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const result = await restoreAsset(c.env.DB, id, user.id);
  return c.redirect(
    withFlash(`/qrs/${id}`, result.ok ? "qr-restored" : "qr-not-yours"),
    302,
  );
});
