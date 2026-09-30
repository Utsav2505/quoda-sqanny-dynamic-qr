// Bundles each src/client/*.ts island into public/js/*.js (dependency-free, minified ESM).
import { build } from "esbuild";
import { readdirSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = resolve(root, "src/client");
const outDir = resolve(root, "public/js");
mkdirSync(outDir, { recursive: true });

let entries = [];
try {
  entries = readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => resolve(srcDir, f));
} catch {
  /* no client dir yet */
}

if (!entries.length) {
  console.log("no client islands to bundle");
} else {
  await build({
    entryPoints: entries,
    outdir: outDir,
    bundle: true,
    minify: true,
    // IIFE so each island is self-contained: loaded as a classic <script defer>,
    // top-level declarations stay function-scoped and never leak to / collide on
    // the global object across islands.
    format: "iife",
    target: "es2022",
    sourcemap: false,
  });
  console.log(`client islands bundled: ${entries.length} -> public/js/`);
}

/**
 * Privacy gate on the scan enrichment tracker.
 *
 * enrich.js is analytics, not a fingerprinting script. These APIs are what
 * turns one into the other, so the build refuses to ship it if any appear. A
 * test would only catch this after someone remembered to write one; this fails
 * the build, which is the moment the mistake is made.
 */
// Note: tokens must be things that SURVIVE minification (identifiers, or
// `document.fonts` / `navigator.plugins` which esbuild leaves intact). A
// banned string that only appears in a comment would never match. Do not
// include `credentials` — the enrich tracker's fetch fallback legitimately
// uses `credentials: "same-origin"` so the HttpOnly cookie rides along.
const FORBIDDEN_IN_ENRICH = [
  "getContext",
  "toDataURL",
  "AudioContext",
  "getBattery",
  "WebGL",
  "document.fonts",
  "navigator.plugins",
  "mediaDevices",
  "getBattery",
];

try {
  const src = readFileSync(resolve(outDir, "enrich.js"), "utf8");
  const found = FORBIDDEN_IN_ENRICH.filter((token) => src.includes(token));
  if (found.length) {
    console.error(
      `\n✗ enrich.js contains fingerprinting APIs: ${found.join(", ")}\n` +
        `  Scan analytics must not cross into device fingerprinting. Remove them,\n` +
        `  or drop the file if tracking was not the intent.\n`,
    );
    process.exit(1);
  }
  console.log("enrich.js privacy gate: ok");
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
  // No tracker built — nothing to gate.
}
