/** Minimal Workers AI binding surface (avoids model-literal typing friction). */
export interface AIBinding {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
}

export interface Bindings {
  DB: D1Database;
  SCAN_COUNTERS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  SESSION_CACHE: KVNamespace;
  ASSETS_BUCKET: R2Bucket;
  AI: AIBinding;
  /**
   * Static asset fetcher for the bound `assets.directory` in wrangler.jsonc.
   *
   * Used by routes/spa.ts to read the built React shell. The platform serves
   * `/_app/assets/*` from this binding before the Worker is invoked at all; the
   * Worker only reaches for it on the SPA shell document itself, which is not a
   * real file path and therefore always misses the asset layer.
   */
  ASSETS: Fetcher;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** fal.ai API key — when set, wallpaper backgrounds use fal (FLUX dev); else CF Workers AI. */
  FAL_KEY?: string;
  /**
   * HMAC key for pseudonymising scan IP addresses. Deploy with
   * `wrangler secret put SCAN_HASH_SECRET` — never in wrangler.jsonc. When
   * unset, scans are logged without an ip_hash (no unique-visitor counting)
   * rather than falling back to storing a raw address.
   */
  SCAN_HASH_SECRET?: string;
  /**
   * Debug-only. When set to "1"/"true", each scan logs the raw client IP and
   * the parsed dimensions to the Worker console. Off by default because
   * console output is retained by Cloudflare when observability is enabled,
   * which would turn logs into a second store of raw addresses — exactly what
   * ip_hash exists to avoid. Set it locally; leave it unset in production.
   */
  SCAN_LOG_IP?: string;
  APP_URL: string;
}

export type QrType =
  | "url" | "text" | "wifi" | "email" | "tel" | "sms" | "vcard"
  | "pdf" | "menu" | "business" | "appstore" | "social";

export type Ecc = "L" | "M" | "Q" | "H";
