import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { auth } from "../src/routes/auth";
import { dashboard } from "../src/routes/dashboard";
import { settings } from "../src/routes/settings";
import { createUser } from "../src/db/queries";
import { startSession, SESSION_COOKIE } from "../src/lib/auth/session";

// Minimal ExecutionContext — these routes don't use waitUntil, but fetch wants one.
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

// Force the dev (console) magic-link path so issueMagicLink never hits Resend.
const devEnv = { ...env, RESEND_API_KEY: undefined } as typeof env;

/** SHA-256 hex (mirrors the auth module) for locating the stored link row. */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("GET /login", () => {
  it("renders the calm sign-in form", async () => {
    const res = await auth.fetch(new Request("https://q.test/login"), devEnv, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to Sqanny");
    expect(html).toContain('name="email"');
    expect(html).toContain("Send sign-in link");
  });
});

describe("POST /login", () => {
  it("issues a magic link (a magic_links row exists) and shows the confirmation", async () => {
    const email = `login-${crypto.randomUUID()}@example.com`;

    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM magic_links WHERE email = ?",
    )
      .bind(email)
      .first<{ n: number }>();
    expect(before?.n ?? 0).toBe(0);

    const res = await auth.fetch(
      new Request("https://q.test/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email }).toString(),
      }),
      devEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Check your inbox");
    expect(html).toContain(email);
    // Dev-mode note about the console link.
    expect(html).toContain("[DEV MAGIC LINK]");

    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM magic_links WHERE email = ?",
    )
      .bind(email)
      .first<{ n: number }>();
    expect(after?.n ?? 0).toBe(1);
  });

  it("rejects an invalid email without issuing a link", async () => {
    const res = await auth.fetch(
      new Request("https://q.test/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "not-an-email" }).toString(),
      }),
      devEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Enter a valid email address.");
  });
});

describe("GET /auth/verify", () => {
  it("creates a session and 302-redirects a freshly issued token", async () => {
    const email = `verify-${crypto.randomUUID()}@example.com`;

    // Issue via the POST handler so the full route path is exercised.
    await auth.fetch(
      new Request("https://q.test/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email }).toString(),
      }),
      devEnv,
      ctx,
    );

    // Recover the raw token: the stored row keys by sha256(token), so re-issue
    // directly to obtain a token we control, then verify via the route.
    const { issueMagicLink } = await import("../src/lib/auth/magic-link");
    const { token } = await issueMagicLink(devEnv, email);

    const res = await auth.fetch(
      new Request(`https://q.test/auth/verify?token=${token}`),
      devEnv,
      ctx,
    );
    expect(res.status).toBe(302);
    // New users (onboarded_at null) land on onboarding.
    expect(res.headers.get("location")).toBe("/onboarding");

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");

    // The session resolves to a real user.
    const sessionId = setCookie!.split(";")[0].split("=")[1];
    const sess = await env.DB.prepare(
      "SELECT user_id FROM sessions WHERE id = ?",
    )
      .bind(sessionId)
      .first<{ user_id: string }>();
    expect(sess?.user_id).toBeTruthy();

    // Verify the link hash row was consumed.
    const hash = await sha256Hex(token);
    const link = await env.DB.prepare(
      "SELECT consumed_at FROM magic_links WHERE token_hash = ?",
    )
      .bind(hash)
      .first<{ consumed_at: number | null }>();
    expect(link?.consumed_at).not.toBeNull();
  });

  it("renders a friendly error for an invalid token", async () => {
    const res = await auth.fetch(
      new Request("https://q.test/auth/verify?token=garbage"),
      devEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("no longer valid");
    expect(html).toContain("/login");
  });

  it("routes an already-onboarded user to /app", async () => {
    const email = `onb-${crypto.randomUUID()}@example.com`;
    const user = await createUser(env.DB, email);
    await env.DB.prepare("UPDATE users SET onboarded_at = ? WHERE id = ?")
      .bind(Date.now(), user.id)
      .run();

    const { issueMagicLink } = await import("../src/lib/auth/magic-link");
    const { token } = await issueMagicLink(devEnv, email);

    const res = await auth.fetch(
      new Request(`https://q.test/auth/verify?token=${token}`),
      devEnv,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
  });
});

describe("signing out", () => {
    it("POST /auth/logout clears the session cookie and redirects home", async () => {
      const user = await createUser(env.DB, `out-${crypto.randomUUID()}@example.com`);
      const setCookie = await startSession(env, user.id);
      const cookie = setCookie.split(";")[0];

      const res = await auth.fetch(
        new Request("https://q.test/auth/logout", {
          method: "POST",
          headers: { Cookie: cookie },
        }),
        env,
        ctx,
      );
      // 303, not 302: the browser must follow up with a GET after a state change,
      // and a 302 leaves that open to interpretation.
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
      const cleared = res.headers.get("set-cookie");
      expect(cleared).toContain("Max-Age=0");
    });

    it("GET /auth/logout does NOT sign you out — it asks first", async () => {
      // The session cookie is SameSite=Lax, which deliberately permits
      // cross-site top-level GET navigations. A GET logout could therefore be
      // fired from any page with a single <img> tag, silently signing the user
      // out. The GET now only renders a confirmation.
      const user = await createUser(env.DB, `out-${crypto.randomUUID()}@example.com`);
      const setCookie = await startSession(env, user.id);
      const cookie = setCookie.split(";")[0];

      const res = await auth.fetch(
        new Request("https://q.test/auth/logout", { headers: { Cookie: cookie } }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      // It offers the real action as a POST, and a way to back out.
      const html = await res.text();
      expect(html).toContain('method="post"');
      expect(html).toContain('action="/auth/logout"');
      expect(html).toContain("Stay signed in");

      // And the session is genuinely still alive.
      const still = await auth.fetch(
        new Request("https://q.test/login", { headers: { Cookie: cookie } }),
        env,
        ctx,
      );
      expect(still.status).toBe(200);
    });
  });

describe("GET /app (dashboard)", () => {
  it("redirects to /login without a session", async () => {
    const res = await dashboard.fetch(new Request("https://q.test/app"), env, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("returns 200 with the dashboard for a seeded session", async () => {
    const user = await createUser(env.DB, `dash-${crypto.randomUUID()}@example.com`);
    const setCookie = await startSession(env, user.id);
    const cookie = setCookie.split(";")[0];

    const res = await dashboard.fetch(
      new Request("https://q.test/app", { headers: { Cookie: cookie } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your QR codes");
    // Empty state for a fresh account.
    expect(html).toContain("Create your first QR");
  });

  it("lists the user's QR codes with type and dynamic badges", async () => {
    const user = await createUser(env.DB, `list-${crypto.randomUUID()}@example.com`);
    const { createQr } = await import("../src/db/queries");
    await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "My Launch Link",
      is_dynamic: true,
      short_code: "abc123",
      destination: "https://example.com",
      content_json: "{}",
      design_json: "{}",
    });

    const setCookie = await startSession(env, user.id);
    const cookie = setCookie.split(";")[0];

    const res = await dashboard.fetch(
      new Request("https://q.test/app", { headers: { Cookie: cookie } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("My Launch Link");
    expect(html).toContain("Dynamic");
    expect(html).toContain("URL");
    // Search island present once there are codes.
    expect(html).toContain("Search by title or type");
  });
});

describe("GET /app/settings", () => {
  it("redirects to /login without a session", async () => {
    const res = await settings.fetch(
      new Request("https://q.test/app/settings"),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("renders account email, plan limits, and a disabled upgrade button", async () => {
    const email = `settings-${crypto.randomUUID()}@example.com`;
    const user = await createUser(env.DB, email);
    const setCookie = await startSession(env, user.id);
    const cookie = setCookie.split(";")[0];

    const res = await settings.fetch(
      new Request("https://q.test/app/settings", { headers: { Cookie: cookie } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(email);
    expect(html).toContain("Free");
    // Free plan dynamic limit is 3.
    expect(html).toContain("of 3");
    expect(html).toContain("Coming in Cloud");
    expect(html).toContain("disabled");
    expect(html).toContain("/auth/logout");
  });
});
