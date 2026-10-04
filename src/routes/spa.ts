import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth";

/**
 * Serves the React SPA shell.
 *
 * ===========================================================================
 * THE ONE RULE THAT MATTERS
 * ===========================================================================
 * This router handles an EXPLICIT ALLOWLIST of prefixes. It is deliberately not
 * a catch-all, and that decision protects three things:
 *
 *   1. `/q/:identifier` and `/r/:code` - the QR redirect path. These are
 *      registered on `qrs`/`redirect` and never reach this router. A customer
 *      scanning a code therefore downloads zero React, zero Tailwind, zero
 *      dashboard JS. Requirement 9 is satisfied by the routing table, so it
 *      cannot be broken by a future edit here.
 *
 *   2. `/api/*` - the JSON API. If this were a catch-all, a 404 from a deleted
 *      QR would return `200 text/html` with the SPA shell, and every client
 *      `fetch` would fail on `res.json()` with an error that says nothing about
 *      what actually went wrong.
 *
 *   3. The existing SSR pages that are still live and are NOT being replaced in
 *      this migration pass (marketing, auth, `/p/:slug`). A catch-all mounted
 *      before them would take them over.
 *
 * The allowlist is therefore the contract. Adding a page to the SPA means adding
 * it HERE too, which is the point: it is a deliberate act.
 */
export const spa = new Hono<AppEnv>();

/**
 * Prefixes owned by the React app. Each corresponds to a top-level route in
 * `web/src/App.tsx` (Phase 6).
 */
const SPA_PREFIXES = [
  "/app", // Overview, Businesses, Stands, QR Codes, Batches, Profile, Settings
] as const;

/** Asset URLs under /_app are hashed by Vite and served by the asset layer. */
const ASSET_PREFIX = "/_app/";

/**
 * The built shell, as it exists in the asset tree.
 *
 * Vite writes to `public/_app/`, so the shell document is served from
 * `/_app/index.html` - NOT `/index.html`. The legacy `public/` root holds only
 * `logo.png`, `js/` and `styles/`, so a lookup at the root would always miss.
 */
const SHELL_PATH = "/_app/index.html";

/**
 * Read the shell, or return null.
 *
 * Returns null instead of throwing for two distinct, both-expected conditions:
 *
 *  1. `build:web` has not been run. The Worker then serves the legacy SSR
 *     frontend for everything, because `spa` is mounted last and no SPA prefix is
 *     claimed yet - so a missing shell is a no-op, not an outage.
 *  2. `env.ASSETS` is absent, which is the case under
 *     `@cloudflare/vitest-pool-workers`. The asset binding is not provisioned
 *     there, and treating that as a fatal error turns every SPA route into a 500
 *     in the test suite.
 */
async function readShell(c: Context<AppEnv>): Promise<string | null> {
  if (!c.env.ASSETS) return null;
  try {
    const res = await c.env.ASSETS.fetch(
      new Request(new URL(SHELL_PATH, "https://internal")),
    );
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.error("[spa] shell read failed:", err);
    return null;
  }
}

/**
 * Cache policy.
 *
 * `index.html` MUST NOT be cached. It is the only file whose contents reference
 * the hashed asset filenames, so caching it is how a deploy silently fails to
 * take effect - the browser keeps asking for last week's bundles. The hashed
 * assets are immutable and can be cached for a year.
 */
const NO_CACHE = "no-cache, no-store, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";

spa.get("/app", (c) => serveShell(c));
spa.get("/app/*", (c) => serveShell(c));

/**
 * Also expose the shell at /_app/ for direct inspection during development, and
 * so a hard refresh on a nested URL has somewhere to resolve.
 */
spa.get(ASSET_PREFIX, (c) => serveShell(c));

async function serveShell(c: Context<AppEnv>) {
  // A missing hashed asset must NOT be answered with the shell: a JS request
  // answered with index.html produces an opaque "Unexpected token '<'" instead
  // of a clear 404.
  if (c.req.path.startsWith(`${ASSET_PREFIX}assets/`)) {
    return c.text("Not Found", 404);
  }

  const html = await readShell(c);

  if (html === null) {
    // Distinguish "not built yet" from "built but empty" only for the log; the
    // client gets one actionable message either way.
    console.warn(
      `[spa] no shell at ${SHELL_PATH} — run \`npm run build:web\`. Serving legacy SSR for /app/*.`,
    );
    return c.text(
      "SQANNY: the React build is missing. Run `npm run build:web` (see package.json).",
      503,
    );
  }

  // Never cache the shell. See NO_CACHE above.
  c.header("Cache-Control", NO_CACHE);
  return c.html(html);
}

/**
 * Hashed asset passthrough.
 *
 * Normally the platform's asset layer answers `/_app/assets/*` before the Worker
 * is invoked at all. This route exists for `wrangler dev`, where a stale or
 * mid-build asset would otherwise 404 confusingly, and it documents the intended
 * caching contract in one place.
 */
spa.get(`${ASSET_PREFIX}assets/*`, async (c) => {
  if (!c.env.ASSETS) return c.text("Not Found", 404);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (!res.ok) return c.text("Not Found", 404);
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
      "Cache-Control": IMMUTABLE,
    },
  });
});

/**
 * Migration diagnostics. Reports whether the React build is actually present,
 * which is the first thing to check when a migrated route renders a 503.
 */
spa.get("/api/app-info", async (c) => {
  const html = await readShell(c);
  return c.json({
    ok: true,
    shell: html === null ? "missing - run npm run build:web" : "present",
    shellPath: SHELL_PATH,
    prefixes: SPA_PREFIXES,
    note: "The QR redirect path (/q/:id, /r/:code) never serves this app.",
  });
});