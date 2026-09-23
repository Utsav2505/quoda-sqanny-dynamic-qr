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
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** fal.ai API key — when set, wallpaper backgrounds use fal (FLUX dev); else CF Workers AI. */
  FAL_KEY?: string;
  APP_URL: string;
}

export type QrType =
  | "url" | "text" | "wifi" | "email" | "tel" | "sms" | "vcard"
  | "pdf" | "menu" | "business" | "appstore" | "social";

export type Ecc = "L" | "M" | "Q" | "H";

// ---------------------------------------------------------------------------
// Product QR Management System types
// ---------------------------------------------------------------------------

export type ProductQrStatus = "available" | "claimed" | "active" | "disabled" | "retired";

export type BatchStatus = "pending" | "generating" | "completed" | "failed";
