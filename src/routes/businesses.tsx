import { Hono } from "hono";
import type { Context } from "hono";
import type { FC } from "hono/jsx";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { Card } from "../ui/components/card";
import { Badge } from "../ui/components/badge";
import { Icon } from "../ui/icons";
import { Avatar } from "../ui/components/avatar";
import { EmptyState, EmptyStateButton } from "../ui/components/empty-state";
import { BusinessForm } from "../ui/components/business-form";
import type {
  BusinessFormErrors,
  BusinessFormValues,
} from "../ui/components/business-form";
import {
  listBusinessesForUser,
  getBusinessForUser,
  createBusiness,
  updateBusinessForUser,
  setBusinessStatusForUser,
  setCurrentBusiness,
  countBusinessesForUser,
  listQrByUserScoped,
  type BusinessRow,
  type BusinessSummary,
} from "../db/queries";
import {
  businessLocation,
  categoryLabel,
  isBusinessCategory,
  isBusinessStatus,
  parseHours,
  serializeHours,
  DAY_KEYS,
  DAY_LABELS,
  type BusinessHours,
  type DayKey,
} from "../lib/business";
import {
  LIMITS,
  cleanText,
  cleanMultiline,
  isTime,
  normalizeEmail,
  normalizeUrl,
  orNull,
  validateEmail,
  validateName,
  validatePhone,
  validateUrl,
} from "../lib/validate";
import { withFlash } from "../lib/flash";
import { manageHref } from "./dashboard";
import { storeImage, ownsKey } from "./api/upload";
import type { Bindings } from "../types";

export const businesses = new Hono<AppEnv>();
businesses.use("/app/*", requireAuth);

type Ctx = Context<AppEnv>;

/** Both branches: authenticated, so the user is always present. */
function userOf(c: Ctx) {
  const user = c.get("user");
  if (!user) throw new Error("requireAuth did not run");
  return user;
}

// ---------------------------------------------------------------------------
// Form parsing â€” the server-side gate
// ---------------------------------------------------------------------------

/** Flatten a parsed body (multipart or urlencoded) to a string map. */
async function readFields(c: Ctx): Promise<Record<string, unknown>> {
  const body = await c.req.parseBody();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) out[k] = v;
  return out;
}

/** Read one field as a trimmed string, or "" when absent. */
function str(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return typeof v === "string" ? v : "";
}

/** Build BusinessHours from the flat `hours_<day>_<part>` inputs. */
function readHours(fields: Record<string, unknown>): BusinessHours {
  const hours: BusinessHours = {};
  for (const day of DAY_KEYS) {
    const closed = str(fields, `hours_${day}_closed`) === "1";
    const open = str(fields, `hours_${day}_open`).trim();
    const close = str(fields, `hours_${day}_close`).trim();
    if (closed) {
      hours[day] = { open: null, close: null, closed: true };
      continue;
    }
    if (open || close) {
      hours[day] = {
        open: isTime(open) ? open : null,
        close: isTime(close) ? close : null,
        closed: false,
      };
    }
  }
  return hours;
}

/** Echo the submitted values back into the form so nothing is lost on error. */
export function echoValues(fields: Record<string, unknown>): BusinessFormValues {
  return {
    name: str(fields, "name"),
    category: str(fields, "category"),
    custom_category: str(fields, "custom_category"),
    address: str(fields, "address"),
    city: str(fields, "city"),
    state: str(fields, "state"),
    country: str(fields, "country"),
    phone: str(fields, "phone"),
    email: str(fields, "email"),
    website: str(fields, "website"),
    google_business_url: str(fields, "google_business_url"),
    instagram_url: str(fields, "instagram_url"),
    facebook_url: str(fields, "facebook_url"),
    description: str(fields, "description"),
    logo_key: str(fields, "logo_key") || null,
    hours: readHours(fields),
  };
}

export interface ParsedBusiness {
  patch: {
    name: string;
    category: string;
    custom_category: string | null;
    address: string;
    city: string;
    state: string;
    country: string;
    phone: string | null;
    email: string | null;
    website: string | null;
    google_business_url: string | null;
    instagram_url: string | null;
    facebook_url: string | null;
    description: string | null;
    logo_key: string | null;
    hours_json: string | null;
  };
  errors: BusinessFormErrors;
}

/**
 * Validate + normalize a business submission.
 *
 * This is the real gate. The client island runs the same rules for immediate
 * feedback, but a form POST is an ordinary public HTTP request, so nothing may
 * rely on the browser having checked anything. Every value is coerced to a
 * string, length-capped, then validated â€” a wrong-typed or over-long value
 * becomes a field error, never a 500.
 */
export async function parseBusiness(
  fields: Record<string, unknown>,
  env: Bindings,
  userId: string,
): Promise<ParsedBusiness> {
  const errors: BusinessFormErrors = {};

  const name = cleanText(str(fields, "name"), LIMITS.businessName);
  const nameError = validateName(name, {
    required: true,
    label: "Business name",
    max: LIMITS.businessName,
  });
  if (nameError) errors.name = nameError;

  const categoryRaw = str(fields, "category").trim();
  const category = isBusinessCategory(categoryRaw) ? categoryRaw : "";
  if (!category) errors.category = "Choose a business category.";

  // "other" is the escape hatch; the free-text companion becomes the label.
  // Any other category discards the submitted free text rather than storing it
  // alongside a category that already has a name: a hidden field must never be
  // able to smuggle a value into a column the UI says is empty.
  let customCategory: string | null = null;
  if (category === "other") {
    customCategory = cleanText(str(fields, "custom_category"), LIMITS.customCategory);
    if (!customCategory) errors.custom_category = "Enter a category name.";
  }

  const address = cleanText(str(fields, "address"), LIMITS.address);
  if (!address) errors.address = "Address is required.";

  const city = cleanText(str(fields, "city"), LIMITS.city);
  if (!city) errors.city = "City is required.";

  const state = cleanText(str(fields, "state"), LIMITS.locality);
  if (!state) errors.state = "State is required.";

  const country = cleanText(str(fields, "country"), LIMITS.country);
  if (!country) errors.country = "Country is required.";

  const phone = cleanText(str(fields, "phone"), LIMITS.phone);
  const phoneError = validatePhone(phone);
  if (phoneError) errors.phone = phoneError;

  const emailRaw = cleanText(str(fields, "email"), LIMITS.email);
  const emailError = validateEmail(emailRaw);
  if (emailError) errors.email = emailError;

  const URL_FIELDS = [
    ["website", "Website"],
    ["google_business_url", "Google Business Profile URL"],
    ["instagram_url", "Instagram URL"],
    ["facebook_url", "Facebook URL"],
  ] as const;
  const urls: Record<string, string | null> = {};
  for (const [key, label] of URL_FIELDS) {
    const raw = cleanText(str(fields, key), LIMITS.url);
    const err = validateUrl(raw, { label });
    if (err) {
      errors[key] = err;
      urls[key] = orNull(raw);
      continue;
    }
    // Store the canonical form, so "abc.com" and "https://abc.com/" match.
    urls[key] = normalizeUrl(raw);
  }

  const description = cleanMultiline(str(fields, "description"), LIMITS.description);

  // Image: a key the JS island already uploaded, or a file posted directly by
  // the no-JavaScript form. `ownsKey` rejects a crafted key pointing at another
  // account's object.
  const submittedKey = str(fields, "logo_key").trim();
  let logoKey: string | null = null;
  if (submittedKey) {
    if (ownsKey(submittedKey, userId, "logo")) logoKey = submittedKey;
    else errors.logo_key = "That image could not be used. Try another.";
  }
  if (!logoKey) {
    const stored = await storePostedImage(fields.logo_key_file, env, userId, "logo");
    if (stored.ok) logoKey = stored.key;
    else if (stored.error) errors.logo_key = stored.error;
  }

  return {
    patch: {
      name,
      category,
      custom_category: customCategory,
      address,
      city,
      state,
      country,
      phone: orNull(phone),
      email: emailError ? null : orNull(normalizeEmail(emailRaw)),
      website: urls.website,
      google_business_url: urls.google_business_url,
      instagram_url: urls.instagram_url,
      facebook_url: urls.facebook_url,
      description: orNull(description),
      logo_key: logoKey,
      hours_json: serializeHours(readHours(fields)),
    },
    errors,
  };
}

/** Store a file posted straight into a form (the no-JS path). */
async function storePostedImage(
  file: unknown,
  env: Bindings,
  userId: string,
  scope: "avatar" | "logo",
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  if (file === undefined || file === null) return { ok: false, error: "" };
  if (typeof file === "string") return { ok: false, error: "" };
  const blob = file as { type?: string; arrayBuffer?: unknown };
  if (typeof blob.arrayBuffer !== "function") return { ok: false, error: "" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const stored = await storeImage(env, userId, scope, bytes, blob.type || "");
  return stored.ok ? { ok: true, key: stored.key } : { ok: false, error: stored.error };
}

const hasErrors = (errors: BusinessFormErrors): boolean =>
  Object.keys(errors).length > 0;

/** Human label per QR type, for the business page's QR rows. */
const TYPE_LABEL: Record<string, string> = {
  url: "Website",
  text: "Text",
  wifi: "Wi-Fi",
  email: "Email",
  tel: "Phone",
  sms: "SMS",
  vcard: "Contact",
  pdf: "PDF",
  menu: "Menu",
  business: "Business",
  appstore: "App",
  social: "Social",
};

function formValuesFrom(b: BusinessRow): BusinessFormValues {
  return {
    name: b.name,
    category: b.category,
    custom_category: b.custom_category ?? "",
    address: b.address ?? "",
    city: b.city ?? "",
    state: b.state ?? "",
    country: b.country ?? "",
    phone: b.phone ?? "",
    email: b.email ?? "",
    website: b.website ?? "",
    google_business_url: b.google_business_url ?? "",
    instagram_url: b.instagram_url ?? "",
    facebook_url: b.facebook_url ?? "",
    description: b.description ?? "",
    logo_key: b.logo_key,
    hours: parseHours(b.hours_json),
  };
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Only allow same-origin, absolute-path redirects. An open redirect here would
 * let a crafted form bounce a signed-in user â€” flash notice included â€” to
 * another site.
 */
function safeNext(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "";
  return value;
}

// ---------------------------------------------------------------------------
// Shared view pieces
// ---------------------------------------------------------------------------

/**
 * 404. Deliberately identical for "no such business" and "not yours": a
 * distinct 403 would confirm that an id exists on someone else's account.
 */
const NotFound: FC = () => (
  <div class="page-narrow">
    <EmptyState
      icon="close"
      title="Business not found"
      body="This business doesn't exist, or it isn't one of yours."
      action={<EmptyStateButton href="/app/businesses" label="Back to Businesses" />}
    />
  </div>
);

const BusinessRowItem: FC<{ business: BusinessSummary }> = ({ business }) => {
  const archived = business.status === "archived";
  return (
    <Card class={"biz-row" + (archived ? " biz-row-archived" : "")}>
      <div class="biz-row-main">
        <Avatar size="md" name={business.name} src={business.logo_key} />
        <div class="biz-row-body">
          <div class="biz-row-titleline">
            <h3 class="biz-row-title t-body">{business.name}</h3>
            <Badge tone="neutral">
              {categoryLabel(business.category, business.custom_category)}
            </Badge>
            {archived ? (
              <Badge tone="warning" dot>
                Archived
              </Badge>
            ) : null}
          </div>
          <p class="biz-row-meta t-body-sm text-secondary">
            {businessLocation(business)} · {business.qr_count}{" "}
            {business.qr_count === 1 ? "QR" : "QRs"} · updated{" "}
            {formatDate(business.updated_at)}
          </p>
        </div>
      </div>
      <div class="biz-row-actions">
        <Button
          href={`/app/businesses/${business.id}`}
          variant="secondary"
          iconLeft={<Icon name="qr" size={18} />}
        >
          Manage
        </Button>
        <Button
          href={`/app/businesses/${business.id}/edit`}
          variant="ghost"
          iconLeft={<Icon name="settings" size={18} />}
        >
          Edit
        </Button>
      </div>
    </Card>
  );
};

/** Read-only summary of every field on the business record. */
const BusinessFacts: FC<{ business: BusinessSummary }> = ({ business }) => {
  const rows: Array<[string, string | null]> = [
    ["Address", business.address],
    ["City", business.city],
    ["State", business.state],
    ["Country", business.country],
    ["Phone", business.phone],
    ["Email", business.email],
    ["Website", business.website],
    ["Google Business Profile", business.google_business_url],
    ["Instagram", business.instagram_url],
    ["Facebook", business.facebook_url],
    ["Description", business.description],
  ];

  const hours = parseHours(business.hours_json);
  const hoursRows: Array<[string, string]> = DAY_KEYS.filter(
    (d) => hours[d] !== undefined,
  ).map((d: DayKey) => {
    const h = hours[d]!;
    return [
      DAY_LABELS[d],
      h.closed ? "Closed" : `${h.open ?? "?"} â€“ ${h.close ?? "?"}`,
    ];
  });

  return (
    <Card title="Details" class="biz-facts">
      <dl class="settings-defs">
        {rows
          .filter(([, value]) => Boolean(value))
          .map(([label, value]) => (
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">{label}</dt>
              <dd class="settings-def-value t-body">{value}</dd>
            </div>
          ))}
        {hoursRows.length
          ? hoursRows.map(([label, value]) => (
              <div class="settings-def">
                <dt class="settings-def-label t-body-sm text-secondary">{label}</dt>
                <dd class="settings-def-value t-body">{value}</dd>
              </div>
            ))
          : null}
        <div class="settings-def">
          <dt class="settings-def-label t-body-sm text-secondary">Created</dt>
          <dd class="settings-def-value t-body">{formatDate(business.created_at)}</dd>
        </div>
        <div class="settings-def">
          <dt class="settings-def-label t-body-sm text-secondary">Last updated</dt>
          <dd class="settings-def-value t-body">{formatDate(business.updated_at)}</dd>
        </div>
      </dl>
      <div class="biz-facts-actions">
        <Button
          href={`/app/businesses/${business.id}/edit`}
          variant="secondary"
          iconLeft={<Icon name="settings" size={18} />}
        >
          Edit details
        </Button>
      </div>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// GET /app/businesses â€” the list
// ---------------------------------------------------------------------------

businesses.get("/app/businesses", async (c) => {
  const user = userOf(c);
  const all = await listBusinessesForUser(c.env.DB, user.id);
  const active = all.filter((b) => b.status === "active");
  const archived = all.filter((b) => b.status === "archived");

  return c.html(
    <AppShell
      user={user}
      title="Businesses"
      active="businesses"
      businesses={all}
      notice={c.req.query("notice")}
    >
      <div class="page-narrow">
        <header class="page-head page-head-split">
          <div class="page-head-text">
            <h1 class="t-display-md">Businesses</h1>
            <p class="page-lede t-body text-secondary">
              Every place you manage. Each business keeps its own QRs, contact
              details and scan history.
            </p>
          </div>
          <Button href="/app/businesses/new" iconLeft={<Icon name="plus" />}>
            Add Business
          </Button>
        </header>

        {active.length === 0 && archived.length === 0 ? (
          <EmptyState
            icon="business"
            title="No businesses yet"
            body="Create your first business to start claiming and managing Sqanny QRs."
            action={
              <EmptyStateButton
                href="/app/businesses/new"
                label="+ Create Business"
                icon="plus"
              />
            }
          />
        ) : (
          <>
            <section class="biz-section" aria-labelledby="biz-active">
              <h2 class="biz-section-title t-body-sm text-secondary" id="biz-active">
                Active
              </h2>
              {active.length === 0 ? (
                <p class="biz-section-empty t-body-sm text-secondary">
                  No active businesses. Restore one below, or add a new one.
                </p>
              ) : (
                <div class="biz-list">
                  {active.map((b) => (
                    <BusinessRowItem business={b} />
                  ))}
                </div>
              )}
            </section>

            {archived.length > 0 ? (
              <section class="biz-section" aria-labelledby="biz-archived">
                <h2 class="biz-section-title t-body-sm text-secondary" id="biz-archived">
                  Archived
                </h2>
                <div class="biz-list">
                  {archived.map((b) => (
                    <BusinessRowItem business={b} />
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
// GET/POST /app/businesses/new
// ---------------------------------------------------------------------------

const NEW_LEDE =
  "Six required fields, then save. Everything else can wait until you need it.";
businesses.get("/app/businesses/new", async (c) => {
  const user = userOf(c);
  const list = await listBusinessesForUser(c.env.DB, user.id);
  return c.html(
    <AppShell
      user={user}
      title="Add Business"
      active="businesses"
      businesses={list}
      notice={c.req.query("notice")}
      formIsland
    >
      <div class="page-narrow">
        <header class="page-head">
          <Breadcrumbs current="Add Business" />
          <h1 class="t-display-md">Add a business</h1>
          <p class="page-lede t-body text-secondary">{NEW_LEDE}</p>
        </header>

        <BusinessForm
          action="/app/businesses/new"
          uid="new"
          values={{ category: "cafe" }}
          errors={{}}
          submitLabel="Create Business"
          busyLabel="Creatingâ€¦"
        />
      </div>
    </AppShell>,
  );
});

businesses.post("/app/businesses/new", async (c) => {
  const user = userOf(c);
  const fields = await readFields(c);
  const parsed = await parseBusiness(fields, c.env, user.id);

  if (hasErrors(parsed.errors)) {
    const list = await listBusinessesForUser(c.env.DB, user.id);
    return c.html(
      <AppShell
      user={user}
        title="Add Business"
        active="businesses"
        businesses={list}
        notice={c.req.query("notice")}
        formIsland
      >
        <div class="page-narrow">
          <header class="page-head">
            <Breadcrumbs current="Add Business" />
            <h1 class="t-display-md">Add a business</h1>
            <p class="page-lede t-body text-secondary">{NEW_LEDE}</p>
          </header>
          <BusinessForm
            action="/app/businesses/new"
            uid="new"
            values={echoValues(fields)}
            errors={parsed.errors}
            submitLabel="Create Business"
            busyLabel="Creatingâ€¦"
          />
        </div>
      </AppShell>,
      422,
    );
  }

  try {
    await createBusiness(c.env.DB, user.id, parsed.patch);
  } catch (err) {
    console.error("[businesses] create failed:", err);
    return c.redirect(withFlash("/app/businesses", "business-save-failed"), 302);
  }

  // A brand-new account's first business becomes the active scope. Landing on
  // "All businesses" with exactly one business is the least useful possible
  // first screen.
  if ((await countBusinessesForUser(c.env.DB, user.id)) === 1) {
    const [first] = await listBusinessesForUser(c.env.DB, user.id, { status: "active" });
    if (first) await setCurrentBusiness(c.env.DB, user.id, first.id);
  }

  return c.redirect(withFlash("/app/businesses", "business-created"), 302);
});

// ---------------------------------------------------------------------------
// GET /app/businesses/:id
// ---------------------------------------------------------------------------

businesses.get("/app/businesses/:id", async (c) => {
  const user = userOf(c);
  // Membership-scoped read: someone else's business simply isn't found here.
  const business = await getBusinessForUser(c.env.DB, c.req.param("id"), user.id);
  if (!business) {
    return c.html(
      <AppShell
        user={user}
        title="Not found"
        active="businesses"
        notice={c.req.query("notice")}
      >
        <NotFound />
      </AppShell>,
      404,
    );
  }

  const [qrs, list] = await Promise.all([
    listQrByUserScoped(c.env.DB, user.id, business.id),
    listBusinessesForUser(c.env.DB, user.id),
  ]);

  const archived = business.status === "archived";
  const isCurrent = user.current_business_id === business.id;
  const currentName =
    list.find((b) => b.id === user.current_business_id)?.name ?? "All businesses";

  return c.html(
    <AppShell
      user={user}
      title={business.name}
      active="businesses"
      businesses={list}
      notice={c.req.query("notice")}
    >
      <div class="page-narrow">
        <header class="page-head">
          <Breadcrumbs current={business.name} />
          <div class="biz-hero">
            <Avatar size="lg" name={business.name} src={business.logo_key} />
            <div class="biz-hero-text">
              <h1 class="t-display-md">{business.name}</h1>
              <p class="biz-hero-meta t-body-sm text-secondary">
                {categoryLabel(business.category, business.custom_category)} ·{" "}
                {businessLocation(business)}
              </p>
              <div class="biz-hero-badges">
                {archived ? (
                  <Badge tone="warning" dot>
                    Archived
                  </Badge>
                ) : (
                  <Badge tone="success" dot>
                    Active
                  </Badge>
                )}
                {isCurrent ? <Badge tone="accent">Current business</Badge> : null}
                <Badge tone="neutral">
                  {business.qr_count} {business.qr_count === 1 ? "QR" : "QRs"}
                </Badge>
              </div>
            </div>
            <div class="biz-hero-actions">
              <Button
                href={`/app/businesses/${business.id}/edit`}
                iconLeft={<Icon name="settings" size={18} />}
              >
                Edit
              </Button>
            </div>
          </div>
        </header>

        {archived ? (
          <div class="notice notice-warning" role="note">
            <div class="notice-text">
              <p class="t-body-sm">
                This business is archived. It's hidden from active lists, but its
                QRs and scan history are preserved.
              </p>
            </div>
            <StatusForm id={business.id} status="active" label="Restore business" />
          </div>
        ) : !isCurrent ? (
          <div class="notice" role="note">
            <div class="notice-text">
              <p class="t-body-sm">
                Your dashboard is still scoped to {currentName}. Make this the
                current business to see its QRs there.
              </p>
            </div>
            <form method="post" action="/app/businesses/switch">
              <input type="hidden" name="business_id" value={business.id} />
              <input type="hidden" name="next" value="/app" />
              <button class="btn btn-secondary btn-sm" type="submit">
                <span class="btn-label">Make it current</span>
              </button>
            </form>
          </div>
        ) : null}

        <section class="biz-section" aria-labelledby="biz-qrs">
          <h2 class="biz-section-title t-body-sm text-secondary" id="biz-qrs">
            QR codes
          </h2>
          {qrs.length === 0 ? (
            <EmptyState
              icon="qr"
              title="No QRs connected yet"
              body="Claim a Sqanny QR to connect it to this business."
              // The claim flow is at /qrs/claim. This link used to point at
              // /app/claim, which matches the /app/:id QR-detail route and landed
              // the user on "QR code not found" — from the one screen whose whole
              // job is telling them what to do next.
              action={<EmptyStateButton href="/qrs/claim" label="Claim a QR" icon="qr" />}
              secondary={
                <EmptyStateButton
                  href="/app/new"
                  label="Create a QR"
                  icon="plus"
                  variant="secondary"
                />
              }
            />
          ) : (
            <div class="biz-list">
              {qrs.map((qr) => (
                <Card class="biz-qr-row">
                  <div class="biz-row-main">
                    <span class="qr-item-glyph" aria-hidden="true">
                      <Icon name={qr.registry_id ? "qr" : "link"} size={18} />
                    </span>
                    <div class="biz-row-body">
                      <h3 class="biz-row-title t-body">{qr.title}</h3>
                      <p class="biz-row-meta t-body-sm text-secondary">
                        {qr.registry_id ? "Sqanny Stand" : TYPE_LABEL[qr.type] ?? qr.type}
                        {qr.short_code ? ` · ${qr.short_code}` : ""}
                        {qr.destination_claimed_by ? " · claimed" : ""}
                      </p>
                    </div>
                  </div>
                  <div class="biz-row-actions">
                    {/* A stand is managed on its own screen, not in the studio —
                        see manageHref(). Two editors for one code is how a
                        destination ends up set in one place and nowhere else. */}
                    <Button href={manageHref(qr)} variant="secondary">
                      {qr.registry_id ? "Manage stand" : "View"}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>

        <BusinessFacts business={business} />
      </div>
    </AppShell>,
  );
});

// ---------------------------------------------------------------------------
// GET/POST /app/businesses/:id/edit
// ---------------------------------------------------------------------------

const EditPage: FC<{
  business: BusinessSummary;
  values: BusinessFormValues;
  errors: BusinessFormErrors;
}> = ({ business, values, errors }) => (
  <div class="page-narrow">
    <header class="page-head">
      <Breadcrumbs current={business.name} />
      <h1 class="t-display-md">Edit {business.name}</h1>
      <p class="page-lede t-body text-secondary">
        Update the details customers see on your hosted pages and QR codes.
      </p>
    </header>

    <BusinessForm
      action={`/app/businesses/${business.id}/edit`}
      uid="edit"
      values={values}
      errors={errors}
      submitLabel="Save Changes"
      busyLabel="Savingâ€¦"
    />

    <DangerZone business={business} />
  </div>
);

businesses.get("/app/businesses/:id/edit", async (c) => {
  const user = userOf(c);
  const business = await getBusinessForUser(c.env.DB, c.req.param("id"), user.id);
  if (!business) {
    return c.html(
      <AppShell
        user={user}
        title="Not found"
        active="businesses"
        notice={c.req.query("notice")}
      >
        <NotFound />
      </AppShell>,
      404,
    );
  }
  const list = await listBusinessesForUser(c.env.DB, user.id);
  return c.html(
    <AppShell
      user={user}
      title={`Edit ${business.name}`}
      active="businesses"
      businesses={list}
      notice={c.req.query("notice")}
      formIsland
    >
      <EditPage business={business} values={formValuesFrom(business)} errors={{}} />
    </AppShell>,
  );
});

businesses.post("/app/businesses/:id/edit", async (c) => {
  const user = userOf(c);
  const id = c.req.param("id");
  const business = await getBusinessForUser(c.env.DB, id, user.id);
  if (!business) {
    return c.html(
      <AppShell
        user={user}
        title="Not found"
        active="businesses"
        notice={c.req.query("notice")}
      >
        <NotFound />
      </AppShell>,
      404,
    );
  }

  const fields = await readFields(c);
  const parsed = await parseBusiness(fields, c.env, user.id);

  if (hasErrors(parsed.errors)) {
    const list = await listBusinessesForUser(c.env.DB, user.id);
    return c.html(
      <AppShell
        user={user}
        title={`Edit ${business.name}`}
        active="businesses"
        businesses={list}
        notice={c.req.query("notice")}
        formIsland
      >
        <EditPage
          business={business}
          values={{ ...echoValues(fields), logo_key: str(fields, "logo_key") || business.logo_key }}
          errors={parsed.errors}
        />
      </AppShell>,
      422,
    );
  }

  const ok = await updateBusinessForUser(c.env.DB, id, user.id, parsed.patch);
  if (!ok) {
    return c.redirect(withFlash("/app/businesses", "business-save-failed"), 302);
  }
  return c.redirect(withFlash(`/app/businesses/${id}`, "business-updated"), 302);
});

// ---------------------------------------------------------------------------
// POST /app/businesses/:id/status â€” archive / restore
// ---------------------------------------------------------------------------

/**
 * DangerZone â€” archive/restore, in a plain form rather than a modal.
 *
 * The whole form is one page, so a dialog that covered the form you just
 * submitted would be a worse experience than a clearly-marked section at the
 * bottom. Archive (not delete) is the only destructive-adjacent action offered,
 * and its copy says what is preserved.
 */
const DangerZone: FC<{ business: BusinessRow }> = ({ business }) => {
  const archived = business.status === "archived";
  return (
    <div class="danger-zone">
      <div class="danger-zone-text">
        <h2 class="danger-zone-title t-heading-sm">
          {archived ? "Restore this business" : "Archive this business"}
        </h2>
        <p class="danger-zone-note t-body-sm text-secondary">
          {archived
            ? "Restoring makes this business visible in your active lists again."
            : `Archiving hides ${business.name} from your active business lists. Its QR records and scan history are preserved, and you can restore it at any time.`}
        </p>
      </div>
      <StatusForm
        id={business.id}
        status={archived ? "active" : "archived"}
        label={archived ? "Restore Business" : "Archive Business"}
        danger={!archived}
      />
    </div>
  );
};

const StatusForm: FC<{
  id: string;
  status: "active" | "archived";
  label: string;
  danger?: boolean;
}> = ({ id, status, label, danger }) => (
  <form method="post" action={`/app/businesses/${id}/status`} data-guard-submit>
    <input type="hidden" name="status" value={status} />
    <button
      class={"btn btn-sm " + (danger ? "btn-secondary btn-danger" : "btn-secondary")}
      type="submit"
    >
      <span class="btn-label">{label}</span>
    </button>
  </form>
);

businesses.post("/app/businesses/:id/status", async (c) => {
  const user = userOf(c);
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const status = typeof body.status === "string" ? body.status : "";

  if (!isBusinessStatus(status)) {
    return c.redirect(withFlash("/app/businesses", "business-save-failed"), 302);
  }

  const ok = await setBusinessStatusForUser(c.env.DB, id, user.id, status);
  if (!ok) {
    return c.html(
      <AppShell
        user={user}
        title="Not found"
        active="businesses"
        notice={c.req.query("notice")}
      >
        <NotFound />
      </AppShell>,
      404,
    );
  }

  // Archiving the business you are currently looking at would leave the
  // dashboard scoped to something now hidden. Fall back to the wide view.
  if (status === "archived" && user.current_business_id === id) {
    await setCurrentBusiness(c.env.DB, user.id, null);
  }

  return c.redirect(
    withFlash(
      "/app/businesses",
      status === "archived" ? "business-archived" : "business-restored",
    ),
    302,
  );
});

// ---------------------------------------------------------------------------
// POST /app/businesses/switch â€” set the active business context
// ---------------------------------------------------------------------------

businesses.post("/app/businesses/switch", async (c) => {
  const user = userOf(c);
  const body = await c.req.parseBody();
  const requested =
    typeof body.business_id === "string" ? body.business_id.trim() : "";
  const nextPath = safeNext(typeof body.next === "string" ? body.next : "");

  // Empty means "All businesses" â€” a legitimate state, not an error.
  if (!requested) {
    await setCurrentBusiness(c.env.DB, user.id, null);
    return c.redirect(withFlash(nextPath || "/app", "business-switched"), 302);
  }

  // The id came from the request body, so re-verify membership here rather than
  // trusting the switcher's markup: a hand-rolled POST must not be able to set
  // somebody else's business as the active scope.
  const business = await getBusinessForUser(c.env.DB, requested, user.id);
  if (!business) {
    return c.redirect(withFlash("/app/businesses", "business-save-failed"), 302);
  }
  if (business.status !== "active") {
    // Don't scope to something the switcher won't list.
    return c.redirect(
      withFlash(`/app/businesses/${requested}`, "business-switched"),
      302,
    );
  }

  await setCurrentBusiness(c.env.DB, user.id, requested);
  return c.redirect(withFlash(nextPath || "/app", "business-switched"), 302);
});

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

const Breadcrumbs: FC<{ current: string }> = ({ current }) => (
  <nav class="breadcrumbs" aria-label="Breadcrumb">
    <a class="breadcrumb-link t-body-sm" href="/app/businesses">
      Businesses
    </a>
    <span class="breadcrumb-sep" aria-hidden="true">
      /
    </span>
    <span class="breadcrumb-current t-body-sm text-secondary" aria-current="page">
      {current}
    </span>
  </nav>
);
