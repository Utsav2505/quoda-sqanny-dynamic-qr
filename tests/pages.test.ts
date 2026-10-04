import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { pages } from "../src/routes/pages";
import { onboarding } from "../src/routes/onboarding";
import { createUser, createQr, upsertDynamicPage } from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";

// Minimal ExecutionContext stub — these routes don't use waitUntil but fetch()
// requires a third arg.
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("GET /p/:slug (hosted dynamic landing pages)", () => {
  it("renders a social link-in-bio page with its links", async () => {
    const user = await createUser(env.DB, `p-${crypto.randomUUID()}@example.com`);
    const slug = "soc" + crypto.randomUUID().slice(0, 6);
    const data = {
      name: "Ada Lovelace",
      bio: "Mathematician & first programmer",
      links: [
        { label: "Instagram", url: "https://instagram.com/ada" },
        { label: "My website", url: "https://ada.example.com" },
      ],
    };
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "social",
      title: "Ada's links",
      is_dynamic: true,
      short_code: slug,
      destination: `${env.APP_URL}/p/${slug}`,
      content_json: JSON.stringify(data),
      design_json: "{}",
    });
    await upsertDynamicPage(env.DB, {
      qr_id: qr.id,
      kind: "social",
      data_json: JSON.stringify(data),
    });

    const res = await pages.fetch(
      new Request(`https://q.test/p/${slug}`),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    // The page renders the person's name and bio.
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Mathematician &amp; first programmer");
    // ...and each social link as a real anchor to its URL.
    expect(html).toContain("Instagram");
    expect(html).toContain('href="https://instagram.com/ada"');
    expect(html).toContain("My website");
    expect(html).toContain('href="https://ada.example.com"');
  });

  it("renders a menu page with sections and prices", async () => {
    const user = await createUser(env.DB, `pm-${crypto.randomUUID()}@example.com`);
    const slug = "menu" + crypto.randomUUID().slice(0, 6);
    const data = {
      title: "Sunrise Cafe",
      currency: "$",
      sections: [
        {
          title: "Coffee",
          items: [{ name: "Flat White", description: "Double shot", price: "4.50" }],
        },
      ],
    };
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "menu",
      title: "Cafe menu",
      is_dynamic: true,
      short_code: slug,
      destination: `${env.APP_URL}/p/${slug}`,
      content_json: JSON.stringify(data),
      design_json: "{}",
    });
    await upsertDynamicPage(env.DB, { qr_id: qr.id, kind: "menu", data_json: JSON.stringify(data) });

    const res = await pages.fetch(new Request(`https://q.test/p/${slug}`), env, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sunrise Cafe");
    expect(html).toContain("Flat White");
    expect(html).toContain("$4.50");
  });

  it("returns 404 for an unknown slug", async () => {
    const res = await pages.fetch(
      new Request("https://q.test/p/does-not-exist"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /onboarding (progressive four-step setup)", () => {
  it("redirects to /login without a session", async () => {
    const res = await onboarding.fetch(
      new Request("https://q.test/onboarding"),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("renders step 1 for a seeded, un-onboarded session", async () => {
    const user = await createUser(env.DB, `ob-${crypto.randomUUID()}@example.com`);
    expect(user.onboarded_at).toBeNull();
    const setCookie = await startSession(env, user.id);
    const cookie = setCookie.split(";")[0];

    const res = await onboarding.fetch(
      new Request("https://q.test/onboarding", { headers: { Cookie: cookie } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The four steps are all present up front — the flow is a URL sequence, not
    // a JavaScript state machine, so nothing is hidden from a no-JS visitor.
    expect(html).toContain("Welcome");
    expect(html).toContain("Personal details");
    expect(html).toContain("Business or later");
    expect(html).toContain("Complete");
    expect(html).toContain("Skip for now");
    // Step 1 only links onward; it must not render a form that posts nowhere.
    expect(html).toContain('href="/onboarding/profile"');
  });

  it("walks details -> business -> complete without creating a QR", async () => {
    const user = await createUser(env.DB, `obc-${crypto.randomUUID()}@example.com`);
    const setCookie = await startSession(env, user.id);
    const cookie = setCookie.split(";")[0];
    const post = (path: string, body: Record<string, string>) =>
      onboarding.fetch(
        new Request(`https://q.test${path}`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(body).toString(),
        }),
        env,
        ctx,
      );

    // Step 2 saves the profile and moves on.
    const details = await post("/onboarding/profile", {
      name: "Ada Lovelace",
      phone: "+1 555 0100",
      avatar_key: "",
    });
    expect(details.status).toBe(302);
    expect(details.headers.get("location")).toBe("/onboarding/business");

    const saved = await env.DB.prepare("SELECT name, phone FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ name: string | null; phone: string | null }>();
    expect(saved?.name).toBe("Ada Lovelace");
    expect(saved?.phone).toBe("+1 555 0100");

    // Step 3 can be skipped entirely — that is a first-class path, not an error.
    const complete = await post("/onboarding/complete", {});
    expect(complete.status).toBe(302);
    const loc = complete.headers.get("location") ?? "";
    expect(loc).toBe("/app?notice=onboarding-complete");

    const updated = await env.DB.prepare("SELECT onboarded_at FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ onboarded_at: number | null }>();
    expect(updated?.onboarded_at).toBeTypeOf("number");

    // Onboarding deliberately creates no QR: the dashboard's own empty state
    // owns that decision, where it can explain dynamic vs static in context.
    const qrs = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_codes WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();
    expect(qrs?.n).toBe(0);
  });

  it("creates a business on step 3 and makes it the active scope", async () => {
    const user = await createUser(env.DB, `obb-${crypto.randomUUID()}@example.com`);
    const setCookie = await startSession(env, user.id);
    const cookie = setCookie.split(";")[0];

    const res = await onboarding.fetch(
      new Request("https://q.test/onboarding/business", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          name: "Analytical Engines",
          category: "cafe",
          address: "12 Connaught Place",
          city: "New Delhi",
          state: "Delhi",
          country: "India",
        }).toString(),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/onboarding/complete");

    const row = await env.DB.prepare(
      `SELECT u.current_business_id, b.name AS biz
         FROM users u
         JOIN businesses b ON b.id = u.current_business_id
        WHERE u.id = ?`,
    )
      .bind(user.id)
      .first<{ current_business_id: string | null; biz: string }>();
    expect(row?.biz).toBe("Analytical Engines");
  });

  it("re-renders step 3 with errors and writes nothing when a required field is blank", async () => {
    const user = await createUser(env.DB, `obe-${crypto.randomUUID()}@example.com`);
    const setCookie = await startSession(env, user.id);
    const cookie = setCookie.split(";")[0];

    const res = await onboarding.fetch(
      new Request("https://q.test/onboarding/business", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          name: "",
          category: "cafe",
          address: "12 Connaught Place",
          city: "New Delhi",
          state: "Delhi",
          country: "India",
        }).toString(),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Business name is required");

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM businesses")
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("offers a no-JS skip on step 3 without nesting a form inside a form", async () => {
    const user = await createUser(env.DB, `obf-${crypto.randomUUID()}@example.com`);
    const setCookie = await startSession(env, user.id);
    const cookie = setCookie.split(";")[0];

    const res = await onboarding.fetch(
      new Request("https://q.test/onboarding/business", { headers: { Cookie: cookie } }),
      env,
      ctx,
    );
    const html = await res.text();
    expect(html).toContain("do this later");
    // Native formaction override, so the skip works with scripting disabled and
    // BusinessForm's own <form> stays a single, valid form.
    expect(html).toContain('formaction="/onboarding/complete"');
    expect(html).not.toContain("<form method=\"post\" action=\"/onboarding/complete\"");
  });

  it("finishes on the dashboard and creates no QR", async () => {
    const user = await createUser(env.DB, `obd-${crypto.randomUUID()}@example.com`);
    const setCookie = await startSession(env, user.id);
    const cookie = setCookie.split(";")[0];

    const res = await onboarding.fetch(
      new Request("https://q.test/onboarding/complete", { headers: { Cookie: cookie } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Go to dashboard");
    // The old flow's CTA promised a QR it never explained; it must not return.
    expect(html).not.toContain("Create my first QR");
    // Still on the last step, so there is no skip — finishing *is* the action.
    expect(html).not.toContain("Skip to dashboard");
  });

  it("skips onboarding: marks onboarded and redirects to /app", async () => {
const user = await createUser(env.DB, `obs-${crypto.randomUUID()}@example.com`);
      const setCookie = await startSession(env, user.id);
      const cookie = setCookie.split(";")[0];

      const res = await onboarding.fetch(
        new Request("https://q.test/onboarding/skip", {
          method: "POST",
          headers: { Cookie: cookie },
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/app");

      const updated = await env.DB.prepare(
        "SELECT onboarded_at FROM users WHERE id = ?",
      )
        .bind(user.id)
        .first<{ onboarded_at: number | null }>();
      expect(updated?.onboarded_at).toBeTypeOf("number");
  });
});
