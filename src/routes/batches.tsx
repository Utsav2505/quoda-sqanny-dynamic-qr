// Batch QR generation.
//
// ---------------------------------------------------------------------------
// WHY /qrs/batches AND NOT /app/batches
// ---------------------------------------------------------------------------
// A batch produces printed stands, so it belongs in the stand namespace rather
// than the dashboard namespace: the same `/qrs` prefix the claim flow, the
// management list and the stand detail page already use. The batch routes are
// registered in this module, which index.tsx mounts BEFORE `qrs` precisely so
// that `/qrs/batches` is matched here and never falls through to `qrs`'s
// `/qrs/:identifier` route — the same ordering hazard the app already documents
// for `/app/businesses` vs `/app/:id`. There is a test for it.
//
// ---------------------------------------------------------------------------
// THE PRO GATE
// ---------------------------------------------------------------------------
// This is a FEATURE check, not authorisation, and there is no role system here.
// `users.plan_id` is the server-side account state and is the only thing consulted
// — nothing the client sends is trusted, and no "isPro" flag exists anywhere.
//
// The HTML routes render a feature-restriction page; they never redirect to
// something unrelated, because a redirect that "works" teaches the user nothing
// about why they cannot see the feature. The JSON export routes return a 402 with
// a message, because a fetch that follows a redirect to an HTML page cannot tell
// what happened.
//
// ---------------------------------------------------------------------------
// GENERATION IS A FORM POST, NOT A CLIENT API CALL
// ---------------------------------------------------------------------------
// The batch is created server-side in one transaction and the user is redirected
// to it. A fetch-based flow would need its own error rendering, its own duplicate
// suppression, and a second rendering path for the same result — for no gain,
// since the operation is not slow enough to warrant a client-side progress bar
// and the button-level busy state (`data-guard-submit`) is already the app's
// established pattern for exactly this.

import { Hono } from "hono";
import type { Context } from "hono";
import type { FC } from "hono/jsx";
import { requireAuth } from "../middleware/auth";
import type { AppEnv } from "../middleware/auth";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { Card } from "../ui/components/card";
import { Badge } from "../ui/components/badge";
import { Icon } from "../ui/icons";
import { Input } from "../ui/components/input";
import { EmptyState, EmptyStateButton } from "../ui/components/empty-state";
import { withFlash } from "../lib/flash";
import { hasProPlan } from "../lib/plans";
import { LIMITS } from "../lib/validate";
import {
  getBusinessForUser,
  listBusinessesForUser,
  type BusinessSummary,
} from "../db/queries";
import {
  archiveBatch,
  batchRenderInputs,
  createBatch,
  dynamicUrlFor,
  getBatchForOwner,
  listBatchQrs,
  listBatchesForOwner,
  restoreBatch,
  type BatchQrView,
  type BatchSummary,
} from "../db/batches";
import {
  BATCH_METADATA_MAX,
  BATCH_SIZE_MULTIPLE,
  formatSequence,
  parseSerial,
  previewBatch,
  validateBatchForm,
  type BatchFieldErrors,
  type BatchFormValues,
  type BatchMetadataField,
} from "../lib/batch";
import { buildManifest, isoTimestamp, type ManifestRow } from "../lib/manifest";
import { createZip } from "../lib/zip";
import { encodeMatrix } from "../lib/qr/encoder";
import { renderSvg } from "../lib/qr/render-svg";
import { safePalette } from "../lib/qr/scannability";
import type { QrDesign } from "../lib/qr/types";

export const batches = new Hono<AppEnv>();

// One guard for every route in this module. Applied with `use` so a route added
// later cannot accidentally be left unguarded — the failure mode of remembering
// to add `requirePro` to each handler is exactly the bug this avoids.
batches.use("/qrs/batches/*", requireAuth);
batches.use("/qrs/batches", requireAuth);

// ---------------------------------------------------------------------------
// Formatting helpers (shared with the list, the detail page and the manifest)
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * Deterministic filenames. Never "download" or "image(1)".
 *
 * `SQ-GR-B01.zip` for type GR / batch B01. The `SQ-` prefix is deliberate even
 * though every serial inside already carries it: this filename has to sort next
 * to the individual SVGs a user downloads one at a time, and those all start
 * `SQ-` too. A `GR-B01.zip` would land in a different place in the folder and in
 * the Downloads list for no gain.
 */
function zipFilename(b: BatchSummary): string {
  return `SQ-${b.type}-${b.batch_number}.zip`;
}
function manifestFilename(b: BatchSummary): string {
  return `SQ-${b.type}-${b.batch_number}-manifest.csv`;
}

/** The design a batch QR is rendered with. */
const BATCH_DESIGN: QrDesign = {
  fg: "#0D0D0F",
  bg: "#FFFFFF",
  moduleShape: "square",
  eyeStyle: "square",
  ecc: "M",
};

/**
 * Render one batch QR's SVG.
 *
 * Encodes the PERMANENT URL (`/q/<serial>`), never the destination. That is the
 * whole point of a dynamic code: the printed label must survive the destination
 * changing, so what is baked into the image is the redirect endpoint and nothing
 * else.
 */
function renderBatchSvg(appUrl: string, serial: string, design: QrDesign): string {
  const matrix = encodeMatrix(dynamicUrlFor(appUrl, serial), design.ecc);
  return renderSvg(matrix, safePalette(design));
}

/** Parse a stored design_json back into a design, tolerating junk. */
function parseDesign(json: string | null | undefined): QrDesign {
  if (!json) return { ...BATCH_DESIGN };
  try {
    const parsed = JSON.parse(json) as Partial<QrDesign>;
    return {
      fg: typeof parsed.fg === "string" ? parsed.fg : BATCH_DESIGN.fg,
      bg: typeof parsed.bg === "string" ? parsed.bg : BATCH_DESIGN.bg,
      moduleShape: parsed.moduleShape ?? BATCH_DESIGN.moduleShape,
      eyeStyle: parsed.eyeStyle ?? BATCH_DESIGN.eyeStyle,
      ecc: parsed.ecc ?? BATCH_DESIGN.ecc,
      margin: parsed.margin,
    };
  } catch {
    return { ...BATCH_DESIGN };
  }
}

// ---------------------------------------------------------------------------
// The Pro feature-restriction state
// ---------------------------------------------------------------------------

/**
 * What a non-Pro user sees.
 *
 * States the fact and the way out, and nothing else. No plan internals, no
 * limit tables, no implication that the page failed to load — a "something went
 * wrong" in place of a deliberate product boundary is the thing to avoid here.
 *
 * "View Plans" goes to the existing Plan card in Settings, because this
 * deployment has no pricing page and inventing one would be a dead link.
 */
const ProRequired: FC<{ user: Parameters<typeof AppShell>[0]["user"]; businesses?: BusinessSummary[] }> = ({
  user,
  businesses,
}) => (
  <div class="page-narrow">
    <header class="page-head">
      <h1 class="t-display-md">Batch QR generation</h1>
    </header>
    <Card>
      <EmptyState
        icon="sparkles"
        title="Batch QR generation is available on Pro"
        body="Upgrade your plan to generate QR batches — produce a whole run of printed stands from one form, then export them as a ZIP with an inventory manifest."
        action={<EmptyStateButton href="/app/settings#plan" label="View Plans" icon="plus" />}
        secondary={<EmptyStateButton href="/qrs" label="Back to Sqanny Stands" variant="secondary" />}
      />
      <p class="t-body-sm text-secondary">
        You&rsquo;re on the {user.plan_id.charAt(0).toUpperCase() + user.plan_id.slice(1)} plan.
      </p>
    </Card>
  </div>
);

// ---------------------------------------------------------------------------
// GET /qrs/batches — management list
// ---------------------------------------------------------------------------

/** One row. Kept to the columns that answer "what is this and what do I do". */
const BatchRowItem: FC<{ batch: BatchSummary }> = ({ batch }) => {
  const archived = batch.status === "archived";
  return (
    <Card class={"biz-row" + (archived ? " biz-row-archived" : "")}>
      <div class="biz-row-main">
        <div class="biz-row-body">
          <div class="biz-row-titleline">
            <h3 class="biz-row-title t-body">
              {batch.type}-{batch.batch_number}
            </h3>
            <Badge tone={archived ? "warning" : "success"} dot>
              {archived ? "Archived" : "Ready"}
            </Badge>
          </div>
          <p class="biz-row-meta t-body-sm text-secondary">
            {batch.quantity} {plural(batch.quantity, "QR")} ·{" "}
            <code class="tnum">{formatSequence(batch.sequence_start)}</code> –{" "}
            <code class="tnum">{formatSequence(batch.sequence_end)}</code> ·{" "}
            {formatDate(batch.created_at)}
          </p>
        </div>
      </div>
      <div class="biz-row-actions">
        <Button
          href={`/qrs/batches/${batch.id}`}
          variant="secondary"
          iconLeft={<Icon name="qr" size={18} />}
        >
          View
        </Button>
      </div>
    </Card>
  );
};

batches.get("/qrs/batches", async (c) => {
  const user = c.get("user")!;
  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  if (!hasProPlan(user.plan_id)) {
    return c.html(
      <AppShell
        user={user}
        title="Batch QR generation"
        active="batches"
        businesses={businesses}
        notice={c.req.query("notice")}
      >
        <ProRequired user={user} businesses={businesses} />
      </AppShell>,
    );
  }

  const all = await listBatchesForOwner(c.env.DB, user.id);
  const ready = all.filter((b) => b.status === "ready");
  const archived = all.filter((b) => b.status === "archived");

  return c.html(
    <AppShell
      user={user}
      title="Batch QR generation"
      active="batches"
      businesses={businesses}
      notice={c.req.query("notice")}
    >
      <div class="page-narrow">
        <header class="page-head page-head-split">
          <div class="page-head-text">
            <h1 class="t-display-md">Batch QR generation</h1>
            <p class="page-lede t-body text-secondary">
              Produce a run of printed stands from one form. Every code keeps its
              own permanent identity, so you can change where any of them points
              later without reprinting.
            </p>
          </div>
          <Button href="/qrs/batches/new" iconLeft={<Icon name="plus" />}>
            Generate Batch
          </Button>
        </header>

        {all.length === 0 ? (
          <EmptyState
            icon="qr"
            title="No batches yet"
            body="Generate your first batch to produce a set of printed Sqanny QR codes."
            action={<EmptyStateButton href="/qrs/batches/new" label="Generate Batch" icon="plus" />}
          />
        ) : (
          <>
            {ready.length > 0 ? (
              <section class="biz-section" aria-labelledby="batch-ready">
                <h2 class="biz-section-title t-body-sm text-secondary" id="batch-ready">
                  Ready
                </h2>
                <div class="biz-list">
                  {ready.map((b) => (
                    <BatchRowItem batch={b} />
                  ))}
                </div>
              </section>
            ) : null}

            {archived.length > 0 ? (
              <section class="biz-section" aria-labelledby="batch-archived">
                <h2 class="biz-section-title t-body-sm text-secondary" id="batch-archived">
                  Archived
                </h2>
                <div class="biz-list">
                  {archived.map((b) => (
                    <BatchRowItem batch={b} />
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </AppShell>,
  );
});

// ---------------------------------------------------------------------------
// The generator form
// ---------------------------------------------------------------------------

/** Read the form into `BatchFormValues`, from either encoding. */
async function readBatchForm(c: Context<AppEnv>): Promise<BatchFormValues> {
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const text = (k: string): string => (typeof body[k] === "string" ? String(body[k]) : "");
  return {
    sequenceStart: text("sequence_start"),
    batchNumber: text("batch_number"),
    type: text("type"),
    batchSize: text("batch_size"),
    destination: text("destination"),
    businessId: text("business_id"),
    metadata: readMetadataFrom(body),
  };
}

/**
 * Metadata rows from either shape.
 *
 * The no-JS form posts parallel `meta_name[]` / `meta_value[]` arrays; the client
 * island posts a single JSON string in `metadata` so it can add and remove rows
 * without a round trip. Both land here, so one form markup serves both.
 */
/**
 * Parse the JSON metadata encoding into rows.
 *
 * Shared by the POST body and the rejected-POST redirect query, so a row that
 * survives validation round-trips identically. Returns `[]` for anything
 * unparseable: a bad payload should cost the user their custom fields (visible
 * and recoverable), never a 500.
 *
 * The row cap is the point. `validateBatchForm` bounds what may be *submitted*,
 * but this also runs on GET, where nothing validates first — so without a cap
 * here a crafted link could ship a form with 50,000 input rows and a multi-
 * megabyte query string. Bound the parser, not only the validator.
 */
function parseMetadataJson(json: unknown): BatchMetadataField[] {
  const rows: BatchMetadataField[] = [];
  if (typeof json !== "string" || !json.trim()) return rows;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return rows;
    for (const entry of parsed) {
      if (rows.length >= BATCH_METADATA_MAX) break;
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      rows.push({
        name: typeof rec.name === "string" ? rec.name : "",
        value: typeof rec.value === "string" ? rec.value : "",
      });
    }
  } catch {
    // Treated as "no metadata rows" rather than a crash.
  }
  return rows;
}

function readMetadataFrom(body: Record<string, unknown>): BatchMetadataField[] {
  const rows = parseMetadataJson(body.metadata);

  if (!rows.length) {
    const names = body["meta_name[]"] ?? body.meta_name;
    const values = body["meta_value[]"] ?? body.meta_value;
    const toArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : "")) : typeof v === "string" ? [v] : [];
    const ns = toArray(names);
    const vs = toArray(values);
    for (let i = 0; i < Math.max(ns.length, vs.length); i++) {
      rows.push({ name: ns[i] ?? "", value: vs[i] ?? "" });
    }
  }

  return rows;
}

/** One metadata row in the form. */
const MetadataRow: FC<{
  index: number;
  field: BatchMetadataField;
  error?: string;
  readOnly: boolean;
}> = ({ index, field, error, readOnly }) => (
  <div class="batch-meta-row" data-meta-row>
    <div class="field">
      <label class="field-label" for={`meta-name-${index}`}>
        Field Name
      </label>
      <input
        class="input"
        id={`meta-name-${index}`}
        name="meta_name[]"
        value={field.name}
        maxlength={LIMITS.customCategory}
        placeholder="Manufacturing Line"
        disabled={readOnly}
        data-meta="name"
      />
    </div>
    <div class="field">
      <label class="field-label" for={`meta-value-${index}`}>
        Value
      </label>
      <input
        class="input"
        id={`meta-value-${index}`}
        name="meta_value[]"
        value={field.value}
        maxlength={LIMITS.description}
        placeholder="L02"
        disabled={readOnly}
        data-meta="value"
      />
    </div>
    <div class="field batch-meta-remove">
      <span class="field-label" aria-hidden="true">Remove</span>
      <Button
        type="button"
        variant="secondary"
        disabled={readOnly}
        data-meta-remove
        aria-label={`Remove custom field ${field.name || index + 1}`}
      >
        Remove
      </Button>
    </div>
    {error ? (
      <p class="field-error" role="alert">
        {error}
      </p>
    ) : null}
  </div>
);

batches.get("/qrs/batches/new", async (c) => {
  const user = c.get("user")!;
  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  if (!hasProPlan(user.plan_id)) {
    return c.html(
      <AppShell
        user={user}
        title="Batch QR generation"
        active="batches"
        businesses={businesses}
        notice={c.req.query("notice")}
      >
        <ProRequired user={user} businesses={businesses} />
      </AppShell>,
    );
  }

  const active = businesses.filter((b) => b.status === "active");

  return c.html(
    <AppShell
      user={user}
      title="Generate a batch"
      active="batches"
      businesses={businesses}
      notice={c.req.query("notice")}
      formIsland
    >
      <div class="page-narrow">
        <header class="page-head">
          <h1 class="t-display-md">Generate a batch</h1>
          <p class="page-lede t-body text-secondary">
            Every stand you generate gets its own permanent code. Set where they
            point now, or leave it blank and decide later — the printed labels
            won&rsquo;t need reprinting either way.
          </p>
        </header>

        <BatchForm
          values={{
            sequenceStart: c.req.query("sequence_start") ?? "",
            batchNumber: c.req.query("batch_number") ?? "",
            type: c.req.query("type") ?? "",
            batchSize: c.req.query("batch_size") ?? String(BATCH_SIZE_MULTIPLE),
            destination: c.req.query("destination") ?? "",
            businessId: c.req.query("business_id") ?? "",
            // The rejected-POST redirect carries the submitted metadata as JSON.
            // Without this, one bad field number wiped every custom field the user
            // had typed — the single most expensive kind of form-state loss,
            // because the metadata rows are the part nobody can retype from memory
            // after a 20-row batch.
            metadata: parseMetadataJson(c.req.query("metadata")),
          }}
          errors={readErrors(c.req.query())}
          businesses={active}
          defaultBusinessId={user.current_business_id}
          notice={c.req.query("notice")}
        />
      </div>
    </AppShell>,
  );
});

/** Turn `?err_*` query params back into field errors (rejected POST round-trip). */
function readErrors(q: Record<string, string | undefined>): BatchFieldErrors {
  const errors: BatchFieldErrors = {};
  if (q.err_sequence_start) errors.sequenceStart = q.err_sequence_start;
  if (q.err_batch_number) errors.batchNumber = q.err_batch_number;
  if (q.err_type) errors.type = q.err_type;
  if (q.err_batch_size) errors.batchSize = q.err_batch_size;
  if (q.err_destination) errors.destination = q.err_destination;
  if (q.err_business) errors.business = q.err_business;
  if (q.err_metadata) errors.metadata = q.err_metadata;
  if (q.err_serials) errors.metadata = q.err_serials;
  return errors;
}

/** The generator form. Rendered identically for GET and for a rejected POST. */
const BatchForm: FC<{
  values: BatchFormValues;
  errors: BatchFieldErrors;
  businesses: BusinessSummary[];
  defaultBusinessId?: string | null;
  notice?: string | null;
}> = ({ values, errors, businesses, defaultBusinessId, notice }) => {
  const preview = previewBatch(values);
  const metaRows = values.metadata.length
    ? values.metadata
    : [{ name: "", value: "" }];
  const canAddMore = values.metadata.length < BATCH_METADATA_MAX;

  return (
    <>
      <div data-batch-generator data-metadata-max={BATCH_METADATA_MAX}>
        <form method="post" action="/qrs/batches" data-batch-form data-guard-submit data-dirty-guard>
          <Card title="Batch configuration">
            <div class="field-row">
              <div class="field">
                <Input
                  id="batch-type"
                  name="type"
                  label="Type"
                  required
                  maxlength={8}
                  value={values.type}
                  placeholder="GR"
                  error={errors.type}
                  hint="Exactly 2 letters. Any two letters are accepted."
                  data-validate="batchType"
                  autocomplete="off"
                  autocapitalize="characters"
                  spellcheck={false}
                />
              </div>
              <div class="field">
                <Input
                  id="batch-number"
                  name="batch_number"
                  label="Batch No."
                  required
                  maxlength={24}
                  value={values.batchNumber}
                  placeholder="B01"
                  error={errors.batchNumber}
                  hint="Letters and digits, no spaces or dashes. e.g. B01, JAN01."
                  data-validate="batchNumber"
                  autocomplete="off"
                  spellcheck={false}
                />
              </div>
            </div>

            <div class="field-row">
              <div class="field">
                <Input
                  id="batch-sequence-start"
                  name="sequence_start"
                  label="Starting Sequence"
                  required
                  maxlength={16}
                  inputmode="numeric"
                  value={values.sequenceStart}
                  placeholder="1"
                  error={errors.sequenceStart}
                  hint="The first number in this run. 1 becomes 001; 1000 stays 1000."
                  data-validate="batchSequence"
                />
              </div>
              <div class="field">
                <Input
                  id="batch-size"
                  name="batch_size"
                  label="Batch Size"
                  required
                  maxlength={6}
                  inputmode="numeric"
                  value={values.batchSize}
                  error={errors.batchSize}
                  hint={`Must be a multiple of ${BATCH_SIZE_MULTIPLE} — 9, 18, 27…`}
                  data-validate="batchSize"
                />
              </div>
            </div>

            <div class="field">
              <Input
                id="batch-destination"
                name="destination"
                label="Destination URL"
                type="url"
                maxlength={LIMITS.url}
                value={values.destination}
                placeholder="https://"
                error={errors.destination}
                hint="Optional. Where these codes point right now. You can change it later without reprinting."
                data-validate="batchDestination"
              />
            </div>

            <div class="field">
              <label class="field-label" for="batch-business">
                Business <span class="field-required" aria-hidden="true">*</span>
              </label>
              <select
                class="select"
                id="batch-business"
                name="business_id"
                required
                aria-invalid={errors.business ? "true" : undefined}
                aria-describedby={errors.business ? "batch-business-error" : "batch-business-hint"}
              >
                {businesses.length === 0 ? (
                  <option value="">No businesses yet</option>
                ) : (
                  <option value="">Choose a business…</option>
                )}
                {businesses.map((b) => (
                  <option
                    value={b.id}
                    selected={b.id === (values.businessId || defaultBusinessId || "")}
                  >
                    {b.name}
                  </option>
                ))}
              </select>
              {errors.business ? (
                <p class="field-error" id="batch-business-error" role="alert">
                  {errors.business}
                </p>
              ) : (
                <p class="field-hint" id="batch-business-hint">
                  {businesses.length === 0 ? (
                    <>
                      Every Sqanny QR belongs to a business, so its scans stay
                      separate from your other locations.{" "}
                      <a href="/app/businesses/new">Create your first business</a>.
                    </>
                  ) : (
                    "These codes will be filed under this business."
                  )}
                </p>
              )}
            </div>
          </Card>

          <Card title="Custom fields">
            <p class="page-lede t-body text-secondary">
              Optional. Anything you want recorded with this batch &mdash;
              manufacturing line, campaign, production date &mdash; and included
              in the export manifest.
            </p>
            <div data-meta-list>
              {metaRows.map((f, i) => (
                <MetadataRow
                  index={i}
                  field={f}
                  readOnly={values.metadata.length === 0 && i === 0}
                />
              ))}
            </div>
            {errors.metadata ? (
              <p class="field-error" role="alert" data-meta-error>
                {errors.metadata}
              </p>
            ) : null}
            <div class="form-actions">
              <Button
                type="button"
                variant="secondary"
                data-meta-add
                disabled={!canAddMore}
                aria-label="Add a custom field"
              >
                + Add Field
              </Button>
              <p class="field-hint" data-meta-count>
                {values.metadata.length} of {BATCH_METADATA_MAX} custom fields
              </p>
            </div>
          </Card>

          <div class="form-actions">
            <Button type="submit" data-busy-label="Generating…">
              Generate Batch
            </Button>
            <Button href="/qrs/batches" variant="ghost">
              Cancel
            </Button>
          </div>
        </form>

        {/* The live preview. Computed from the same domain functions generation
            uses, so it is a promise rather than an approximation — and it creates
            no records to look at. */}
        <Card title="Batch preview" class="batch-preview-card">
          <div data-batch-preview aria-live="polite">
            {preview ? (
              <>
                <dl class="claim-recap">
                  <div class="claim-recap-row">
                    <dt class="t-body-sm text-secondary">Type</dt>
                    <dd class="tnum">{preview.type}</dd>
                  </div>
                  <div class="claim-recap-row">
                    <dt class="t-body-sm text-secondary">Batch</dt>
                    <dd class="tnum">{preview.batchNumber}</dd>
                  </div>
                  <div class="claim-recap-row">
                    <dt class="t-body-sm text-secondary">Quantity</dt>
                    <dd class="tnum">{preview.quantity}</dd>
                  </div>
                  <div class="claim-recap-row">
                    <dt class="t-body-sm text-secondary">Generated serial range</dt>
                    <dd class="claim-recap-url">
                      {preview.firstSerial} &rarr; {preview.lastSerial}
                    </dd>
                  </div>
                </dl>
                {preview.sample.length > 2 ? (
                  <>
                    <p class="field-hint">Including</p>
                    <ul class="batch-preview-sample">
                      {preview.sample.map((s) => (
                        <li class="tnum">{s}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {preview.crossesDigitBoundary ? (
                  <p class="batch-preview-note t-body-sm" data-digit-note>
                    This range crosses from 3-digit to 4-digit sequences. That&rsquo;s
                    supported &mdash; the codes just get longer.
                  </p>
                ) : null}
              </>
            ) : (
              <p class="t-body text-secondary" data-preview-empty>
                Fill in Type, Batch No., Starting Sequence and Batch Size to see
                the codes this batch will produce.
              </p>
            )}
          </div>
        </Card>
      </div>
      <script src="/js/batch.js" defer />
    </>
  );
};

// ---------------------------------------------------------------------------
// POST /qrs/batches — generate
// ---------------------------------------------------------------------------

batches.post("/qrs/batches", async (c) => {
  const user = c.get("user")!;
  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  // Re-checked here, not only in the GET. The form action is a plain public HTTP
  // endpoint: posting directly to it must get the same answer the page did.
  if (!hasProPlan(user.plan_id)) {
    return c.redirect(withFlash("/qrs/batches", "batch-pro-required"), 303);
  }

  const values = await readBatchForm(c);
  const { config, errors, ok } = validateBatchForm(values);

  // Business membership is re-derived from the submitted id rather than trusted:
  // a hand-crafted post must not be able to file a batch under another tenant.
  //
  // Mandatory, because `qr_registry`'s CHECK cannot represent an owned-but-
  // unscoped QR — and because the existing claim flow already makes a business
  // mandatory for the same reason. An account with no business is sent to create
  // one rather than being told to try again.
  let businessId = "";
  const business = values.businessId
    ? await getBusinessForUser(c.env.DB, values.businessId, user.id)
    : null;
  if (!business || business.status !== "active") {
    errors.business = businesses.some((b) => b.status === "active")
      ? "Choose one of your own active businesses."
      : "Create a business first — every Sqanny QR belongs to one.";
  } else {
    businessId = business.id;
  }

  const withBusiness: BatchFieldErrors = { ...errors };
  const reject = () => {
    const params = new URLSearchParams();
    params.set("type", values.type);
    params.set("batch_number", values.batchNumber);
    params.set("sequence_start", values.sequenceStart);
    params.set("batch_size", values.batchSize);
    params.set("destination", values.destination);
    if (values.businessId) params.set("business_id", values.businessId);
    if (values.metadata.length) params.set("metadata", JSON.stringify(values.metadata));
    if (withBusiness.sequenceStart) params.set("err_sequence_start", withBusiness.sequenceStart);
    if (withBusiness.batchNumber) params.set("err_batch_number", withBusiness.batchNumber);
    if (withBusiness.type) params.set("err_type", withBusiness.type);
    if (withBusiness.batchSize) params.set("err_batch_size", withBusiness.batchSize);
    if (withBusiness.destination) params.set("err_destination", withBusiness.destination);
    if (withBusiness.business) params.set("err_business", withBusiness.business);
    if (withBusiness.metadata) params.set("err_metadata", withBusiness.metadata);
    params.set("notice", "batch-generate-failed");
    return c.redirect(`/qrs/batches/new?${params.toString()}`, 303);
  };

  if (!ok || !config || withBusiness.business) return reject();

  const result = await createBatch(c.env.DB, {
    ownerId: user.id,
    businessId,
    config,
    appUrl: c.env.APP_URL,
  });

  if (!result.ok) {
    const params = new URLSearchParams();
    params.set("type", values.type);
    params.set("batch_number", values.batchNumber);
    params.set("sequence_start", values.sequenceStart);
    params.set("batch_size", values.batchSize);
    params.set("destination", values.destination);
    if (values.businessId) params.set("business_id", values.businessId);
    if (values.metadata.length) params.set("metadata", JSON.stringify(values.metadata));
    params.set("err_serials", result.message);
    params.set("notice", "batch-serials-exist");
    return c.redirect(`/qrs/batches/new?${params.toString()}`, 303);
  }

  return c.redirect(withFlash(`/qrs/batches/${result.batch.id}`, "batch-created"), 303);
});

// ---------------------------------------------------------------------------
// GET /qrs/batches/:id — detail
// ---------------------------------------------------------------------------

/** Search/filter/sort over the batch's QRs, applied server-side to the query. */
interface BatchQrQuery {
  search: string;
  sort: "sequence" | "created";
  dir: "asc" | "desc";
  page: number;
}

const QR_PAGE_SIZE = 50;

function readQrQuery(q: Record<string, string | undefined>): BatchQrQuery {
  const rawPage = Number(q.page ?? "1");
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;
  const sort: "sequence" | "created" = q.sort === "created" ? "created" : "sequence";
  const dir: "asc" | "desc" = q.dir === "desc" ? "desc" : "asc";
  return { search: (q.q ?? "").trim().slice(0, 80), sort, dir, page };
}

/** Apply search/sort/page in memory — the set is already bounded by BATCH_SIZE_MAX. */
function applyQrQuery(rows: BatchQrView[], query: BatchQrQuery) {
  let out = rows;
  if (query.search) {
    const needle = query.search.toLowerCase();
    out = out.filter((r) => r.serial.toLowerCase().includes(needle));
  }
  const factor = query.dir === "desc" ? -1 : 1;
  out = [...out].sort((a, b) =>
    query.sort === "created"
      ? (a.created_at - b.created_at) * factor
      : (a.sequence - b.sequence) * factor,
  );
  const total = out.length;
  const pages = Math.max(1, Math.ceil(total / QR_PAGE_SIZE));
  const page = Math.min(query.page, pages);
  const start = (page - 1) * QR_PAGE_SIZE;
  return { rows: out.slice(start, start + QR_PAGE_SIZE), total, page, pages };
}

batches.get("/qrs/batches/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const batch = await getBatchForOwner(c.env.DB, id, user.id);
  if (!batch) return c.text("Not Found", 404);

  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  if (!hasProPlan(user.plan_id)) {
    return c.html(
      <AppShell user={user} title="Batch QR generation" active="batches" businesses={businesses}>
        <ProRequired user={user} businesses={businesses} />
      </AppShell>,
    );
  }

  const allQrs = await listBatchQrs(c.env.DB, id, user.id);
  const query = readQrQuery(c.req.query());
  const view = applyQrQuery(allQrs, query);
  const archived = batch.status === "archived";
  const stamp = formatDate(batch.created_at);

  const searchParams = (over: Record<string, string> = {}) => {
    const p = new URLSearchParams({ sort: query.sort, dir: query.dir, ...over });
    if (query.search) p.set("q", query.search);
    return `?${p.toString()}`;
  };

  return c.html(
    <AppShell
      user={user}
      title={`${batch.type}-${batch.batch_number}`}
      active="batches"
      businesses={businesses}
      notice={c.req.query("notice")}
    >
      <div class="page-narrow">
        <header class="page-head">
          <p class="qrs-crumbs t-body-sm text-secondary">
            <a href="/qrs/batches">Batches</a> / <span>{batch.type}-{batch.batch_number}</span>
          </p>
          <div class="page-head-split">
            <div class="page-head-text">
              <h1 class="t-display-md">
                {batch.type}-{batch.batch_number}{" "}
                <Badge tone={archived ? "warning" : "success"} dot>
                  {archived ? "Archived" : "Ready"}
                </Badge>
              </h1>
              <p class="page-lede t-body text-secondary">
                {batch.quantity} {plural(batch.quantity, "code")} ·{" "}
                <code class="tnum">{formatSequence(batch.sequence_start)}</code> &rarr;{" "}
                <code class="tnum">{formatSequence(batch.sequence_end)}</code>
              </p>
            </div>
            <div class="dash-header-actions">
              {/* The ZIP streams via the browser's own downloader: a 2000-item
                  batch is tens of megabytes, and buffering that in page memory
                  to report a toast would be a worse experience than not getting
                  one. `attachment` on the response makes it save without leaving
                  the page. The manifest is small, so it is fetched — which buys
                  real success and failure reporting. */}
              <Button
                href={`/qrs/batches/${batch.id}/export.zip`}
                variant="secondary"
                iconLeft={<Icon name="download" size={18} />}
                data-download={`/qrs/batches/${batch.id}/export.zip`}
                data-download-filename={zipFilename(batch)}
                data-download-mode="navigate"
                data-download-label="Download ZIP"
                data-download-busy="Preparing your ZIP…"
              >
                Download ZIP
              </Button>
              <Button
                href={`/qrs/batches/${batch.id}/manifest.csv`}
                variant="secondary"
                iconLeft={<Icon name="download" size={18} />}
                data-download={`/qrs/batches/${batch.id}/manifest.csv`}
                data-download-filename={manifestFilename(batch)}
                data-download-label="Download Manifest"
                data-download-busy="Preparing…"
              >
                Download Manifest
              </Button>
            </div>
          </div>
        </header>

        <Card title="Batch information">
          <dl class="settings-defs">
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">Batch No.</dt>
              <dd class="settings-def-value t-body tnum">{batch.batch_number}</dd>
            </div>
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">Type</dt>
              <dd class="settings-def-value t-body tnum">{batch.type}</dd>
            </div>
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">Quantity</dt>
              <dd class="settings-def-value t-body tnum">{batch.quantity}</dd>
            </div>
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">Sequence</dt>
              <dd class="settings-def-value t-body tnum">
                {formatSequence(batch.sequence_start)} &rarr; {formatSequence(batch.sequence_end)}
              </dd>
            </div>
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">Business</dt>
              <dd class="settings-def-value t-body">{batch.business_name ?? "Not assigned"}</dd>
            </div>
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">Created</dt>
              <dd class="settings-def-value t-body">{stamp}</dd>
            </div>
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">Created by</dt>
              <dd class="settings-def-value t-body">{batch.owner_email}</dd>
            </div>
          </dl>

          {batch.metadata.length > 0 ? (
            <>
              <h3 class="t-body-sm text-secondary batch-meta-heading">Custom metadata</h3>
              <dl class="settings-defs">
                {batch.metadata.map((m) => (
                  <div class="settings-def">
                    <dt class="settings-def-label t-body-sm text-secondary">{m.name}</dt>
                    <dd class="settings-def-value t-body">{m.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
        </Card>

        <section class="biz-section" aria-labelledby="batch-qrs">
          <h2 class="biz-section-title t-body-sm text-secondary" id="batch-qrs">
            QR assets ({view.total})
          </h2>

          <form class="qrs-filters" method="get" action={`/qrs/batches/${batch.id}`} role="search">
            <div class="field qrs-filter-search">
              <label class="field-label" for="batch-search">Search</label>
              <input
                class="input"
                id="batch-search"
                type="search"
                name="q"
                value={query.search}
                placeholder="Serial number"
              />
            </div>
            <div class="field">
              <label class="field-label" for="batch-sort">Sort</label>
              <select class="select" id="batch-sort" name="sort">
                <option value="sequence" selected={query.sort === "sequence"}>
                  Sequence
                </option>
                <option value="created" selected={query.sort === "created"}>
                  Created
                </option>
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="batch-dir">Order</label>
              <select class="select" id="batch-dir" name="dir">
                <option value="asc" selected={query.dir === "asc"}>
                  Ascending
                </option>
                <option value="desc" selected={query.dir === "desc"}>
                  Descending
                </option>
              </select>
            </div>
            <div class="qrs-filter-actions">
              <Button type="submit" variant="secondary">
                Apply
              </Button>
              {query.search ? (
                <Button href={`/qrs/batches/${batch.id}`} variant="ghost">
                  Clear
                </Button>
              ) : null}
            </div>
          </form>

          {view.rows.length === 0 ? (
            <EmptyState
              icon="qr"
              title={query.search ? "Nothing matches that search" : "No QR codes in this batch"}
              body={
                query.search
                  ? "Try a different serial number."
                  : "This batch has no codes. That shouldn't happen — try regenerating the assets."
              }
              action={
                <EmptyStateButton
                  href={`/qrs/batches/${batch.id}`}
                  label={query.search ? "Clear search" : "Back to batch"}
                  variant="secondary"
                />
              }
            />
          ) : (
            <>
              {/* Paginated rather than rendered in full: a 2000-item batch is a
                  real use case, and 2000 rows of markup would stall the page. */}
              <div class="qr-scanlog-wrap" tabIndex={0} role="region" aria-label="Batch QR assets">
                <table class="qr-scanlog-table">
                  <thead>
                    <tr>
                      <th scope="col">Serial</th>
                      <th scope="col">Sequence</th>
                      <th scope="col">Status</th>
                      <th scope="col">Destination</th>
                      <th scope="col">Created</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((r) => (
                      <tr>
                        <td class="qr-scanlog-mono">{r.serial}</td>
                        <td class="tnum">{formatSequence(r.sequence)}</td>
                        <td>
                          <Badge tone={r.status === "archived" ? "neutral" : "success"}>
                            {r.status === "archived" ? "Archived" : "Active"}
                          </Badge>
                        </td>
                        <td class="qr-scanlog-mono">{r.destination ?? "—"}</td>
                        <td>{formatDate(r.created_at)}</td>
                        <td>
                          <div class="batch-row-actions">
                            <Button
                              href={`/qrs/batches/${batch.id}/qr/${r.registry_id}.svg`}
                              variant="ghost"
                              data-download={`/qrs/batches/${batch.id}/qr/${r.registry_id}.svg`}
                              data-download-filename={`${r.serial}.svg`}
                              data-download-busy="Preparing…"
                              aria-label={`Download SVG for ${r.serial}`}
                            >
                              SVG
                            </Button>
                            <Button
                              href={`/qrs/${r.registry_id}`}
                              variant="ghost"
                              aria-label={`View ${r.serial}`}
                            >
                              View
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {view.pages > 1 ? (
                <nav class="pagination" aria-label="Batch QR pages">
                  <p class="t-body-sm text-secondary" data-page-summary>
                    Page {view.page} of {view.pages} · {view.total}{" "}
                    {plural(view.total, "code")}
                  </p>
                  <div class="form-actions">
                    {view.page > 1 ? (
                      <Button
                        href={`/qrs/batches/${batch.id}${searchParams({ page: String(view.page - 1) })}`}
                        variant="secondary"
                      >
                        Previous
                      </Button>
                    ) : null}
                    {view.page < view.pages ? (
                      <Button
                        href={`/qrs/batches/${batch.id}${searchParams({ page: String(view.page + 1) })}`}
                        variant="secondary"
                      >
                        Next
                      </Button>
                    ) : null}
                  </div>
                </nav>
              ) : null}
            </>
          )}
        </section>

        <Card title={archived ? "Restore this batch" : "Regenerate and retire"}>
          {archived ? (
            <>
              <p class="qrs-why t-body text-secondary">
                This batch is retired: none of its codes redirect any more. The
                serials, the codes and the history all stay, so it can be brought
                back.
              </p>
              <div class="form-actions">
                <form method="post" action={`/qrs/batches/${batch.id}/restore`} data-guard-submit>
                  <Button type="submit" data-busy-label="Restoring…">
                    Restore batch
                  </Button>
                </form>
                <Button href="/qrs/batches" variant="secondary">
                  Back to batches
                </Button>
              </div>
            </>
          ) : (
            <>
              <p class="qrs-why t-body text-secondary">
                Regenerating rebuilds every image from the same permanent codes. It
                changes nothing about the codes themselves &mdash; not the serial,
                the batch, the business or where it points.
              </p>
              <div class="form-actions">
                <form method="post" action={`/qrs/batches/${batch.id}/regenerate`} data-guard-submit data-busy-label="Regenerating…">
                  <Button
                    type="submit"
                    variant="secondary"
                    data-busy-label="Regenerating…"
                    data-batch-regenerate
                  >
                    Regenerate Assets
                  </Button>
                </form>
              </div>

              <div class="danger-zone">
                <div class="danger-zone-text">
                  <h2 class="danger-zone-title t-heading-sm">Retire this batch</h2>
                  <p class="danger-zone-note t-body-sm text-secondary">
                    Retiring takes all {batch.quantity} codes offline at once. They
                    stop redirecting, but the codes and their history are preserved
                    and you can restore the batch later.
                  </p>
                </div>
                <form method="post" action={`/qrs/batches/${batch.id}/archive`} data-guard-submit>
                  <Button type="submit" variant="secondary" class="btn-danger" data-busy-label="Retiring…">
                    Retire Batch
                  </Button>
                </form>
              </div>
            </>
          )}
        </Card>
      </div>
    </AppShell>,
  );
});

// ---------------------------------------------------------------------------
// POST lifecycle
//
// Each handler re-checks the plan rather than relying on a page-level guard: a
// POST is a public HTTP endpoint that can be posted to directly, so "the page
// you saw was gated" proves nothing about this request.
// ---------------------------------------------------------------------------

batches.post("/qrs/batches/:id/archive", async (c) => {
  const user = c.get("user")!;
  if (!hasProPlan(user.plan_id)) {
    return c.redirect(withFlash("/qrs/batches", "batch-pro-required"), 303);
  }
  const id = c.req.param("id");
  const result = await archiveBatch(c.env.DB, id, user.id);
  if (!result.ok) return c.redirect(withFlash("/qrs/batches", "batch-not-found"), 303);
  return c.redirect(withFlash(`/qrs/batches/${id}`, "batch-archived"), 303);
});

batches.post("/qrs/batches/:id/restore", async (c) => {
  const user = c.get("user")!;
  if (!hasProPlan(user.plan_id)) {
    return c.redirect(withFlash("/qrs/batches", "batch-pro-required"), 303);
  }
  const id = c.req.param("id");
  const result = await restoreBatch(c.env.DB, id, user.id);
  if (!result.ok) return c.redirect(withFlash("/qrs/batches", "batch-not-found"), 303);
  return c.redirect(withFlash(`/qrs/batches/${id}`, "batch-restored"), 303);
});

/**
 * POST regenerate.
 *
 * Deliberately performs NO writes to QR identity. It re-renders the same SVG from
 * the same permanent URL and reports how many it produced, which is what makes it
 * safe to press twice: regenerating is idempotent by construction, so a
 * double-click cannot duplicate anything.
 *
 * The rendered output is not persisted — a batch's assets are derived on demand
 * from the QR record, which is why deleting one loses nothing.
 */
batches.post("/qrs/batches/:id/regenerate", async (c) => {
  const user = c.get("user")!;
  if (!hasProPlan(user.plan_id)) {
    return c.redirect(withFlash("/qrs/batches", "batch-pro-required"), 303);
  }
  const id = c.req.param("id");
  const batch = await getBatchForOwner(c.env.DB, id, user.id);
  if (!batch) return c.redirect(withFlash("/qrs/batches", "batch-not-found"), 303);

  const inputs = await batchRenderInputs(c.env.DB, id, user.id);
  let rendered = 0;
  for (const input of inputs) {
    try {
      renderBatchSvg(c.env.APP_URL, input.serial, parseDesign(input.design_json));
      rendered++;
    } catch (err) {
      // One bad render must not abandon the rest, and must not claim success.
      console.error(`[batches] could not render ${input.serial}:`, err);
    }
  }

  const code = rendered === inputs.length ? "batch-regenerated" : "batch-regenerate-partial";
  return c.redirect(withFlash(`/qrs/batches/${id}`, code), 303);
});

// ---------------------------------------------------------------------------
// Exports
//
// Content-Disposition: attachment on every one of these. Without it the browser
// DISPLAYS the file — an SVG renders, a CSV offers to download, a ZIP downloads
// only because nothing can display it. "Download ZIP" that opens a text file is
// not a download.
// ---------------------------------------------------------------------------

/** Render every QR in a batch, plus the manifest, into a ZIP. */
async function buildBatchZip(
  db: D1Database,
  batch: BatchSummary,
  appUrl: string,
): Promise<Uint8Array> {
  const inputs = await batchRenderInputs(db, batch.id, batch.owner_id);
  const entries = inputs.map((input) => ({
    name: `${input.serial}.svg`,
    content: renderBatchSvg(appUrl, input.serial, parseDesign(input.design_json)),
  }));

  // The manifest goes in last so it is easy to find, and is named per the
  // documented convention rather than "manifest.csv" repeated.
  entries.push({ name: "manifest.csv", content: buildBatchManifest(batch, inputs, appUrl) });

  return createZip(entries);
}

/**
 * Build the manifest for a batch.
 *
 * Built from the render inputs rather than a second query, so the SVG list and
 * the manifest can never describe different sets of codes. `appUrl` is passed in
 * rather than read from module state — a module-level "current app URL" would be
 * a cross-request race, and two exports running concurrently would write each
 * other's domain into the file.
 */
function buildBatchManifest(
  batch: BatchSummary,
  inputs: Array<{
    registry_id: string;
    serial: string;
    short_code: string | null;
    destination: string | null;
  }>,
  appUrl: string,
): string {
  const rows: ManifestRow[] = inputs.map((input) => ({
    serial_number: input.serial,
    // The registry id, which is what the standalone code's own page is keyed on.
    qr_id: input.registry_id,
    type: batch.type,
    batch_number: batch.batch_number,
    sequence: formatSequence(parseSequenceOf(input.serial)),
    // The permanent URL — what the printed code encodes. Present so a printed
    // sheet can be checked against the label without trusting the other columns.
    dynamic_url: dynamicUrlFor(appUrl, input.serial),
    destination_url: input.destination ?? "",
    status: batch.status,
    created_at: isoTimestamp(batch.created_at),
  }));
  return buildManifest(rows, batch.metadata);
}

/** The sequence number embedded in a batch serial. */
function parseSequenceOf(serial: string): number {
  return parseSerial(serial)?.sequence ?? 0;
}

/** GET /qrs/batches/:id/export.zip — the whole batch as one archive. */
batches.get("/qrs/batches/:id/export.zip", async (c) => {
  const user = c.get("user")!;
  if (!hasProPlan(user.plan_id)) {
    return c.json({ ok: false, error: "Batch QR generation is available on Pro." }, 402);
  }
  const batch = await getBatchForOwner(c.env.DB, c.req.param("id"), user.id);
  if (!batch) return c.text("Not Found", 404);

  let zip: Uint8Array;
  try {
    zip = await buildBatchZip(c.env.DB, batch, c.env.APP_URL);
  } catch (err) {
    console.error("[batches] zip export failed:", err);
    return c.json(
      { ok: false, error: "Couldn't prepare the batch ZIP. Please try again." },
      500,
    );
  }

  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      // The header that actually makes this a download rather than a navigation.
      "content-disposition": `attachment; filename="${zipFilename(batch)}"`,
      "content-length": String(zip.length),
      "cache-control": "no-store",
    },
  });
});

/** GET /qrs/batches/:id/manifest.csv — the inventory on its own. */
batches.get("/qrs/batches/:id/manifest.csv", async (c) => {
  const user = c.get("user")!;
  if (!hasProPlan(user.plan_id)) {
    return c.json({ ok: false, error: "Batch QR generation is available on Pro." }, 402);
  }
  const batch = await getBatchForOwner(c.env.DB, c.req.param("id"), user.id);
  if (!batch) return c.text("Not Found", 404);

  const inputs = await batchRenderInputs(c.env.DB, batch.id, user.id);
  const csv = buildBatchManifest(batch, inputs, c.env.APP_URL);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${manifestFilename(batch)}"`,
      "cache-control": "no-store",
    },
  });
});

/** GET /qrs/batches/:id/qr/:registryId.svg — one code, as an attachment. */
batches.get("/qrs/batches/:id/qr/:registryId{.+\\.svg}", async (c) => {
  const user = c.get("user")!;
  if (!hasProPlan(user.plan_id)) {
    return c.text("Batch QR generation is available on Pro.", 402);
  }
  const batch = await getBatchForOwner(c.env.DB, c.req.param("id"), user.id);
  if (!batch) return c.text("Not Found", 404);

  const registryId = c.req.param("registryId").replace(/\.svg$/, "");
  const inputs = await batchRenderInputs(c.env.DB, batch.id, user.id);
  const input = inputs.find((i) => i.registry_id === registryId);
  if (!input) return c.text("Not Found", 404);

  let svg: string;
  try {
    svg = renderBatchSvg(c.env.APP_URL, input.serial, parseDesign(input.design_json));
  } catch (err) {
    console.error(`[batches] could not render ${input.serial}:`, err);
    return c.text("Unable to render this QR code.", 500);
  }

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Attachment, not inline: this is the actual fix for "Download SVG opens a
      // tab". An `inline` disposition here is what caused it.
      "content-disposition": `attachment; filename="${input.serial}.svg"`,
      "cache-control": "no-store",
    },
  });
});
