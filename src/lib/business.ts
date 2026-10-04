/**
 * Business taxonomy and status vocabulary.
 *
 * Categories are a CONTROLLED list, not free text, so business data stays
 * structured and reportable later. "other" is the escape hatch: when it is
 * picked, `custom_category` becomes the human label and is what every
 * consumer (cards, filters, exports) should display.
 */

export type BusinessCategory =
  | "restaurant"
  | "cafe"
  | "hotel"
  | "retail_store"
  | "grocery_store"
  | "salon_beauty"
  | "spa"
  | "gym_fitness"
  | "healthcare"
  | "education_institute"
  | "professional_services"
  | "automotive"
  | "real_estate"
  | "hospitality"
  | "entertainment"
  | "other";

export const BUSINESS_CATEGORIES: ReadonlyArray<{
  value: BusinessCategory;
  label: string;
}> = [
  { value: "restaurant", label: "Restaurant" },
  { value: "cafe", label: "Cafe" },
  { value: "hotel", label: "Hotel" },
  { value: "retail_store", label: "Retail Store" },
  { value: "grocery_store", label: "Grocery Store" },
  { value: "salon_beauty", label: "Salon / Beauty" },
  { value: "spa", label: "Spa" },
  { value: "gym_fitness", label: "Gym / Fitness" },
  { value: "healthcare", label: "Healthcare" },
  { value: "education_institute", label: "Education / Institute" },
  { value: "professional_services", label: "Professional Services" },
  { value: "automotive", label: "Automotive" },
  { value: "real_estate", label: "Real Estate" },
  { value: "hospitality", label: "Hospitality" },
  { value: "entertainment", label: "Entertainment" },
  { value: "other", label: "Other" },
];

const CATEGORY_VALUES: ReadonlySet<string> = new Set(
  BUSINESS_CATEGORIES.map((c) => c.value),
);

/** The category that requires a free-text companion field. */
export const OTHER_CATEGORY = "other";

export function isBusinessCategory(value: unknown): value is BusinessCategory {
  return typeof value === "string" && CATEGORY_VALUES.has(value);
}

/**
 * The label to show for a stored category. "other" resolves to the owner's
 * custom text so the UI never renders a bare "Other" once they have named it.
 */
export function categoryLabel(
  category: string,
  customCategory?: string | null,
): string {
  const custom = (customCategory ?? "").trim();
  if (category === OTHER_CATEGORY) return custom || "Other";
  return (
    BUSINESS_CATEGORIES.find((c) => c.value === category)?.label ?? "Other"
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type BusinessStatus = "active" | "archived";

export const BUSINESS_STATUSES: ReadonlyArray<{
  value: BusinessStatus;
  label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function isBusinessStatus(value: unknown): value is BusinessStatus {
  return value === "active" || value === "archived";
}

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

export const DAY_KEYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

export const DAY_LABELS: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** One day's hours. `closed` short-circuits open/close. */
export interface DayHours {
  open: string | null;
  close: string | null;
  closed: boolean;
}

export type BusinessHours = Partial<Record<DayKey, DayHours>>;

export const EMPTY_HOURS: BusinessHours = {};

/** Parse a stored hours_json blob, tolerating null/corrupt values. */
export function parseHours(json: string | null | undefined): BusinessHours {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: BusinessHours = {};
    for (const day of DAY_KEYS) {
      const raw = (parsed as Record<string, unknown>)[day];
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const time = (v: unknown): string | null =>
        typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
      out[day] = {
        open: time(r.open),
        close: time(r.close),
        closed: r.closed === true,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Drop days that carry no information so the stored blob stays small. */
export function serializeHours(hours: BusinessHours): string | null {
  const out: BusinessHours = {};
  for (const day of DAY_KEYS) {
    const d = hours[day];
    if (!d) continue;
    if (d.closed) {
      out[day] = { open: null, close: null, closed: true };
      continue;
    }
    if (d.open || d.close) {
      out[day] = { open: d.open ?? null, close: d.close ?? null, closed: false };
    }
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** A one-line "Open 9:00 AM – 9:00 PM · Mon–Sun" summary, or null when unset. */
export function summarizeHours(hours: BusinessHours): string | null {
  const parts: string[] = [];
  for (const day of DAY_KEYS) {
    const d = hours[day];
    if (!d) continue;
    parts.push(d.closed ? `${DAY_LABELS[day].slice(0, 3)} Closed` : `${DAY_LABELS[day].slice(0, 3)} ${d.open ?? "?"}–${d.close ?? "?"}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Public URL for an R2 object stored by POST /api/upload.
 *
 * Keys are stored (not full URLs) so a deployment behind a different APP_URL
 * keeps working. Keys are namespaced by the owner's user id at upload time.
 */
export function assetUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  return `/assets/${key}`;
}

/** "New Delhi", "Gurugram, Haryana", or "—" — the best available locality. */
export function businessLocation(b: {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}): string {
  const parts = [b.city, b.state, b.country].map((p) => (p ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : "—";
}
