import { Hono } from "hono";
import type { Bindings } from "./types";

// Public
import { marketing } from "./routes/marketing";
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
import { settings } from "./routes/settings";
import { studio } from "./routes/studio";
import { qrDetail } from "./routes/qr-detail";
import { qrApi } from "./routes/api/qr";
import { analyticsApi } from "./routes/api/analytics";
import { enrichApi } from "./routes/api/enrich";
import { uploadApi } from "./routes/api/upload";

const app = new Hono<{ Bindings: Bindings }>();

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
app.route("/", dashboard); // /app
app.route("/", settings); // /app/settings
app.route("/", studio); // /app/new, /app/:id/edit
app.route("/", qrDetail); // /app/:id  (registered last)

// --- Dynamic QR + hosted landing pages ---
app.route("/", redirect); // /r/:code
app.route("/", pages); // /p/:slug

// --- Dev styleguide ---
app.route("/styleguide", styleguide);



// --- AI QR wallpaper creator ---
app.route("/", wallpaper);

// --- Marketing (home + static pages) registered LAST: its "/" is the catch-all home ---
app.route("/", marketing);

export default app;
