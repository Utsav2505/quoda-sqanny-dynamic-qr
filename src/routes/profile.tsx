import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { AppEnv, AppUser } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { AppShell } from "../ui/app-shell";
import { Card } from "../ui/components/card";
import { Button } from "../ui/components/button";
import { Badge } from "../ui/components/badge";
import { Icon } from "../ui/icons";
import { Avatar } from "../ui/components/avatar";
import { Input } from "../ui/components/input";
import { Progress, ProgressChecklist } from "../ui/components/progress";
import { ImagePicker } from "../ui/components/business-form";
import {
  listBusinessesForUser,
  updateUserProfile,
  type BusinessSummary,
  type UserProfilePatch,
} from "../db/queries";
import { computeCompleteness } from "../lib/profile";
import { withFlash } from "../lib/flash";
import { storeImage, ownsKey } from "./api/upload";
import {
  LIMITS,
  cleanText,
  orNull,
  validateName,
  validatePhone,
} from "../lib/validate";
import type { Bindings } from "../types";

export const profile = new Hono<AppEnv>();
profile.use("/app/*", requireAuth);

interface ProfileErrors {
  name?: string;
  phone?: string;
  avatar_key?: string;
}

interface ProfileValues {
  name: string;
  phone: string;
  avatar_key: string | null;
}

/**
 * Parse and validate the profile form.
 *
 * Email is deliberately absent: it is the login identity and is changed through
 * the magic-link flow, not a form field. A form that cannot change what it
 * shows is clearer than a disabled input.
 *
 * Returns the DB patch and the form values separately — the patch may hold nulls
 * (an empty phone clears the column), but a re-rendered form must show an empty
 * string, not "null".
 */
async function parseProfile(
  body: Record<string, unknown>,
  env: Bindings,
  userId: string,
): Promise<{ patch: UserProfilePatch; values: ProfileValues; errors: ProfileErrors }> {
  const errors: ProfileErrors = {};
  const str = (k: string): string => {
    const v = body[k];
    return typeof v === "string" ? v : "";
  };

  const name = cleanText(str("name"), LIMITS.name);
  const nameError = validateName(name, {
    required: true,
    label: "Name",
    max: LIMITS.name,
  });
  if (nameError) errors.name = nameError;

  const phone = cleanText(str("phone"), LIMITS.phone);
  const phoneError = validatePhone(phone);
  if (phoneError) errors.phone = phoneError;

  // Avatar: a key the island uploaded, or a file posted directly. An empty
  // string means "remove it" only when the form actually rendered a value to
  // remove — see below.
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
      // No new upload and no key came back. Every path to here means "no avatar":
      // the form rendered no value to remove, or the island cleared the hidden
      // field when the user pressed Remove. A no-JS form POST on an existing
      // avatar always carries the key, and was handled above — so this is
      // always a removal, and falling back to the current key would silently
      // undo the user's click.
      avatarKey = null;
    }
  }

  return {
    patch: { name, phone: orNull(phone), avatar_key: avatarKey },
    values: { name, phone, avatar_key: avatarKey },
    errors,
  };
}

interface BlobLike {
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

const ProfileForm: FC<{
  values: ProfileValues;
  errors: ProfileErrors;
}> = ({ values, errors }) => (
  <form
    class="profileform"
    method="post"
    action="/app/profile"
    enctype="multipart/form-data"
    data-dirty-guard
    data-guard-submit
  >
    <ImagePicker
      uid="profile"
      name="avatar_key"
      label="Profile photo"
      src={values.avatar_key}
      displayName={values.name || null}
      scope="avatar"
      error={errors.avatar_key}
    />

    <div class="form-grid">
      <Input
        id="profile-name"
        name="name"
        label="Name"
        placeholder="Alex Rivera"
        value={values.name}
        error={errors.name}
        required
        maxlength={LIMITS.name}
        data-validate="name"
        autocomplete="name"
      />
      <Input
        id="profile-phone"
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
        hint="Optional. Used for account recovery only."
      />
    </div>

    <p class="profileform-note t-body-sm text-secondary">
      Your email address is your login. To change it, sign out and sign in with
      the new address.
    </p>

    <div class="form-actions">
      <button
        class="btn btn-primary btn-lg"
        type="submit"
        data-busy-label="Saving…"
      >
        <span class="btn-label">Save Profile</span>
      </button>
    </div>
  </form>
);

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * The whole profile page, as one component.
 *
 * Extracted so the POST's validation branch renders the SAME page the GET does.
 * It used to re-render only `.profile-main`, silently dropping the completeness
 * meter, the business list and the account card — so a rejected save produced a
 * visibly different, emptier page, and the user lost the "what should I do next"
 * prompt at exactly the moment they most needed it.
 */
const ProfilePage: FC<{
  user: AppUser;
  values: ProfileValues;
  errors: ProfileErrors;
  businesses: BusinessSummary[];
  notice?: string | null;
}> = ({ user, values, errors, businesses, notice }) => {
  // Completeness looks at one business — the current one if there is one, else
  // the most recent. Picking arbitrarily would make the score jump around.
  const primary: BusinessSummary | null =
    businesses.find((b) => b.id === user.current_business_id) ??
    businesses.find((b) => b.status === "active") ??
    businesses[0] ??
    null;

  const completeness = computeCompleteness({
    name: user.name,
    phone: user.phone,
    businessCount: businesses.filter((b) => b.status === "active").length,
    primaryBusiness: primary,
  });

  return (
    <AppShell
      user={user}
      title="Profile"
      active="profile"
      businesses={businesses}
      notice={notice}
      formIsland
    >
      <div class="page-narrow">
        <header class="page-head">
          <h1 class="t-display-md">Your profile</h1>
          <p class="page-lede t-body text-secondary">
            How you appear across Sqanny. Visible to you and to customers of the
            businesses you manage.
          </p>
        </header>

        <div class="profile-grid">
          <div class="profile-main">
            <Card title="Personal details">
              <ProfileForm values={values} errors={errors} />
            </Card>
          </div>

          <aside class="profile-side" aria-labelledby="profile-completeness">
            <Card title="Profile strength" class="profile-score">
              <Progress
                value={completeness.percent}
                label="Profile completeness"
              />
              <ProgressChecklist
                items={completeness.checks.map((c) => ({
                  label: c.label,
                  done: c.done,
                }))}
              />
              {completeness.next ? (
                <Button
                  href={completeness.next.href}
                  block
                  iconLeft={<Icon name="plus" size={18} />}
                >
                  {completeness.next.action}
                </Button>
              ) : (
                <p class="profile-score-done t-body-sm text-secondary">
                  <Icon name="check" size={16} /> Your profile is complete.
                </p>
              )}
            </Card>

            <Card title="Businesses" class="profile-biz">
              {businesses.length === 0 ? (
                <div class="profile-biz-empty">
                  <p class="t-body-sm text-secondary">
                    You haven&rsquo;t created a business yet.
                  </p>
                  <Button href="/app/businesses/new" block>
                    Add Business
                  </Button>
                </div>
              ) : (
                <ul class="profile-biz-list">
                  {businesses
                    .filter((b) => b.status === "active")
                    .slice(0, 5)
                    .map((b) => (
                      <li>
                        <a class="profile-biz-item" href={`/app/businesses/${b.id}`}>
                          <Avatar size="sm" name={b.name} src={b.logo_key} />
                          <span class="profile-biz-body">
                            <span class="profile-biz-name t-body-sm">{b.name}</span>
                            <span class="profile-biz-meta t-caption text-tertiary">
                              {b.qr_count} {b.qr_count === 1 ? "QR" : "QRs"}
                            </span>
                          </span>
                          {b.id === user.current_business_id ? (
                            <Badge tone="accent">Current</Badge>
                          ) : null}
                        </a>
                      </li>
                    ))}
                </ul>
              )}
              <Button href="/app/businesses" variant="secondary" block>
                Manage Businesses
              </Button>
            </Card>

            <Card title="Account" class="profile-acct">
              <dl class="settings-defs">
                <div class="settings-def">
                  <dt class="settings-def-label t-body-sm text-secondary">
                    Email
                  </dt>
                  <dd class="settings-def-value t-body">{user.email}</dd>
                </div>
                <div class="settings-def">
                  <dt class="settings-def-label t-body-sm text-secondary">Plan</dt>
                  <dd class="settings-def-value t-body">
                    {user.plan_id.charAt(0).toUpperCase() + user.plan_id.slice(1)}
                  </dd>
                </div>
              </dl>
            </Card>
          </aside>
        </div>
      </div>
    </AppShell>
  );
};

// ---------------------------------------------------------------------------
// GET /app/profile
// ---------------------------------------------------------------------------

profile.get("/app/profile", async (c) => {
  const user = c.get("user")!;
  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  return c.html(
    <ProfilePage
      user={user}
      values={{
        name: user.name ?? "",
        phone: user.phone ?? "",
        avatar_key: user.avatar_key,
      }}
      errors={{}}
      businesses={businesses}
      notice={c.req.query("notice")}
    />,
  );
});

// ---------------------------------------------------------------------------
// POST /app/profile
// ---------------------------------------------------------------------------

profile.post("/app/profile", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) fields[k] = v;

  const parsed = await parseProfile(fields, c.env, user.id);
  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  if (Object.keys(parsed.errors).length > 0) {
    // Same page as the GET, with the user's values and the failing fields. The
    // nav, the switcher and the "next step" prompt all survive.
    return c.html(
      <ProfilePage
        user={user}
        values={parsed.values}
        errors={parsed.errors}
        businesses={businesses}
        notice={c.req.query("notice")}
      />,
      422,
    );
  }

  try {
    await updateUserProfile(c.env.DB, user.id, parsed.patch);
  } catch (err) {
    // A storage failure is not a validation failure. Pointing a field error at
    // something the user did not get wrong is a lie that costs them their
    // confidence in the form, so the values are echoed back with a save notice.
    console.error("[profile] save failed:", err);
    return c.html(
      <ProfilePage
        user={user}
        values={parsed.values}
        errors={{}}
        businesses={businesses}
        notice="profile-save-failed"
      />,
      500,
    );
  }

  return c.redirect(withFlash("/app/profile", "profile-updated"), 302);
});
