/**
 * The Hono <-> React boundary.
 *
 * ===========================================================================
 * THIS IS THE MOST IMPORTANT FILE IN THE MIGRATION
 * ===========================================================================
 * Everything SQANNY fetches goes through here. The rules it enforces:
 *
 * 1. **Same-origin only.** No absolute URLs, no configurable base. The Worker
 *    serves the SPA and the API from one origin, so anything else is either a
 *    bug or an injection attempt.
 *
 * 2. **`credentials: "include"` always.** Session cookies are `SameSite=Lax`,
 *    which means a same-origin XHR sends them but a cross-site one does not.
 *    Dropping this silently logs the user out on the first API call.
 *
 * 3. **Errors are thrown, never returned as falsy values.** A `null` return
 *    invites `if (!res) return` which swallows the cause. Requirement 29 wants
 *    designed errors with recovery actions, and that requires a real Error with
 *    a server-authored message.
 *
 * 4. **`ApiError` carries the server's own wording.** The existing API routes
 *    already write errors meant to be read ("That serial is already claimed",
 *    "Pick one of your own active businesses"). Replacing those with a generic
 *    client string would be a regression in the exact dimension the brief cares
 *    about.
 *
 * 5. **401 is distinguished from other failures.** The SPA needs to react
 *    differently to "session expired" (redirect to /login) than to "that batch
 *    failed to generate" (toast + retry). Collapsing them into one error loses
 *    the ability to recover correctly.
 *
 * No global state library. A plain module of functions is sufficient for
 * request/response and needs no provider, no hydration story and no store
 * re-render semantics.
 */

/** An error with a message the UI is expected to show verbatim. */
export class ApiError extends Error {
  readonly status: number;
  /** Server-authored field errors, e.g. `{ batchNumber: "Use 1-12 letters/digits" }`. */
  readonly fieldErrors?: Record<string, string>;
  /** True when the session is gone and the only recovery is to sign in again. */
  readonly isAuthError: boolean;

  constructor(
    status: number,
    message: string,
    options?: { fieldErrors?: Record<string, string>; isAuthError?: boolean },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = options?.fieldErrors;
    this.isAuthError = options?.isAuthError ?? status === 401;
  }
}

/** Network-level failure: offline, DNS, connection reset, CORS preflight block. */
export class NetworkError extends Error {
  constructor(message = "Couldn't reach Sqanny. Check your connection.") {
    super(message);
    this.name = "NetworkError";
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query): string {
  // Rule 1: refuse to leave the origin. A path arriving as "https://evil.test/x"
  // or "//evil.test/x" is a bug at the call site or an injection attempt.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith("//")) {
    throw new Error(`Refusing non-relative API path: ${path}`);
  }
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  /** `formData` sends multipart (R2 uploads); `json` is the default. */
  formData?: FormData;
}

async function toApiError(response: Response): Promise<ApiError> {
  // Try to read the server's message. The API writes `{ ok: false, error }` in
  // the shape produced by `jsonError` in src/lib/, but a middleware 500 from
  // Cloudflare is HTML, so parsing must be defensive on both counts.
  let message = "";
  let fieldErrors: Record<string, string> | undefined;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await response.json()) as {
        error?: unknown;
        errors?: unknown;
      };
      if (typeof body.error === "string" && body.error) message = body.error;
      if (body.errors && typeof body.errors === "object") {
        fieldErrors = body.errors as Record<string, string>;
      }
    } catch {
      /* body claimed JSON but was not; fall through to the generic message */
    }
  }

  if (!message) {
    if (response.status === 401) message = "Please sign in again.";
    else if (response.status === 403) message = "You don't have access to that.";
    else if (response.status === 404) message = "That no longer exists.";
    else if (response.status === 409) message = "That conflicts with something that already exists.";
    else if (response.status === 429) message = "Too many requests. Give it a moment.";
    else if (response.status >= 500) message = "Sqanny hit an error. Try again in a moment.";
    else message = `Request failed (${response.status}).`;
  }

  return new ApiError(response.status, message, { fieldErrors });
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal, formData } = options;

  const headers: Record<string, string> = { Accept: "application/json" };
  let payload: BodyInit | undefined;

  if (formData) {
    // Content-Type is deliberately NOT set: the browser must add the multipart
    // boundary itself.
    payload = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: payload,
      // Rule 2. Also means an expired session surfaces as a 401 JSON body
      // rather than an HTML redirect to /login that would break res.json().
      credentials: "include",
      signal,
    });
  } catch (err) {
    // Rule 3: a thrown Error, so a caller cannot accidentally treat this as data.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new NetworkError();
  }

  if (!response.ok) throw await toApiError(response);

  // 204 and other empty bodies are legitimate successes.
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return (await response.text()) as unknown as T;
  }
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) =>
    request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, formData: FormData) => request<T>(path, { method: "POST", formData }),
};