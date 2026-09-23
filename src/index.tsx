import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";
import type { Bindings } from "./types";

// --- API routes (server-side, must run through Hono) ---
import { previewApi } from "./routes/api/preview";
import { brandApi } from "./routes/api/brand";
import { wallpaperApi } from "./routes/api/wallpaper";
import { qrApi } from "./routes/api/qr";
import { analyticsApi } from "./routes/api/analytics";
import { uploadApi } from "./routes/api/upload";
import { skuApi } from "./routes/api/admin/skus";
import { batchApi } from "./routes/api/admin/batches";

// --- Auth routes (server-side) ---
import { auth } from "./routes/auth";

// --- Server-side routes that must remain ---
import { redirect } from "./routes/redirect"; // /r/:code

const app = new Hono<{ Bindings: Bindings }>();

// Health check
app.get("/healthz", (c) => c.json({ ok: true, service: "sqanny" }));

// Favicon
app.get("/favicon.svg", (c) =>
  c.body(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0D0D0F"/><g fill="#FAFAFA"><rect x="7" y="7" width="4" height="4"/><rect x="13" y="7" width="4" height="4"/><rect x="7" y="13" width="4" height="4"/><rect x="19" y="9" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/><rect x="19" y="15" width="4" height="4"/><rect x="9" y="19" width="4" height="4"/><rect x="15" y="19" width="4" height="4"/><rect x="19" y="21" width="6" height="4"/><rect x="21" y="19" width="4" height="6"/></g></svg>`,
    200,
    { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
  ),
);
app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));

// --- API routes ---
app.route("/", previewApi);
app.route("/", brandApi);
app.route("/", wallpaperApi);
app.route("/", qrApi);
app.route("/", analyticsApi);
app.route("/", uploadApi);
app.route("/", skuApi);
app.route("/", batchApi);

// --- Auth routes (server-side magic link flow) ---
app.route("/", auth);

// --- QR redirect (must be server-side for analytics) ---
app.route("/", redirect);

// --- SPA fallback: serve index.html for all other routes ---
// This allows React Router to handle client-side routing
app.get("*", async (c) => {
  const asset = await c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
  return new Response(asset.body, {
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache",
    },
  });
});

export default app;
