import { Hono } from "hono";
import type { FC, PropsWithChildren } from "hono/jsx";
import { requireAuth, type AppEnv } from "../middleware/auth";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { Icon } from "../ui/icons";
import { Avatar } from "../ui/components/avatar";
import { Input } from "../ui/components/input";
import { ImagePicker, BusinessForm } from "../ui/components/business-form";
import {
  createBusiness,
  countBusinessesForUser,
  getUserById,
  listBusinessesForUser,
  setCurrentBusiness,
  setOnboarded,
  updateUserProfile,
  type BusinessSummary,
} from "../db/queries";
import { withFlash } from "../lib/flash";
import { storeImage, ownsKey } from "./api/upload";
import { businessLocation } from "../lib/business";
// The canonical business parser, imported rather than copied: onboarding and
// /app/businesses/new must never disagree about what a valid business is, and a
// second copy of these rules would drift the moment one of them changed.
import { parseBusiness, echoValues } from "./businesses";
import {
  LIMITS,
  cleanText,
  orNull,
  validateName,
  validatePhone,
} from "../lib/validate";
import type { Bindings } from "../types";

/**
 * Onboarding — four steps, each one a URL.
 *
 *   1. /onboarding            Welcome
 *   2. /onboarding/profile    Personal details
 *   3. /onboarding/business   A business, or later
 *   4. /onboarding/complete   Ready
 *
 * Two decisions make this a progressive flow rather than a wizard:
 *
 * The step lives in the URL, never in JavaScript state. Every step is a real GET
 * that renders on its own, and every "continue" is a plain form POST or a link.
 * With scripting blocked the flow still works end to end — the only thing lost
 * is inline validation and the upload preview.
 *
 * No step is required. Profile can be skipped, and "I'll do this later" on the
 * business step is a first-class button rather than a footnote link, because a
 * user who came here to make a QR should never be held at a form they didn't ask
 * for. Onboarding deliberately does not create a QR: the dashboard's own
 * "Create your first QR" empty state is the right place to start that, and it
 * explains the choice in context rather than guessing a type up front.
 */
export const onboarding = new Hono<AppEnv>();
onboarding.use("/onboarding/*", requireAuth);

const STEPS = [
  { path: "/onboarding", label: "Welcome" },
  { path: "/onboarding/profile", label: "Personal details" },
  { path: "/onboarding/business", label: "Business or later" },
  { path: "/onboarding/complete", label: "Complete" },
] as const;

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

/** Which step is the user on? Drives the stepper's current/done state. */
function stepIndex(path: string): number {
  const idx = STEPS.findIndex((s) => s.path === path);
  return idx === -1 ? 0 : idx;
}

const Stepper: FC<{ current: number }> = ({ current }) => (
  <ol class="ob-stepper" aria-label="Setup progress">
    {STEPS.map((s, i) => {
      const n = i + 1;
      return (
        <li
          class={
            "ob-step" +
            (n === current ? " ob-step-current" : n < current ? " ob-step-done" : "")
          }
          aria-current={n === current ? "step" : undefined}
        >
          <span class="ob-step-dot" aria-hidden="true">
            {n < current ? <Icon name="check" size={14} /> : n}
          </span>
          <span class="ob-step-label t-body-sm">{s.label}</span>
        </li>
      );
    })}
  </ol>
);

interface ShellProps {
  user: Parameters<typeof AppShell>[0]["user"];
  step: number;
  businesses?: BusinessSummary[];
  notice?: string;
}

/** Every step: the same shell, the same stepper, the same skip escape hatch. */
const Step: FC<PropsWithChildren<ShellProps>> = ({
  user,
  step,
  businesses,
  notice,
  children,
}) => (
  <AppShell
    user={user}
    title="Get started"
    active="new"
    businesses={businesses}
    notice={notice}
    formIsland
  >
    <div class="ob">
      <Stepper current={step} />
      {children}
    </div>
  </AppShell>
);

/**
 * "Skip for now" — completes setup without applying this step.
 *
 * A POST button, not a link. The previous version was `<a href="/onboarding/skip">`,
 * and marking a user as onboarded is a state change — which a GET should never
 * make. SameSite=Lax permits cross-site top-level GETs, so a hostile page could
 * silently complete (and thereby bypass) someone's onboarding.
 */
const SkipLink: FC<{ label?: string }> = ({ label = "Skip for now" }) => (
  <form method="post" action="/onboarding/skip" class="ob-skip-form">
    <button type="submit" class="ob-skip t-body-sm text-secondary">
      {label}
    </button>
  </form>
);

// ---------------------------------------------------------------------------
// Step 1 — Welcome
// ---------------------------------------------------------------------------

onboarding.get("/onboarding", (c) => {
  const user = c.get("user")!;
  return c.html(
    <Step user={user} step={1} notice={c.req.query("notice") ?? undefined}>
      <section class="ob-panel">
        <header class="ob-head">
          <h1 class="ob-title t-display-lg">Let’s set up your account.</h1>
          <p class="ob-lede t-body-lg text-secondary">
            Three short questions, and you can stop after any of them. Everything
            here can be changed later.
          </p>
        </header>

        <ul class="ob-promises">
          <li>
            <span class="ob-promise-glyph" aria-hidden="true">
              <Icon name="business" size={18} />
            </span>
            <span>
              <strong class="t-body">Add a profile</strong>
              <span class="t-body-sm text-secondary">
                {" "}
                — a name and photo, so your account is recognisably yours.
              </span>
            </span>
          </li>
          <li>
            <span class="ob-promise-glyph" aria-hidden="true">
              <Icon name="qr" size={18} />
            </span>
            <span>
              <strong class="t-body">Group codes by business</strong>
              <span class="t-body-sm text-secondary">
                {" "}
                — keep each location's QRs and scan history separate.
              </span>
            </span>
          </li>
          <li>
            <span class="ob-promise-glyph" aria-hidden="true">
              <Icon name="check" size={18} />
            </span>
            <span>
              <strong class="t-body">Then make your first QR</strong>
              <span class="t-body-sm text-secondary">{" "}
                — the dashboard takes it from there.
              </span>
            </span>
          </li>
        </ul>

        <footer class="ob-nav">
          <SkipLink />
          <div class="ob-nav-btns">
            <Button href="/onboarding/profile" iconLeft={<Icon name="plus" size={18} />}>
              Get started
            </Button>
          </div>
        </footer>
      </section>
    </Step>,
  );
});

// ---------------------------------------------------------------------------
// Step 2 — Personal details
// ---------------------------------------------------------------------------

interface DetailsErrors {
  name?: string;
  phone?: string;
  avatar_key?: string;
}

interface DetailsValues {
  name: string;
  phone: string;
  avatar_key: string | null;
}

const DetailsForm: FC<{
  values: DetailsValues;
  errors: DetailsErrors;
  submitLabel: string;
}> = ({ values, errors, submitLabel }) => (
  <form
    class="profileform ob-form"
    method="post"
    action="/onboarding/profile"
    enctype="multipart/form-data"
    data-dirty-guard
    data-guard-submit
  >
    <ImagePicker
      uid="ob"
      name="avatar_key"
      label="Profile photo"
      src={values.avatar_key}
      displayName={values.name}
      scope="avatar"
      error={errors.avatar_key}
    />

    <div class="form-grid">
      <Input
        id="ob-name"
        name="name"
        label="Your name"
        placeholder="Alex Rivera"
        value={values.name}
        error={errors.name}
        required
        maxlength={LIMITS.name}
        data-validate="name"
        autocomplete="name"
      />
      <Input
        id="ob-phone"
        name="phone"
        label="Phone"
        type="tel"
        placeholder="+1 555 0100"
        value={values.phone}
        error={errors.phone}
        maxlength={LIMITS.phone}
        inputmode="tel"
        data-validate="phone"
        autocomplete="tel"
      />
    </div>

    <p class="ob-hint t-body-sm text-secondary">
      Your email is already set — it's what you signed in with. Only your name
      and phone are asked for here.
    </p>

    <div class="form-actions">
      <Button type="submit" size="lg" data-busy-label="Saving…">
        {submitLabel}
      </Button>
      <Button href="/onboarding/business" variant="secondary" size="lg">
        Skip
      </Button>
    </div>
  </form>
);

const DetailsPage: FC<{
  user: Parameters<typeof AppShell>[0]["user"];
  values: DetailsValues;
  errors: DetailsErrors;
  submitLabel: string;
  notice?: string;
}> = ({ user, values, errors, submitLabel, notice }) => (
  <Step user={user} step={2} notice={notice}>
    <section class="ob-panel">
      <header class="ob-head">
        <h1 class="ob-panel-title t-heading-sm">What should we call you?</h1>
        <p class="ob-lede t-body text-secondary">
          Used on your account and on the pages of businesses you manage.
        </p>
      </header>

      <DetailsForm values={values} errors={errors} submitLabel={submitLabel} />
    </section>
  </Step>
);

/** Read the multipart profile form into the values to save, writing nothing. */
async function parseDetails(
  body: Record<string, unknown>,
  env: Bindings,
  userId: string,
): Promise<{ values: DetailsValues; errors: DetailsErrors }> {
  const errors: DetailsErrors = {};
  const str = (k: string): string => {
    const v = body[k];
    return typeof v === "string" ? v : "";
  };

  const name = cleanText(str("name"), LIMITS.name);
  const nameError = validateName(name, { required: true, label: "Name", max: LIMITS.name });
  if (nameError) errors.name = nameError;

  const phone = cleanText(str("phone"), LIMITS.phone);
  const phoneError = validatePhone(phone);
  if (phoneError) errors.phone = phoneError;

  const submittedKey = str("avatar_key").trim();
  let avatarKey: string | null = null;
  if (submittedKey) {
    if (ownsKey(submittedKey, userId, "avatar")) avatarKey = submittedKey;
    else errors.avatar_key = "That image could not be used. Try another.";
  }
  if (!avatarKey) {
    const file = body.avatar_key_file;
    if (file && typeof file !== "string" && typeof (file as BlobLike).arrayBuffer === "function") {
      const blob = file as BlobLike;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const stored = await storeImage(env, userId, "avatar", bytes, blob.type || "");
      if (stored.ok) avatarKey = stored.key;
      else errors.avatar_key = stored.error;
    } else {
      // No file and no key: either there was nothing to remove, or the user
      // pressed Remove. A no-JS form on an existing photo posts the key back, so
      // there is no third case, and falling back to `current` would silently
      // undo the removal.
      avatarKey = null;
    }
  }

  return { values: { name, phone, avatar_key: avatarKey }, errors };
}

interface BlobLike {
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

onboarding.get("/onboarding/profile", async (c) => {
  const user = c.get("user")!;
  return c.html(
    <DetailsPage
      user={user}
      values={{ name: user.name ?? "", phone: user.phone ?? "", avatar_key: user.avatar_key }}
      errors={{}}
      submitLabel="Continue"
      notice={c.req.query("notice") ?? undefined}
    />,
  );
});

onboarding.post("/onboarding/profile", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const current: DetailsValues = {
    name: user.name ?? "",
    phone: user.phone ?? "",
    avatar_key: user.avatar_key,
  };
  const { values, errors } = await parseDetails(body, c.env, user.id);

  if (Object.keys(errors).length) {
    return c.html(
      <DetailsPage
        user={user}
        values={values}
        errors={errors}
        submitLabel="Continue"
      />,
      422,
    );
  }

  try {
    await updateUserProfile(c.env.DB, user.id, {
      name: values.name,
      phone: orNull(values.phone),
      avatar_key: values.avatar_key,
    });
  } catch (err) {
    console.error("[onboarding] profile save failed:", err);
    return c.html(
      <DetailsPage
        user={user}
        values={current}
        errors={{ name: "Couldn't save your details. Please try again." }}
        submitLabel="Continue"
      />,
      500,
    );
  }

  return c.redirect("/onboarding/business", 302);
});

// ---------------------------------------------------------------------------
// Step 3 — A business, or later
// ---------------------------------------------------------------------------

/**
 * Reuses BusinessForm verbatim rather than a reduced variant, so what someone
 * enters here is exactly what they'd get from /app/businesses/new — one form, one
 * set of rules, and the six required fields are the same six.
 */
const BusinessPage: FC<{
  user: Parameters<typeof AppShell>[0]["user"];
  values: Parameters<typeof BusinessForm>[0]["values"];
  errors: Parameters<typeof BusinessForm>[0]["errors"];
  businesses: BusinessSummary[];
  submitLabel: string;
  notice?: string;
}> = ({ user, values, errors, businesses, submitLabel, notice }) => (
  <Step user={user} step={3} businesses={businesses} notice={notice}>
    <section class="ob-panel">
        <header class="ob-head">
          <h1 class="ob-panel-title t-heading-sm">Add a business, or come back later.</h1>
          <p class="ob-lede t-body text-secondary">
            A business keeps each location&apos;s QRs, contact details and scan
            history separate. Everything except the essentials is optional, and
            you can change any of this later.
          </p>
        </header>

      <BusinessForm
        action="/onboarding/business"
        uid="ob-biz"
        values={values}
        errors={errors}
        submitLabel={submitLabel}
        busyLabel="Creating…"
        footer={
          // A first-class skip, not a footnote: someone here to make a QR should
          // not be blocked by a form they didn't ask for.
          //
          // `formaction` rather than a nested <form>: BusinessForm already wraps
          // its footer in a <form>, and a form inside a form is invalid markup
          // that browsers silently drop. Overriding the submission target is
          // native HTML5, so this still works with scripting disabled.
          <button
            type="submit"
            class="btn btn-ghost btn-lg"
            formaction="/onboarding/complete"
            formmethod="post"
          >
            <span class="btn-label">I&apos;ll do this later</span>
          </button>
        }
      />
    </section>
  </Step>
);

onboarding.get("/onboarding/business", async (c) => {
  const user = c.get("user")!;
  const businesses = await listBusinessesForUser(c.env.DB, user.id);
  return c.html(
    <BusinessPage
      user={user}
      values={{ category: "cafe" }}
      errors={{}}
      businesses={businesses}
      submitLabel="Create Business"
      notice={c.req.query("notice") ?? undefined}
    />,
  );
});

onboarding.post("/onboarding/business", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const parsed = await parseBusiness(body, c.env, user.id);
  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  if (Object.keys(parsed.errors).length) {
    return c.html(
      <BusinessPage
        user={user}
        values={echoValues(body)}
        errors={parsed.errors}
        businesses={businesses}
        submitLabel="Create Business"
      />,
      422,
    );
  }

  try {
    await createBusiness(c.env.DB, user.id, parsed.patch);
  } catch (err) {
    console.error("[onboarding] business create failed:", err);
    return c.redirect(withFlash("/onboarding/business", "business-save-failed"), 302);
  }

  // The business they just made is the one they are here to set up, so it
  // becomes the active scope rather than leaving them on "All businesses".
  if ((await countBusinessesForUser(c.env.DB, user.id)) === 1) {
    const [first] = await listBusinessesForUser(c.env.DB, user.id, { status: "active" });
    if (first) await setCurrentBusiness(c.env.DB, user.id, first.id);
  }

  return c.redirect("/onboarding/complete", 302);
});

// ---------------------------------------------------------------------------
// Step 4 — Ready
// ---------------------------------------------------------------------------

onboarding.get("/onboarding/complete", async (c) => {
  const user = c.get("user")!;
  // Read fresh: the name and avatar were just written by step 2, and a business
  // may have just been created in step 3.
  const fresh = (await getUserById(c.env.DB, user.id)) ?? user;
  const businesses = await listBusinessesForUser(c.env.DB, fresh.id, { status: "active" });
  const displayName = (fresh.name ?? "").trim() || fresh.email;

  return c.html(
    <Step user={fresh} step={4} businesses={businesses} notice={c.req.query("notice") ?? undefined}>
      <section class="ob-panel">
        <header class="ob-head">
          <span class="ob-done-glyph" aria-hidden="true">
            <Icon name="check" size={28} />
          </span>
          <h1 class="ob-title t-display-lg">You&apos;re set, {displayName}.</h1>
          <p class="ob-lede t-body-lg text-secondary">
            {businesses.length
              ? "Your account is ready. Here’s what you’ve set up."
              : "Your account is ready. You can add a business whenever you like."}
          </p>
        </header>

        <ul class="ob-recap">
          <li class="ob-recap-row">
            <span class="ob-recap-glyph" aria-hidden="true">
              <Icon name="business" size={18} />
            </span>
            <span class="ob-recap-body">
              <span class="ob-recap-label t-body-sm text-secondary">Profile</span>
              <span class="ob-recap-value t-body">
                {(fresh.name ?? "").trim() ? fresh.name : "Not set yet"}
              </span>
            </span>
            <a class="ob-recap-link t-body-sm" href="/app/profile">
              Edit
            </a>
          </li>

          <li class="ob-recap-row">
            <span class="ob-recap-glyph" aria-hidden="true">
              <Icon name="qr" size={18} />
            </span>
            <span class="ob-recap-body">
              <span class="ob-recap-label t-body-sm text-secondary">Business</span>
              {businesses.length ? (
                <span class="ob-recap-value t-body">
                  <Avatar size="sm" name={businesses[0].name} src={businesses[0].logo_key} />{" "}
                  {businesses[0].name}
                  <span class="text-secondary"> · {businessLocation(businesses[0])}</span>
                </span>
              ) : (
                <span class="ob-recap-value t-body text-secondary">None yet</span>
              )}
            </span>
            <a class="ob-recap-link t-body-sm" href="/app/businesses">
              {businesses.length ? "Manage" : "Add"}
            </a>
          </li>
        </ul>

        {/* No "skip" here: this is the last step, so finishing and skipping are
            the same action. One control, no false choice. */}
        <footer class="ob-nav">
          <div class="ob-nav-btns">
            <form method="post" action="/onboarding/complete">
              <Button type="submit" size="lg" data-busy-label="Finishing…">
                Go to dashboard
              </Button>
            </form>
          </div>
        </footer>
      </section>
    </Step>,
  );
});

/**
 * Finish setup. Deliberately creates no QR: the dashboard's empty state owns
 * that decision, and it can explain the trade-off (dynamic vs static) in a
 * context where the user has room to read it. Landing there with zero QRs is
 * the expected outcome of a fresh account, not a broken state.
 */
onboarding.post("/onboarding/complete", async (c) => {
  const user = c.get("user")!;
  try {
    await setOnboarded(c.env.DB, user.id, Date.now());
  } catch (err) {
    console.error("[onboarding] complete failed:", err);
    return c.redirect("/onboarding", 302);
  }
  return c.redirect(withFlash("/app", "onboarding-complete"), 302);
});

// ---------------------------------------------------------------------------
// POST /onboarding/skip — mark onboarded and go to the dashboard.
// ---------------------------------------------------------------------------

/**
 * A POST, because marking onboarding finished is a state change and a GET must
 * never make one. The GET below exists only so a bookmarked or already-open link
 * still resolves — it shows the confirmation rather than acting on it.
 */
onboarding.post("/onboarding/skip", async (c) => {
  const user = c.get("user")!;
  try {
    await setOnboarded(c.env.DB, user.id, Date.now());
  } catch (err) {
    console.error("[onboarding] skip failed:", err);
  }
  return c.redirect("/app", 302);
});

onboarding.get("/onboarding/skip", async (c) => {
  const user = c.get("user")!;
  return c.html(
    <Step user={user} step={1}>
      <section class="ob-panel">
        <header class="ob-head">
          <h1 class="ob-title t-display-lg">Skip the rest of setup?</h1>
          <p class="ob-lede t-body text-secondary">
            This finishes setup without adding a business. You can add one
            whenever you like, and nothing you&rsquo;ve already entered is lost.
          </p>
        </header>
        <footer class="ob-nav">
          <div class="ob-nav-btns">
            <form method="post" action="/onboarding/skip">
              <Button type="submit" size="lg" data-busy-label="Finishing…">
                Yes, skip for now
              </Button>
            </form>
            <Button href="/onboarding" variant="secondary" size="lg">
              Keep setting up
            </Button>
          </div>
        </footer>
      </section>
    </Step>,
  );
});
