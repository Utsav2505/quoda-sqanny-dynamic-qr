import { Hono } from "hono";
import type { AppEnv } from "../../middleware/auth";
import { requireApiAuth } from "../../middleware/auth";
import { getLimits } from "../../lib/plans";
import type { Bindings } from "../../types";

export const uploadApi = new Hono<AppEnv>();

// The asset stream route is public (logos are embedded in shareable QR images);
// only the upload itself requires auth.
uploadApi.use("/api/upload", requireApiAuth);

// ---------------------------------------------------------------------------
// POST /api/upload â€” store an image in R2 (multipart or base64 JSON)
// ---------------------------------------------------------------------------

/**
 * Key prefixes. Namespacing by the owner's id keeps objects attributable and
 * makes "delete everything for this user" a prefix scan rather than a table.
 * `avatar` is for profile photos, `logo` for business/QR logos.
 */
const SCOPES = {
  avatar: "avatars",
  logo: "logos",
} as const;

export type UploadScope = keyof typeof SCOPES;

function readScope(value: string | undefined): UploadScope {
  return value === "avatar" ? "avatar" : "logo";
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
};

const MAX_BYTES = 1_000_000; // 1MB â€” a logo, not a hero image.

export type StoreResult =
  | { ok: true; key: string; url: string }
  | { ok: false; status: 400 | 413 | 415 | 500; error: string };

/**
 * Write an already-validated image to R2 and return its key.
 *
 * Shared by the JSON endpoint and the no-JavaScript multipart form posts, so the
 * type allow-list and the size cap cannot drift between the two paths â€” a
 * direct form POST must not become a way around the limits the API enforces.
 */
export async function storeImage(
  env: Bindings,
  userId: string,
  scope: UploadScope,
  bytes: Uint8Array,
  contentType: string,
): Promise<StoreResult> {
  const ext = EXT_BY_TYPE[contentType];
  if (!ext) {
    return {
      ok: false,
      status: 415,
      error: "Unsupported image type. Use PNG, JPG, WebP, GIF or SVG.",
    };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, status: 400, error: "The image is empty." };
  }
  if (bytes.byteLength > MAX_BYTES) {
    const noun = scope === "avatar" ? "Image" : "Logo";
    return { ok: false, status: 413, error: `${noun} must be 1MB or smaller.` };
  }

  const key = `${SCOPES[scope]}/${userId}/${crypto.randomUUID()}.${ext}`;
  try {
    await env.ASSETS_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  } catch (err) {
    console.error("[upload] R2 put failed:", err);
    return { ok: false, status: 500, error: "Upload failed. Please try again." };
  }
  return { ok: true, key, url: `/assets/${key}` };
}

/** True when a stored key belongs to `userId` under the given scope. */
export function ownsKey(
  key: string | null | undefined,
  userId: string,
  scope: UploadScope,
): boolean {
  if (!key) return false;
  return key.startsWith(`${SCOPES[scope]}/${userId}/`);
}

uploadApi.post("/api/upload", async (c) => {
  const user = c.get("user")!;

  if (!getLimits(user.plan_id).logoUpload) {
    return c.json(
      { ok: false, error: "Logo upload isn't available on your plan.", code: "plan_limit" },
      402,
    );
  }

  const scope = readScope(c.req.query("scope"));
  const reqType = c.req.header("content-type") ?? "";
  let bytes: Uint8Array;
  let contentType: string;

  try {
    if (reqType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file") ?? form.get("logo") ?? form.get("avatar");
      // formData entries are `string | File`; a File is a Blob with `type` +
      // `arrayBuffer`. workers-types doesn't expose the File global, so narrow
      // structurally rather than via instanceof.
      if (!isBlobLike(file)) {
        return c.json({ ok: false, error: "No file provided." }, 400);
      }
      contentType = file.type || "application/octet-stream";
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const body = await c.req.json<Base64Body>();
      const parsed = decodeDataUri(body.data ?? "", body.contentType);
      if (!parsed) {
        return c.json({ ok: false, error: "No image data provided." }, 400);
      }
      contentType = parsed.contentType;
      bytes = parsed.bytes;
    }
  } catch {
    return c.json({ ok: false, error: "Could not read the uploaded image." }, 400);
  }

  const stored = await storeImage(c.env, user.id, scope, bytes, contentType);
  if (!stored.ok) {
    return c.json({ ok: false, error: stored.error }, stored.status);
  }
  return c.json({ ok: true, key: stored.key, url: stored.url }, 201);
});

// ---------------------------------------------------------------------------
// GET /assets/:key{.+} â€” stream an asset from R2 (standalone fallback)
// ---------------------------------------------------------------------------

uploadApi.get("/assets/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.ASSETS_BUCKET.get(key);
  if (!obj) {
    return c.text("Not Found", 404);
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/octet-stream");
  }
  headers.set("cache-control", "public, max-age=31536000, immutable");
  // SVG is on the allow-list because logos are commonly vector, and an SVG can
  // carry <script>. It is served from the app's own origin, so a user who
  // navigates straight to their own upload would otherwise run script with
  // full access to this origin. `sandbox` (no allow-scripts) and nosniff make
  // the object inert while still rendering in <img>, which never runs script
  // anyway â€” the two paths that matter are both covered.
  headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  headers.set("x-content-type-options", "nosniff");

  return new Response(obj.body, { headers });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Base64Body {
  /** data URI or bare base64 */
  data?: string;
  contentType?: string;
}

interface BlobLike {
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Structurally detect a File/Blob form entry (workers-types omits the File global). */
function isBlobLike(value: unknown): value is BlobLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

/** Decode a data URI (or bare base64 + explicit type) into bytes + content type. */
function decodeDataUri(
  data: string,
  explicitType?: string,
): { bytes: Uint8Array; contentType: string } | null {
  if (!data) return null;
  let b64 = data;
  let contentType = explicitType ?? "application/octet-stream";

  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(data);
  if (match) {
    contentType = match[1] || contentType;
    b64 = match[3] ?? "";
    if (!match[2]) {
      // Non-base64 data URI (URL-encoded text, e.g. inline SVG).
      const text = decodeURIComponent(b64);
      return { bytes: new TextEncoder().encode(text), contentType };
    }
  }

  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return { bytes: out, contentType };
  } catch {
    return null;
  }
}
