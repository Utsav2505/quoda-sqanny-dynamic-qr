/**
 * Shared field validation + normalization.
 *
 * The SAME rules run on the client island (for inline feedback) and on the
 * server (as the actual gate). Client-side validation is a convenience; every
 * POST re-validates, because a form POST is just a public HTTP request.
 *
 * Conventions: validators return `null` when the value is acceptable, or a
 * human-readable message to show under the field. Normalizers are total — they
 * never throw, and they only reshape values that are already known-good.
 */

export const LIMITS = {
  name: 80,
  businessName: 120,
  customCategory: 60,
  address: 200,
  locality: 80,
  country: 60,
  phone: 24,
  email: 254,
  url: 500,
  description: 1000,
  city: 80,
} as const;

/** Trim, and cap at a maximum length so a hostile POST can't stuff a column. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Like cleanText but preserves newlines (addresses, descriptions). */
export function cleanMultiline(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** Empty string for "not provided" — the database stores NULL, not "". */
export function orNull(value: string): string | null {
  return value.length ? value : null;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive: one @, no spaces, a dotted domain. Over-validating
 * (RFC 5322) rejects addresses that genuinely deliver.
 */
export function isValidEmail(value: string): boolean {
  if (!value) return false;
  if (value.length > LIMITS.email) return false;
  return /^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

export function validateEmail(
  value: string,
  opts: { required?: boolean } = {},
): string | null {
  const v = value.trim();
  if (!v) return opts.required ? "Email is required." : null;
  if (!isValidEmail(v)) return "Enter a valid email address.";
  return null;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * Permissive by design: international numbers vary wildly in punctuation.
 * We reject letters and enforce a plausible digit count, nothing more.
 */
export function isValidPhone(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (v.length > LIMITS.phone) return false;
  if (!/^[+()\-.\s\d]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

export function validatePhone(
  value: string,
  opts: { required?: boolean } = {},
): string | null {
  const v = value.trim();
  if (!v) return opts.required ? "Phone number is required." : null;
  if (!isValidPhone(v)) {
    return "Enter a valid phone number (7–15 digits).";
  }
  return null;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Accept what people actually type and canonicalize it, so "abc.com" and
 * "https://abc.com/" store the same string. Anything with an unknown scheme is
 * rejected rather than silently coerced — a business's website should be a web
 * address, not "javascript:alert(1)".
 */
export function normalizeUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > LIMITS.url) return null;

  // Decide whether the input DECLARES a scheme before helping it out with one.
  // The obvious test - "is there a :// ?" - is not enough, because plenty of
  // hostile input has no :// and would otherwise be prefixed into a valid-looking
  // URL. "mailto:a@b.test" became "https://b.test": the userinfo became a host,
  // and an email address silently turned into a live destination pointing at
  // somebody else's domain.
  //
  // A colon only opens a scheme when it is not a port separator, so
  // "example.com:8080/x" stays a host:port rather than being read as a scheme.
  const declared = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(v);
  let withScheme: string;
  if (declared) {
    // It named a scheme, so it must be one we allow. This is the actual
    // allowlist; nothing else can become a redirect target.
    if (!/^https?$/i.test(declared[1])) return null;
    withScheme = v;
  } else {
    withScheme = `https://${v}`;
  }

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // A host is mandatory: "https:///path" parses with the path as the host.
  if (!u.hostname || !u.hostname.includes(".")) return null;
  // Credentials in a destination are never wanted and are a phishing shape.
  if (u.username || u.password) return null;
  // Drop a bare trailing slash on the origin only; keep real paths intact.
  return `${u.origin}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
}

export function validateUrl(
  value: string,
  opts: { required?: boolean; label?: string } = {},
): string | null {
  const label = opts.label ?? "This";
  const v = value.trim();
  if (!v) return opts.required ? `${label} is required.` : null;
  if (!normalizeUrl(v)) {
    return `${label} must be a valid web address (e.g. example.com).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Names & text
// ---------------------------------------------------------------------------

export function validateName(
  value: string,
  opts: { required?: boolean; label?: string; max?: number } = {},
): string | null {
  const label = opts.label ?? "Name";
  const max = opts.max ?? LIMITS.name;
  const v = value.trim();
  if (!v) return opts.required ? `${label} is required.` : null;
  if (v.length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}

export function validateMaxLength(
  value: string,
  max: number,
  label: string,
): string | null {
  return value.trim().length > max
    ? `${label} must be ${max} characters or fewer.`
    : null;
}

// ---------------------------------------------------------------------------
// Time (business hours)
// ---------------------------------------------------------------------------

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTime(value: string): boolean {
  return TIME_RE.test(value.trim());
}
