import { createMiddleware } from "hono/factory";
import type { Bindings } from "../types";
import { getUserFromRequest } from "../lib/auth/session";

export interface AppUser {
  id: string;
  email: string;
  plan_id: string;
  onboarded_at: number | null;
  name: string | null;
  phone: string | null;
  avatar_key: string | null;
  /** active business scope; null = "All businesses" */
  current_business_id: string | null;
}

export interface Variables {
  user: AppUser | null;
}

/** App-typed Hono generic — use `new Hono<AppEnv>()` for routes that read the user. */
export type AppEnv = { Bindings: Bindings; Variables: Variables };

/** Populate c.get("user") with the current user or null. Never redirects. */
export const loadUser = createMiddleware<AppEnv>(async (c, next) => {
  c.set("user", await getUserFromRequest(c.env, c.req.raw));
  await next();
});

/** Guard: requires a logged-in user, else redirects to /login. Sets c.get("user"). */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const user = await getUserFromRequest(c.env, c.req.raw);
  if (!user) return c.redirect("/login", 302);
  c.set("user", user);
  await next();
});

/**
 * Guard for a JSON API: 401 with a body, never a 302 to the login page.
 *
 * `requireAuth` is a browser-flow guard — it answers an expired session with an
 * HTML sign-in page, which is right for a page request and useless for fetch().
 * The studio island called `res.json()` on that HTML, so an expired session threw
 * a SyntaxError and surfaced to the user as "Couldn't save. Check your
 * connection." A machine caller needs a status code it can branch on.
 *
 * Never redirects, so an API client can retry with a fresh session.
 */
export const requireApiAuth = createMiddleware<AppEnv>(async (c, next) => {
  const user = await getUserFromRequest(c.env, c.req.raw);
  if (!user) {
    return c.json(
      { ok: false, error: "Your session has expired. Sign in again to continue.", code: "unauthenticated" },
      401,
    );
  }
  c.set("user", user);
  await next();
});

/** Methods that can change state. GET/HEAD/OPTIONS are safe by definition. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Reject a state-changing request that a browser sent from another site.
 *
 * The session cookie is already `SameSite=Lax`, which blocks the classic
 * cross-site form POST — Lax cookies are withheld from cross-site POSTs. This is
 * the second layer, and it covers the case Lax does not: Lax cookies ARE sent on
 * a cross-site top-level GET navigation, which is why the state-changing GETs
 * (sign out, skip onboarding) were reachable from a hostile page.
 *
 * Only a request that EXPLICITLY names a foreign origin is refused. A request
 * with neither Origin nor Referer is not a browser form submission — it is a
 * curl, a test, or a server-to-server call — and refusing it would break the
 * API's own clients for no security gain.
 *
 * `Sec-Fetch-Site` is preferred where present because the browser sets it
 * itself and a page cannot forge it.
 */
export const requireSameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return next();

  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite) {
    // "same-origin", "same-site" and "none" (a typed/bookmarked navigation) are
    // all fine. "cross-site" is not, whatever the headers claim.
    if (fetchSite === "cross-site") {
      return c.text("Forbidden", 403);
    }
    return next();
  }

  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  const claimed = origin ?? referer;
  if (!claimed) return next();

  const self = new URL(c.env.APP_URL).origin;
  let claimedOrigin: string;
  try {
    claimedOrigin = new URL(claimed).origin;
  } catch {
    return c.text("Forbidden", 403);
  }
  if (claimedOrigin !== self) return c.text("Forbidden", 403);

  return next();
});