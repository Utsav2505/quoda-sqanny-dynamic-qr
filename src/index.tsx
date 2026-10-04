import { Hono } from "hono";
import type { Bindings } from "./types";
import { requireSameOrigin } from "./middleware/auth";

// Public
import { marketing } from "./routes/marketing";
import { spa } from "./routes/spa";
import { wallpaper } from "./routes/wallpaper";
import { pages } from "./routes/pages";
import { redirect } from "./routes/redirect";
import { styleguide } from "./routes/styleguide";
import { previewApi } from "./routes/api/preview";
import { brandApi } from "./routes/api/brand";
import { wallpaperApi } from "./routes/api/wallpaper";

// Auth + app (authed routes guard themselves with requireAuth)
import { auth } from "./routes/auth";
import { onboarding } from "./routes/onboarding";
import { dashboard } from "./routes/dashboard";
import { businesses } from "./routes/businesses";
import { profile } from "./routes/profile";
import { settings } from "./routes/settings";
import { studio } from "./routes/studio";
import { qrDetail } from "./routes/qr-detail";
import { qrs } from "./routes/qrs";
import { batches } from "./routes/batches";
import { qrApi } from "./routes/api/qr";
import { analyticsApi } from "./routes/api/analytics";
import { enrichApi } from "./routes/api/enrich";
import { uploadApi } from "./routes/api/upload";

const app = new Hono<{ Bindings: Bindings }>();

// Every state-changing request is checked for a same-origin sender before any
// route runs. The session cookie's SameSite=Lax already blocks the classic
// cross-site form POST; this closes the gap Lax leaves open — a cross-site
// top-level GET, which is how sign-out and the onboarding skip used to be
// reachable from a hostile page. See middleware/auth.ts.
app.use("*", requireSameOrigin);

app.get("/healthz", (c) => c.json({ ok: true, service: "sqanny" }));

// Brand favicon: the Q logomark built from QR modules.
app.get("/favicon.svg", (c) =>
  c.body(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0D0D0F"/><g fill="#FAFAFA"><rect x="7" y="7" width="4" height="4"/><rect x="13" y="7" width="4" height="4"/><rect x="7" y="13" width="4" height="4"/><rect x="19" y="9" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/><rect x="19" y="15" width="4" height="4"/><rect x="9" y="19" width="4" height="4"/><rect x="15" y="19" width="4" height="4"/><rect x="19" y="21" width="6" height="4"/><rect x="21" y="19" width="4" height="6"/></g></svg>`,
    200,
    { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
  ),
);
app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));

// --- APIs (specific paths) ---
app.route("/", previewApi); // POST /api/preview
app.route("/", brandApi); // POST /api/brand (AI Brand Match)
app.route("/", wallpaperApi); // POST /api/wallpaper (AI QR Wallpaper)
app.route("/", qrApi); // /api/qr*
app.route("/", analyticsApi); // /api/qr/:id/analytics
app.route("/", enrichApi); // POST /api/enrich (public, cookie-correlated)
app.route("/", uploadApi); // POST /api/upload, GET /assets/:key

// --- Auth + onboarding ---
app.route("/", auth); // /login, /auth/verify, /auth/logout
app.route("/", onboarding); // /onboarding*

// --- App pages: static segments before the /app/:id param route ---
// Order matters: /app/businesses/* must be registered before /app/:id, or
// Hono would match a business id as a QR id.
app.route("/", dashboard); // /app
app.route("/", settings); // /app/settings
app.route("/", businesses); // /app/businesses*
app.route("/", profile); // /app/profile
app.route("/", studio); // /app/new, /app/:id/edit
app.route("/", qrDetail); // /app/:id  (registered last)

// --- Dynamic QR + hosted landing pages ---
// Registered BEFORE marketing, whose "/" is a catch-all home page: /q/:serial
// has to be reached before anything can swallow it.
//
// `batches` is registered before `qrs` for the same reason `businesses` is
// registered before `/app/:id`: /qrs/batches would otherwise match qrs'
// `/qrs/:identifier` and be read as a serial number. There is a test asserting
// the ordering, because it is invisible until it breaks.
app.route("/", batches); // /qrs/batches*, must precede `qrs`
app.route("/", qrs); // /q/:identifier, /qrs/claim*
app.route("/", redirect); // /r/:code
app.route("/", pages); // /p/:slug

// --- Dev styleguide ---
app.route("/styleguide", styleguide);



// --- AI QR wallpaper creator ---
app.route("/", wallpaper);

// --- Marketing (home + static pages) registered LAST: its "/" is the catch-all home ---
app.route("/", marketing);

// --- React SPA (the new frontend) ---
//
// Mounted LAST, and deliberately so. While the SSR frontend above is still being
// migrated area by area, the new app is reachable at /_app/ for development and
// review without taking over any production route. This is what makes the
// migration reversible at any point: deleting this one line restores the
// previous behaviour exactly.
//
// When an area moves to React, its SSR route is deleted from the list above and
// its prefix is added to SPA_PREFIXES in routes/spa.ts - two edits, in the same
// change, so there is never a moment where a path is handled by neither or by
// both.
//
// It is registered after `qrs` and `redirect` so that /q/:identifier and
// /r/:code can never be captured by the SPA, no matter how the allowlist in
// routes/spa.ts is edited. The QR redirect path stays React-free by construction.
app.route("/", spa);

export default app;
