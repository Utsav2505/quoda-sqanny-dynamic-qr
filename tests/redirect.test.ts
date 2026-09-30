import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { redirect } from "../src/routes/redirect";
import { isHostedDestination } from "../src/lib/analytics";
import { createUser, createQr, updateQr } from "../src/db/queries";

// Minimal ExecutionContext: waitUntil runs the promise synchronously enough for
// the test to observe its side effects after the response resolves.
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(Promise.resolve(p));
    },
    passThroughOnException() {},
    async _drain() {
      await Promise.all(pending);
    },
  };
  return ctx;
}

async function seedDynamicQr(code: string, destination: string): Promise<string> {
  const user = await createUser(env.DB, `rd-${crypto.randomUUID()}@example.com`);
  const qr = await createQr(env.DB, {
    user_id: user.id,
    type: "url",
    title: "Redirect QR",
    is_dynamic: true,
    short_code: code,
    destination,
    content_json: "{}",
    design_json: "{}",
  });
  return qr.id;
}

describe("GET /r/:code", () => {
  it("returns 404 for an unknown short code", async () => {
    const ctx = makeCtx();
    const res = await redirect.fetch(
      new Request("https://q.test/r/unknown123"),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it("302-redirects a known code to its destination and increments the counter", async () => {
    const code = "rdir" + crypto.randomUUID().slice(0, 6);
    const dest = "https://example.com/landing";
    const qrId = await seedDynamicQr(code, dest);

    const ctx = makeCtx();
    const res = await redirect.fetch(
      new Request(`https://q.test/r/${code}`, {
        headers: { "user-agent": "Mozilla/5.0 (iPhone) Mobile Safari" },
      }),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(dest);

    // Allow the waitUntil scan log to finish, then assert the counter moved.
    await ctx._drain();
    const total = await env.SCAN_COUNTERS.get(`qr:${qrId}:total`);
    expect(Number(total)).toBe(1);

    const scanRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM scans WHERE qr_id = ?",
    )
      .bind(qrId)
      .first<{ n: number }>();
    expect(scanRow?.n).toBe(1);
  });

  it("renders the claim page when the code exists but has no destination", async () => {
    const code = "nodst" + crypto.randomUUID().slice(0, 6);
    const qrId = await seedDynamicQr(code, "https://temp");
    await updateQr(env.DB, qrId, { destination: null });

    const ctx = makeCtx();
    const res = await redirect.fetch(
      new Request(`https://q.test/r/${code}`),
      env,
      ctx as unknown as ExecutionContext,
    );
    // Behaviour change: an unset destination used to 404. It now offers to set
    // one, which is the point of the deferred-destination feature.
    expect(res.status).toBe(200);
    const html = await res.text();
    // Asserted without the apostrophe so the test does not couple itself to
    // however the renderer happens to encode it.
    expect(html).toContain("been given a destination");
    expect(html).toContain("Sign in to set the destination");
    // Signed out, so the form must NOT be rendered — only the sign-in CTA.
    expect(html).not.toContain('name="url"');
  });

  it("editing the destination changes the redirect target (same short code)", async () => {
    const code = "edit" + crypto.randomUUID().slice(0, 6);
    const qrId = await seedDynamicQr(code, "https://old.example.com");
    await updateQr(env.DB, qrId, { destination: "https://new.example.com" });

    const ctx = makeCtx();
    const res = await redirect.fetch(
      new Request(`https://q.test/r/${code}`),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://new.example.com");

    // Drain the waitUntil scan log so storage writes complete inside the
    // isolated-storage frame for this test.
    await ctx._drain();
  });
});

describe("GET /r/:code — scan correlation cookie", () => {
  it("sets an HttpOnly correlation cookie for hosted /p/ destinations", async () => {
    const code = "host" + crypto.randomUUID().slice(0, 6);
    const dest = `${env.APP_URL}/p/${code}`;
    await seedDynamicQr(code, dest);

    const ctx = makeCtx();
    const res = await redirect.fetch(
      new Request(`https://q.test/r/${code}`),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(dest);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("sqanny_scan=");
    // HttpOnly keeps the value unreadable to any injected script; the enrichment
    // beacon still carries it because it is a same-origin request.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");

    await ctx._drain();
  });

  it("the cookie value matches the scans row id, so enrichment can correlate", async () => {
    const code = "corr" + crypto.randomUUID().slice(0, 6);
    const qrId = await seedDynamicQr(code, `${env.APP_URL}/p/${code}`);

    const ctx = makeCtx();
    const res = await redirect.fetch(
      new Request(`https://q.test/r/${code}`),
      env,
      ctx as unknown as ExecutionContext,
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    const scanId = /sqanny_scan=([^;]+)/.exec(cookie)?.[1];
    expect(scanId).toBeTruthy();

    await ctx._drain();
    const row = await env.DB.prepare(
      "SELECT id FROM scans WHERE qr_id = ?",
    )
      .bind(qrId)
      .first<{ id: string }>();
    expect(row?.id).toBe(scanId);
  });

  it("sets NO cookie for external destinations (response unchanged)", async () => {
    const code = "ext" + crypto.randomUUID().slice(0, 6);
    const dest = "https://example.com/p/looks-like-hosted";
    await seedDynamicQr(code, dest);

    const ctx = makeCtx();
    const res = await redirect.fetch(
      new Request(`https://q.test/r/${code}`),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(dest);
    expect(res.headers.get("set-cookie")).toBeNull();

    await ctx._drain();
  });

  it("treats a lookalike host with a /p/ path as external", async () => {
    const code = "look" + crypto.randomUUID().slice(0, 6);
    await seedDynamicQr(code, "https://evil.test/p/x");

    const ctx = makeCtx();
    const res = await redirect.fetch(
      new Request(`https://q.test/r/${code}`),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(res.headers.get("set-cookie")).toBeNull();
    await ctx._drain();
  });
});

describe("GET /r/:code — latency budget", () => {
  /**
   * The redirect must not depend on any analytics I/O. If a future change adds
   * an await for KV/D1 enrichment on the hot path, this fails.
   *
   * The assertion is structural rather than a wall-clock threshold: timing
   * assertions are flaky in CI, but "the response is fully formed before any
   * waitUntil task settles" is a hard invariant and is deterministic.
   */
  it("resolves the 302 before any waitUntil task completes", async () => {
    const code = "fast" + crypto.randomUUID().slice(0, 6);
    await seedDynamicQr(code, `${env.APP_URL}/p/${code}`);

    let settled = 0;
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        pending.push(Promise.resolve(p).then(() => { settled++; }));
      },
      passThroughOnException() {},
    };

    const res = await redirect.fetch(
      new Request(`https://q.test/r/${code}`),
      env,
      ctx as unknown as ExecutionContext,
    );

    // Response is complete while the background logging is still in flight.
    expect(res.status).toBe(302);
    expect(settled).toBe(0);

    await Promise.all(pending);
    expect(settled).toBe(1);
  });

  it("adds no Set-Cookie work for the common external-destination case", async () => {
    const code = "raw" + crypto.randomUUID().slice(0, 6);
    await seedDynamicQr(code, "https://example.com/");

    const ctx = makeCtx();
    const res = await redirect.fetch(
      new Request(`https://q.test/r/${code}`),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toBeNull();
    await ctx._drain();
  });
});

describe("isHostedDestination", () => {
  it("accepts same-origin /p/ paths", () => {
    expect(isHostedDestination("https://app.test/p/abc", "https://app.test")).toBe(true);
  });

  it("rejects external hosts, other paths, and malformed URLs", () => {
    expect(isHostedDestination("https://evil.test/p/abc", "https://app.test")).toBe(false);
    expect(isHostedDestination("https://app.test/r/abc", "https://app.test")).toBe(false);
    expect(isHostedDestination("not-a-url", "https://app.test")).toBe(false);
    expect(isHostedDestination("/p/abc", "not-a-url")).toBe(false);
  });
});
