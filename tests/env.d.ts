import type { D1Migration } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    SCAN_COUNTERS: KVNamespace;
    RATE_LIMIT: KVNamespace;
    SESSION_CACHE: KVNamespace;
    ASSETS_BUCKET: R2Bucket;
    APP_URL: string;
    RESEND_API_KEY?: string;
    SCAN_HASH_SECRET?: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
