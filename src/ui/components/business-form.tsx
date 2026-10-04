import type { FC, Child } from "hono/jsx";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";
import { Icon } from "../icons";
import {
  BUSINESS_CATEGORIES,
  OTHER_CATEGORY,
  DAY_KEYS,
  DAY_LABELS,
  type BusinessHours,
  type DayKey,
} from "../../lib/business";
import { LIMITS } from "../../lib/validate";

export interface BusinessFormValues {
  name?: string;
  category?: string;
  custom_category?: string | null;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  phone?: string;
  email?: string;
  website?: string;
  google_business_url?: string;
  instagram_url?: string;
  facebook_url?: string;
  description?: string;
  logo_key?: string | null;
  hours?: BusinessHours;
}

export interface BusinessFormErrors {
  [field: string]: string;
}

const CATEGORY_OPTIONS = [
  ...BUSINESS_CATEGORIES.map((c) => ({ value: c.value, label: c.label })),
];

const val = (v: string | undefined | null): string => v ?? "";

/**
 * BusinessForm — the create/edit business form, shared by /app/businesses/new
 * and /app/businesses/:id/edit so both surfaces can never drift.
 *
 * Fields are grouped into named sections (Basics / Location / Contact /
 * Presence / About) rather than one long column, so a large form still reads as
 * a short list of understandable questions. Six fields are required — name,
 * category, and the full postal address — because a business without a location
 * is not a place a customer can visit. Everything else is optional and marked as
 * such.
 */
export const BusinessForm: FC<{
  action: string;
  values: BusinessFormValues;
  errors: BusinessFormErrors;
  /** id prefix so two forms on one page (e.g. new + edit) don't collide */
  uid: string;
  submitLabel: string;
  busyLabel?: string;
  /** optional trailing slot under the actions (e.g. an Archive control) */
  footer?: Child;
  /**
   * Hidden fields carried through the submission.
   *
   * Callers that submit this form from inside a larger flow (the QR claim
   * wizard, for instance) need to post along a serial. The obvious fix — a
   * wrapping <form> — produces nested forms, which browsers silently drop, so
   * the hidden field never arrives. This slot puts the extra inputs inside the
   * one real form instead.
   */
  hidden?: Child;
  /** label for the cancel link; override when the back path is not the list */
  cancelHref?: string;
  cancelLabel?: string;
}> = ({
  action,
  values,
  errors,
  uid,
  submitLabel,
  busyLabel,
  footer,
  hidden,
  cancelHref,
  cancelLabel,
}) => {
  const hours = values.hours ?? {};
  const id = (field: string) => `${uid}-${field}`;

  return (
    <form
      class="bizform"
      method="post"
      action={action}
      enctype="multipart/form-data"
      data-dirty-guard
      data-guard-submit
    >
      {hidden}
      {/* ------------------------------------------------------------ Basics */}
      <section class="form-section">
        <div class="form-section-head">
          <h2 class="form-section-title t-heading-sm">Basics</h2>
          <p class="form-section-note t-body-sm text-secondary">
            What customers will recognise this business as.
          </p>
        </div>

        <div class="form-grid">
          <Input
            id={id("name")}
            name="name"
            label="Business Name"
            placeholder="ABC Cafe"
            value={val(values.name)}
            error={errors.name}
            required
            maxlength={LIMITS.businessName}
            data-validate="businessName"
            autocomplete="organization"
          />

          <Select
            id={id("category")}
            name="category"
            label="Business Category"
            value={val(values.category) || "cafe"}
            options={CATEGORY_OPTIONS}
            error={errors.category}
            required
            data-category-select=""
            data-when-source=""
          />

          {/* Revealed only for category = other. Server renders it un-hidden so
              a no-JS reload of a saved "other" business still shows the field. */}
          <div
            class="form-conditional"
            data-custom-category=""
            hidden={val(values.category) !== OTHER_CATEGORY}
          >
            <Input
              id={id("custom_category")}
              name="custom_category"
              label="Custom Category"
              placeholder="e.g. Coworking space"
              value={val(values.custom_category)}
              error={errors.custom_category}
              maxlength={LIMITS.customCategory}
              data-validate="customCategory"
              data-when="category=other"
              autocomplete="off"
            />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- Location */}
      <section class="form-section">
        <div class="form-section-head">
          <h2 class="form-section-title t-heading-sm">Location</h2>
          <p class="form-section-note t-body-sm text-secondary">
            Where customers can find you. Used to group QRs by site.
          </p>
        </div>

        <Input
          id={id("address")}
          name="address"
          label="Address"
          placeholder="12, Connaught Place"
          value={val(values.address)}
          error={errors.address}
          required
          maxlength={LIMITS.address}
          data-validate="required"
          autocomplete="street-address"
        />

        <div class="form-grid form-grid-3">
          <Input
            id={id("city")}
            name="city"
            label="City"
            placeholder="New Delhi"
            value={val(values.city)}
            error={errors.city}
            required
            maxlength={LIMITS.city}
            data-validate="required"
            autocomplete="address-level2"
          />
          <Input
            id={id("state")}
            name="state"
            label="State"
            placeholder="Delhi"
            value={val(values.state)}
            error={errors.state}
            required
            maxlength={LIMITS.locality}
            data-validate="required"
            autocomplete="address-level1"
          />
          <Input
            id={id("country")}
            name="country"
            label="Country"
            placeholder="India"
            value={val(values.country)}
            error={errors.country}
            required
            maxlength={LIMITS.country}
            data-validate="required"
            autocomplete="country-name"
          />
        </div>
      </section>

      {/* ----------------------------------------------------------- Contact */}
      <section class="form-section">
        <div class="form-section-head">
          <h2 class="form-section-title t-heading-sm">Contact</h2>
          <p class="form-section-note t-body-sm text-secondary">
            Optional. Separate from your own account details.
          </p>
        </div>

        <div class="form-grid">
          <Input
            id={id("phone")}
            name="phone"
            label="Business Phone"
            type="tel"
            placeholder="+91 98100 00000"
            value={val(values.phone)}
            error={errors.phone}
            maxlength={LIMITS.phone}
            inputmode="tel"
            data-validate="phone"
            autocomplete="tel"
          />
          <Input
            id={id("email")}
            name="email"
            label="Business Email"
            type="email"
            placeholder="hello@abccafe.com"
            value={val(values.email)}
            error={errors.email}
            maxlength={LIMITS.email}
            inputmode="email"
            data-validate="email"
            autocomplete="email"
          />
        </div>
      </section>

      {/* ---------------------------------------------------------- Presence */}
      <section class="form-section">
        <div class="form-section-head">
          <h2 class="form-section-title t-heading-sm">Online presence</h2>
          <p class="form-section-note t-body-sm text-secondary">
            Optional. We normalise these so "abc.com" and "https://abc.com" are
            stored the same way.
          </p>
        </div>

        <div class="form-grid">
          <Input
            id={id("website")}
            name="website"
            label="Website"
            type="url"
            placeholder="abccafe.com"
            value={val(values.website)}
            error={errors.website}
            maxlength={LIMITS.url}
            inputmode="url"
            data-validate="url"
            autocomplete="url"
          />
          <Input
            id={id("google_business_url")}
            name="google_business_url"
            label="Google Business Profile URL"
            type="url"
            placeholder="https://g.page/abc-cafe"
            value={val(values.google_business_url)}
            error={errors.google_business_url}
            maxlength={LIMITS.url}
            inputmode="url"
            data-validate="url"
            autocomplete="off"
          />
          <Input
            id={id("instagram_url")}
            name="instagram_url"
            label="Instagram URL"
            type="url"
            placeholder="https://instagram.com/abccafe"
            value={val(values.instagram_url)}
            error={errors.instagram_url}
            maxlength={LIMITS.url}
            inputmode="url"
            data-validate="url"
            autocomplete="off"
          />
          <Input
            id={id("facebook_url")}
            name="facebook_url"
            label="Facebook URL"
            type="url"
            placeholder="https://facebook.com/abccafe"
            value={val(values.facebook_url)}
            error={errors.facebook_url}
            maxlength={LIMITS.url}
            inputmode="url"
            data-validate="url"
            autocomplete="off"
          />
        </div>
      </section>

      {/* -------------------------------------------------------------- Logo */}
      <section class="form-section">
        <div class="form-section-head">
          <h2 class="form-section-title t-heading-sm">Logo</h2>
          <p class="form-section-note t-body-sm text-secondary">
            Optional. PNG, JPG, WebP, GIF or SVG, up to 1MB.
          </p>
        </div>

        <ImagePicker
          uid={id("logo")}
          name="logo_key"
          label="Business Logo"
          src={values.logo_key ?? null}
          displayName={values.name ?? null}
          scope="logo"
          error={errors.logo_key}
        />
      </section>

      {/* ------------------------------------------------------------- Hours */}
      <section class="form-section">
        <div class="form-section-head">
          <h2 class="form-section-title t-heading-sm">Business hours</h2>
          <p class="form-section-note t-body-sm text-secondary">
            Optional. Leave a day empty to hide it entirely.
          </p>
        </div>

        <div class="hours">
          {DAY_KEYS.map((day: DayKey) => {
            const d = hours[day] ?? { open: null, close: null, closed: false };
            const closed = d.closed === true;
            return (
              <div
                class={"hours-row" + (closed ? " hours-closed" : "")}
                data-hours-row
              >
                <label class="hours-day" for={`${uid}-hours-${day}-closed`}>
                  <input
                    class="hours-toggle"
                    type="checkbox"
                    id={`${uid}-hours-${day}-closed`}
                    name={`hours_${day}_closed`}
                    value="1"
                    checked={closed}
                    data-hours-closed=""
                  />
                  <span class="t-body-sm">{DAY_LABELS[day]}</span>
                </label>
                <div class="hours-times">
                  <input
                    class="input hours-time"
                    type="time"
                    name={`hours_${day}_open`}
                    value={d.open ?? ""}
                    aria-label={`${DAY_LABELS[day]} opening time`}
                    readOnly={closed}
                  />
                  <span class="hours-dash" aria-hidden="true">
                    –
                  </span>
                  <input
                    class="input hours-time"
                    type="time"
                    name={`hours_${day}_close`}
                    value={d.close ?? ""}
                    aria-label={`${DAY_LABELS[day]} closing time`}
                    readOnly={closed}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------------------- About */}
      <section class="form-section">
        <div class="form-section-head">
          <h2 class="form-section-title t-heading-sm">About</h2>
          <p class="form-section-note t-body-sm text-secondary">
            Optional. A sentence or two about what you do.
          </p>
        </div>

        <Textarea
          id={id("description")}
          name="description"
          label="Description"
          rows={4}
          placeholder="Neighbourhood cafe serving single-origin coffee, open from 7am."
          value={val(values.description)}
          error={errors.description}
          maxlength={LIMITS.description}
          data-validate="description"
        />
      </section>

      <div class="form-actions">
        <button
          class="btn btn-primary btn-lg"
          type="submit"
          data-busy-label={busyLabel ?? "Saving…"}
        >
          <span class="btn-label">{submitLabel}</span>
        </button>
        <a class="btn btn-secondary btn-lg" href={cancelHref ?? "/app/businesses"}>
          {cancelLabel ?? "Cancel"}
        </a>
        {footer}
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// Image picker
// ---------------------------------------------------------------------------

/**
 * ImagePicker — upload / preview / remove for the avatar and business logo.
 *
 * The <input type="file"> posts straight into the form (multipart), so the whole
 * thing works with no JavaScript at all. The island adds the instant preview and
 * uploads to R2 up front, filling a hidden `*_key` field; when JS is absent the
 * server reads the file from the multipart body instead. Either way exactly one
 * key reaches the database.
 */
export const ImagePicker: FC<{
  uid: string;
  name: string;
  label: string;
  src: string | null;
  displayName: string | null;
  /** R2 key namespace; must match what the server expects for this field */
  scope: "avatar" | "logo";
  error?: string;
}> = ({ uid, name, label, src, displayName, scope, error }) => {
  const initials = initialsFor(displayName);
  const fileId = `${uid}-${name}-file`;
  const errId = `${uid}-${name}-error`;
  return (
    <div
      class="picker"
      data-picker
      data-picker-scope={scope}
      data-picker-src={src ?? ""}
    >
      {/* The island finds the stage through the root, so `data-picker` has to
          live on the outer element, not here — the root is what contains the
          file input, the hidden key, the remove button and the status line. */}
      <div
        class="picker-stage"
        data-picker-stage
        data-picker-initials={initials}
      >
        {src ? <img class="picker-preview-img" src={`/assets/${src}`} alt="" /> : initials}
      </div>
      <div class="picker-controls">
        <input type="hidden" name={name} value={src ?? ""} data-picker-key />
        <label class="picker-file btn btn-secondary" for={fileId}>
          <span class="btn-icon" aria-hidden="true">
            <Icon name="plus" size={18} />
          </span>
          <span class="btn-label">{src ? "Replace image" : "Upload image"}</span>
        </label>
        <input
          class="picker-input"
          type="file"
          id={fileId}
          name={`${name}_file`}
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          aria-label={label}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errId : undefined}
        />
        <button type="button" class="btn btn-ghost" data-picker-remove hidden={!src}>
          <span class="btn-label">Remove</span>
        </button>
        <p class="picker-status t-caption" data-picker-status role="status" />
      </div>
      {error ? (
        <p class="field-error" id={errId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};

function initialsFor(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
