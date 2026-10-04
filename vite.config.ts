import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * Vite builds the NEW React frontend only. Hono remains the backend and the
 * server-side router for everything that must stay fast and un-JS'd.
 *
 * Two constraints decide this file. Both are load-bearing, not preferences.
 *
 * ---------------------------------------------------------------------------
 * 1. THE REDIRECT PATH MUST NOT TOUCH REACT
 * ---------------------------------------------------------------------------
 * `/q/:identifier` and `/r/:code` are Hono routes that resolve and 302. They do
 * not import, reference, or serve anything from this app. No Vite manifest is
 * consulted at runtime for them, and the SPA bundle is never on their path.
 * That guarantee is structural: it comes from WHERE the output is written, not
 * from discipline. See `OUT_DIR` below and the SPA route table in src/routes/spa.ts.
 *
 * ---------------------------------------------------------------------------
 * 2. OUT_DIR IS `public/_app`, NEVER `public/`
 * ---------------------------------------------------------------------------
 * `wrangler.jsonc` binds assets with `{ "directory": "./public" }`. The legacy SSR
 * frontend already lives there (`public/styles`, `public/js`, `public/logo.png`)
 * and still serves the marketing site, auth pages, `/q/`, `/r/`, and the redirect
 * routes. Writing Vite's output to `public/` would:
 *   - collide on `outDir` vs `publicDir` (Vite empties outDir when it is inside
 *     publicDir, which would DELETE the legacy assets), and
 *   - put hashed bundles at the site root where the legacy CSS/JS already live.
 *
 * `public/_app` keeps the two frontends cleanly separated and independently
 * deletable, which is what makes Phase 17 (remove obsolete CSS) a one-line
 * config change rather than a forensic exercise.
 */
const OUT_DIR = "public/_app";

export default defineConfig(({ mode }) => ({
  root: "web",
  // The legacy `public/` is NOT Vite's publicDir. Vite copies publicDir into
  // outDir on build; pointing it at `public` would nest the entire legacy asset
  // tree inside `public/_app/public`. Setting it false keeps the build hermetic:
  // what goes into `public/_app` is exactly what `web/` produces.
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
      "@components": fileURLToPath(new URL("./web/src/components", import.meta.url)),
      "@lib": fileURLToPath(new URL("./web/src/lib", import.meta.url)),
      "@routes": fileURLToPath(new URL("./web/src/routes", import.meta.url)),
    },
  },
  build: {
    outDir: `../${OUT_DIR}`,
    emptyOutDir: true,
    target: "es2022",
    sourcemap: mode !== "production",
    // Readable filenames in dev; content-hashed in production. The Worker never
    // needs to know either name — the SPA shell is generated at build time.
    rollupOptions: {
      output: {
        // Split the heavy, route-specific libraries out of the entry chunk so a
        // user landing on the Overview does not download the GSAP marketing
        // timeline or the batch export code. Requirement 40: do not load
        // expensive libraries on routes that do not need them.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("gsap")) return "gsap";
          if (id.includes("motion") || id.includes("framer")) return "motion";
          if (id.includes("@radix-ui")) return "radix";
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler"))
            return "react";
          if (id.includes("lucide-react")) return "icons";
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    // `npm run dev` runs wrangler for the API; Vite proxies nothing by default.
    // Proxy config is intentionally absent: the SPA talks to the Worker on the
    // same origin, and in `wrangler dev` that origin IS the Worker.
    fs: { strict: true },
  },
}));