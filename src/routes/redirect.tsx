import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { getQrByShortCode, claimDestination } from "../db/queries";
import {
  logScan,
  scanCookie,
  isHostedDestination,
} from "../lib/analytics";
import { getUserFromRequest } from "../lib/auth/session";
import { withinRateLimit } from "../lib/ratelimit";
import { clientIp } from "../lib/iphash";
import {
  ClaimPage,
  normalizeClaimUrl,
  type ClaimError,
} from "./claim";

export const redirect = new Hono<AppEnv>();
// The claim page needs to know whether the visitor is signed in, without
// requiring one. loadUser never redirects; requireAuth would.
redirect.use("/r/*", async (c, next) => {
  c.set("user", await getUserFromRequest(c.env, c.req.raw));
  await next();
});

/** Attempts allowed per IP per minute across all claim submissions. */
const CLAIM_RATE_MAX = 5;

/** Short codes are base62; anything else is not one we issued. */
const CODE_RE = /^[0-9A-Za-z]{4,32}$/;

/**
 * GET /r/:code — the dynamic QR endpoint.
 *
 * Two outcomes from one URL, which is the entire point of a dynamic code:
 *   - destination set   -> 302 to it
 *   - destination unset -> render the claim page so a signed-in visitor can
 *                          set one. The printed code never changes either way.
 *
 * LATENCY BUDGET for the redirecting case: one D1 lookup, then a 302. The scan
 * write stays inside waitUntil, and the only added hot-path work is one
 * `crypto.randomUUID()` plus, for hosted destinations, one response header.
 */
redirect.get("/r/:code", async (c) => {
  const code = c.req.param("code");

  let qr;
  try {
    qr = await getQrByShortCode(c.env.DB, code);
  } catch (err) {
    console.error(`[redirect] lookup failed for ${code}:`, err);
    return c.text("Temporarily unavailable", 503);
  }

  if (!qr) {
    return c.text("Not Found", 404);
  }

  // A static code with no destination cannot exist (its content is baked in at
  // print time), so this is a malformed row rather than a deferred one. Bail
  // before logging — a 404 is not a scan.
  if (!qr.destination && (!qr.is_dynamic || !qr.short_code)) {
    return c.text("Not Found", 404);
  }

  // Both outcomes are real scans: a deferred code showing its claim page is
  // still someone pointing a camera at your label. Minted synchronously so the
  // redirecting path can carry it in a cookie before logScan runs.
  const scanId = crypto.randomUUID();
  c.executionCtx.waitUntil(
    logScan(c.env, { id: qr.id }, c.req.raw, scanId).catch((err) =>
      console.error("[redirect] scan log error:", err),
    ),
  );

  // --- Deferred destination: claim page, not a redirect --------------------
  if (!qr.destination) {
    const user = c.get("user");
    // The form is only ever offered for a code the viewer OWNS. Showing it to
    // any signed-in visitor is what let a stranger repoint somebody else's
    // printed code; now that the write is owner-scoped the offer has to be too,
    // or the page advertises an action that is guaranteed to be refused.
    //
    // A physical Sqanny Stand is never claimed here at all — its destination is
    // owned by the registry service, reachable from the owner's stands page.
    const isStand = qr.source === "registration";
    const mine = Boolean(user) && qr.user_id === user!.id;
    const claimable = !isStand && mine;

    return c.html(
      <ClaimPage
        title={qr.title}
        code={qr.short_code!}
        signedIn={claimable}
        email={claimable ? (user?.email ?? null) : null}
        // An owned code reaches the owner through /qrs; a stranger gets nothing.
        signedInElsewhere={Boolean(user) && !claimable}
        error={(c.req.query("error") as ClaimError | undefined) ?? null}
      />,
      200,
    );
  }

  // --- Configured: straight through ----------------------------------------
  // Only pages we host can run the enrichment script, so only they need the
  // correlation cookie. External destinations are unchanged.
  if (isHostedDestination(qr.destination, c.env.APP_URL)) {
    c.header("Set-Cookie", scanCookie(scanId, c.env.APP_URL.startsWith("https://")));
  }

  return c.redirect(qr.destination, 302);
});

/**
 * POST /r/:code/claim — set a deferred destination.
 *
 * Plain HTML form POST (no client island), so it works without JavaScript.
 * Requires a signed-in account AND that the caller owns the code: the ownership
 * check lives in the conditional UPDATE itself (see claimDestination), so a
 * hand-crafted POST naming someone else's short code moves nothing. The printed
 * code is not a credential, so "signed in" was never sufficient authority —
 * the code also has to be yours.
 *
 * A physical Sqanny Stand is refused outright. Its destination belongs to the
 * registry service, which is the single place that may write it; this legacy
 * path exists only for studio-created dynamic codes whose destination was left
 * blank at print time.
 *
 * First come, first served among eligible callers. The conditional UPDATE is
 * the arbiter, so a race between two of them cannot produce two winners.
 */
redirect.post("/r/:code/claim", async (c) => {
  const code = c.req.param("code");
  if (!CODE_RE.test(code)) return c.text("Not Found", 404);

  const user = c.get("user");
  if (!user) {
    // Bounce through sign-in and return here. next is re-validated server-side
    // before it is ever used as a redirect target.
    return c.redirect(`/login?next=${encodeURIComponent(`/r/${code}`)}`, 302);
  }

  const ip = clientIp(c.req.raw) ?? "unknown";
  if (!(await withinRateLimit(c.env, "claim", ip, CLAIM_RATE_MAX, 60))) {
    return c.redirect(`/r/${code}?error=rate-limited`, 302);
  }

  let rawUrl = "";
  try {
    const body = await c.req.parseBody();
    rawUrl = typeof body.url === "string" ? body.url : "";
  } catch {
    rawUrl = "";
  }

  const destination = normalizeClaimUrl(rawUrl);
  if (!destination) {
    return c.redirect(`/r/${code}?error=invalid-url`, 302);
  }

  const result = await claimDestination(c.env.DB, code, destination, user.id);
  if (result === "not-found") return c.text("Not Found", 404);

  // Not yours, or a physical stand. Both are refusals, and neither is allowed to
  // become a dead end: the page explains and, for a stand, points at the place
  // the destination is actually managed from.
  if (result === "not-owner" || result === "managed-elsewhere") {
    return c.redirect(`/r/${code}?error=${result}`, 302);
  }

  if (result === "already-set") {
    // Someone won the race. Send the visitor onward rather than showing a
    // dead end — the code is configured, which is what they came for.
    return c.redirect(`/r/${code}?error=already-set`, 302);
  }

  // Land back on /r/<code>, which now performs the 302 — the exact path every
  // future scan takes.
  return c.redirect(`/r/${code}`, 302);
});
