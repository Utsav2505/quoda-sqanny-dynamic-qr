// Cross-site request forgery, tested through the REAL app.
//
// These dispatch through src/index.tsx rather than a sub-router on purpose: the
// guard is app-level middleware, so a test that mounts one router in isolation
// would exercise a wiring that production never uses and prove nothing.
//
// The background is worth stating, because the severity is easy to over- or
// under-call. The session cookie is `SameSite=Lax`, which withholds the cookie
// from a cross-site POST — so the classic auto-submitting form attack was already
// blocked. Lax does NOT withhold the cookie from a cross-site top-level GET
// navigation, which is exactly how `GET /auth/logout` and `GET /onboarding/skip`
// were reachable from a hostile page: one <img> tag, silently signed out or
// silently onboarded.
//
// The guard closes that, and the Origin/Sec-Fetch-Site check is defence in depth
// behind the cookie attribute rather than a replacement for it.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../src/index";
import { createUser } from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      pending.push(Promise.resolve(p));
    },
    passThroughOnException() {},
    async _drain() {
      await Promise.all(pending);
    },
  };
}

async function call(req: Request): Promise<Response> {
  const c = makeCtx();
  const res = await app.fetch(req, env, c as unknown as ExecutionContext);
  await c._drain();
  return res;
}

async function session(tag: string) {
  const user = await createUser(env.DB, `${tag}-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, user.id);
  return { user, cookie: setCookie.split(";")[0] };
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("cross-site state changes are refused", () => {
  it("refuses a POST that names a foreign Origin", async () => {
    const { cookie } = await session("csrf-origin");
    const res = await call(
      new Request("https://q.test/auth/logout", {
        method: "POST",
        headers: { ...FORM, Cookie: cookie, Origin: "https://evil.test" },
        body: "",
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a POST whose Referer is off-site", async () => {
    // Some clients strip Origin on a same-origin form POST and send only
    // Referer, so the check has to consult both.
    const { cookie } = await session("csrf-referer");
    const res = await call(
      new Request("https://q.test/auth/logout", {
        method: "POST",
        headers: { ...FORM, Cookie: cookie, Referer: "https://evil.test/attack.html" },
        body: "",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses a POST the browser labels cross-site, whatever the headers say", async () => {
    // Sec-Fetch-Site is set by the browser and cannot be forged by page script,
    // so it is authoritative when present — ahead of Origin.
    const { cookie } = await session("csrf-fetch");
    const res = await call(
      new Request("https://q.test/auth/logout", {
        method: "POST",
        headers: {
          ...FORM,
          Cookie: cookie,
          Origin: env.APP_URL,
          "Sec-Fetch-Site": "cross-site",
        },
        body: "",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses to switch a victim's business context from another site", async () => {
    // The one that needed no guesswork to exploit: a form POST that changes
    // users.current_business_id, i.e. silently re-scopes someone's dashboard.
    const { cookie } = await session("csrf-switch");
    const res = await call(
      new Request("https://q.test/app/businesses/switch", {
        method: "POST",
        headers: { ...FORM, Cookie: cookie, Origin: "https://evil.test" },
        body: new URLSearchParams({ business_id: "x", next: "/app" }).toString(),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses to archive a victim's stand from another site", async () => {
    const { cookie } = await session("csrf-archive");
    const res = await call(
      new Request("https://q.test/qrs/some-stand-id/archive", {
        method: "POST",
        headers: { ...FORM, Cookie: cookie, Origin: "https://evil.test" },
        body: "",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses a cross-site completion of onboarding", async () => {
    const { user, cookie } = await session("csrf-onboarding");
    const res = await call(
      new Request("https://q.test/onboarding/skip", {
        method: "POST",
        headers: { ...FORM, Cookie: cookie, Origin: "https://evil.test" },
        body: "",
      }),
    );
    expect(res.status).toBe(403);
    // And the account is genuinely untouched.
    const row = await env.DB.prepare("SELECT onboarded_at FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ onboarded_at: number | null }>();
    expect(row?.onboarded_at).toBeNull();
  });
});

describe("same-origin traffic is unaffected", () => {
  it("allows a POST with no Origin at all (curl, tests, server-to-server)", async () => {
    // Refusing header-less requests would break the API's own clients and buy
    // nothing: a non-browser caller cannot be tricked by a page it never loaded.
    const { cookie } = await session("csrf-noorigin");
    const res = await call(
      new Request("https://q.test/auth/logout", {
        method: "POST",
        headers: { ...FORM, Cookie: cookie },
        body: "",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("allows a POST that names our own origin", async () => {
    const { cookie } = await session("csrf-selforigin");
    const res = await call(
      new Request("https://q.test/auth/logout", {
        method: "POST",
        headers: { ...FORM, Cookie: cookie, Origin: env.APP_URL },
        body: "",
      }),
    );
    expect(res.status).toBe(303);
  });

  it("allows Sec-Fetch-Site: same-origin and none", async () => {
    for (const site of ["same-origin", "none", "same-site"]) {
      const { cookie } = await session(`csrf-site-${site}`);
      const res = await call(
        new Request("https://q.test/auth/logout", {
          method: "POST",
          headers: { ...FORM, Cookie: cookie, "Sec-Fetch-Site": site },
          body: "",
        }),
      );
      expect(res.status, site).toBe(303);
    }
  });

  it("never blocks a safe method, whatever its origin", async () => {
    // A GET must stay usable from anywhere: it is how a customer follows a
    // printed QR in a messaging app. Only mutations are gated.
    const res = await call(
      new Request("https://q.test/healthz", { headers: { Origin: "https://evil.test" } }),
    );
    expect(res.status).toBe(200);
  });
});
