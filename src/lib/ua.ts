/**
 * User-Agent parsing for scan analytics.
 *
 * Pure and synchronous: no I/O, no globals, no side effects. This runs inside
 * the redirect's `ctx.waitUntil`, but keeping it pure means it is trivially
 * unit-testable and can never slow the hot path.
 *
 * The parser is an ORDERED TABLE, not a chain of conditionals. Order is the
 * whole design: every engine also claims to be some other engine's UA
 * substring, so the first match wins.
 *   - `Edg/` must beat `Chrome/` (Edge is Chromium but is not Chrome).
 *   - `Chrome OS`/`CrOS` must beat `Linux` (it is Linux, but not "Linux").
 *   - `Windows Phone` must beat `Windows`.
 *   - `Version/x Safari/` must beat the bare `Safari/` fallback, because every
 *     Chromium/WebKit browser ships a `Safari/` token.
 *
 * KNOWN LIMIT — iPadOS 13+ in desktop mode sends a UA indistinguishable from a
 * real Mac (`Macintosh; Intel Mac OS X 10_15 ... Safari/605.1.15`). No
 * server-side parser can tell them apart because the strings are identical.
 * The client-side enrichment pass corrects this via `maxTouchPoints`.
 */

export type DeviceType = "mobile" | "tablet" | "desktop";

export interface ParsedUA {
  device: DeviceType;
  os: string;
  osVersion: string | null;
  browser: string;
  browserVersion: string | null;
}

interface Rule {
  re: RegExp;
  name: string;
}

/**
 * Browser rules, most specific first. Capturing group 1 is the version.
 */
const BROWSER_RULES: readonly Rule[] = [
  // Chromium Edge, plus the legacy EdgeHTML and the per-platform tokens. One
  // rule covers `Edg/`, `Edge/`, `EdgA/` (Android) and `EdgiOS/` (iOS): the
  // trailing letters are all optional.
  { re: /Edge?A?i?O?S?\/([\d.]+)/, name: "Edge" },
  // Opera (Chromium `OPR/`, legacy Presto `Opera/`).
  { re: /OPR\/([\d.]+)/, name: "Opera" },
  { re: /Opera[\s/]([\d.]+)/, name: "Opera" },
  // Samsung Internet ships a `Safari/` token too, so it must precede Safari.
  { re: /SamsungBrowser\/([\d.]+)/, name: "Samsung Internet" },
  // Firefox desktop + iOS (`FxiOS`).
  { re: /(?:Firefox|FxiOS)\/([\d.]+)/, name: "Firefox" },
  // Chrome desktop + iOS (`CriOS`).
  { re: /(?:Chrome|CriOS|Chromium)\/([\d.]+)/, name: "Chrome" },
  // Real Safari is the only engine that sends a `Version/` token alongside
  // `Safari/`. Require it so Chromium's copy of `Safari/` cannot match here.
  { re: /Version\/([\d.]+).*Safari\//, name: "Safari" },
  { re: /Safari\/([\d.]+)/, name: "Safari" },
  // Legacy engines, last.
  { re: /MSIE ([\d.]+)/, name: "Internet Explorer" },
  { re: /Trident\/.*rv:([\d.]+)/, name: "Internet Explorer" },
];

/**
 * OS rules, most specific first. Capturing group 1 is the version.
 */
const OS_RULES: readonly Rule[] = [
  // Windows Phone must precede Windows — its UA contains "Windows".
  { re: /Windows Phone (?:OS )?([\d.]+)/, name: "Windows Phone" },
  // iOS family. iPadOS is reported as its own "OS" name because a 10" iPad is
  // not a desktop for scan-analytics purposes.
  { re: /iPhone OS ([\d_]+)/, name: "iOS" },
  { re: /iPad(?:; CPU)? OS ([\d_]+)/, name: "iPadOS" },
  { re: /iPod.*OS ([\d_]+)/, name: "iOS" },
  { re: /iPhone/, name: "iOS" },
  { re: /iPad/, name: "iPadOS" },
  // Android tablets omit "Mobile", which is the device signal — but the OS is
  // still Android, so this sits above the CrOS/Linux rules.
  { re: /Android ([\d.]+)/, name: "Android" },
  { re: /Android/, name: "Android" },
  // Chrome OS is Linux under the hood; check it before the Linux rule.
  { re: /CrOS \S+ ([\d.]+)/, name: "Chrome OS" },
  { re: /CrOS/, name: "Chrome OS" },
  { re: /Windows NT ([\d.]+)/, name: "Windows" },
  { re: /Windows/, name: "Windows" },
  { re: /Mac OS X ([\d_.]+)/, name: "macOS" },
  { re: /Macintosh/, name: "macOS" },
  { re: /Linux|X11/, name: "Linux" },
];

/** First matching rule wins; `null` when nothing matches. */
function firstMatch(rules: readonly Rule[], s: string): Rule | null {
  for (const rule of rules) {
    if (rule.re.test(s)) return rule;
  }
  return null;
}

/** iOS reports versions as `17_0_1`; normalise to `17.0.1`. */
function normaliseVersion(v: string | undefined): string | null {
  if (!v) return null;
  const out = v.replace(/_/g, ".").replace(/\.+$/, "");
  return out.length ? out.slice(0, 32) : null;
}

/**
 * Coarse device bucket.
 *
 * Tablets are checked first: iPads and Android tablets also match the "mobile"
 * heuristics, so testing mobile first would misclassify every tablet as a phone.
 */
export function deviceFromUA(ua: string | null | undefined): DeviceType {
  if (!ua) return "desktop";
  const s = ua.toLowerCase();
  if (
    /ipad|tablet|playbook|silk|kindle|nexus (?:7|9|10)|android(?!.*mobile)/.test(s)
  ) {
    return "tablet";
  }
  if (
    /mobi|iphone|ipod|android|blackberry|iemobile|opera mini|windows phone/.test(s)
  ) {
    return "mobile";
  }
  return "desktop";
}

/**
 * Parse a User-Agent into coarse device/OS/browser dimensions.
 *
 * Unknown or absent tokens degrade to a `"Unknown"` name with a null version
 * rather than throwing — an unparseable UA is a normal event, not an error,
 * and analytics must never be able to break a redirect.
 */
export function parseUA(ua: string | null | undefined): ParsedUA {
  const device = deviceFromUA(ua);

  if (!ua) {
    return {
      device,
      os: "Unknown",
      osVersion: null,
      browser: "Unknown",
      browserVersion: null,
    };
  }

  const browser = firstMatch(BROWSER_RULES, ua);
  const os = firstMatch(OS_RULES, ua);

  return {
    device,
    os: os?.name ?? "Unknown",
    osVersion: normaliseVersion(os?.re.exec(ua)?.[1]),
    browser: browser?.name ?? "Unknown",
    browserVersion: normaliseVersion(browser?.re.exec(ua)?.[1]),
  };
}

/**
 * Primary language subtag from an `Accept-Language` header, e.g.
 * `"tr-TR,tr;q=0.9,en;q=0.8"` -> `"tr"`. Quality values are deliberately
 * ignored: browsers send q-ordered lists, and the first entry is the UI
 * language. Returns null when the header is absent or unparseable.
 */
export function primaryLanguage(acceptLanguage: string | null | undefined): string | null {
  if (!acceptLanguage) return null;
  const first = acceptLanguage.split(",")[0]?.split(";")[0]?.trim();
  if (!first) return null;
  // Strip everything from the first separator: "tr-TR" -> "tr", "PT_br" -> "pt".
  // Keep script/region out of the aggregate so "tr-TR" and "tr" do not become
  // two rows.
  const base = first.replace(/[-_].*$/, "").toLowerCase();
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}
