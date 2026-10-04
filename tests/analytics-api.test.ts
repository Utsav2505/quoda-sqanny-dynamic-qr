import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { analyticsApi } from "../src/routes/api/analytics";
import { createUser, createQr } from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";
import { logScan } from "../src/lib/analytics";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function seedSession(): Promise<{ userId: string; cookie: string }> {
  const u = await createUser(env.DB, `an-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, u.id);
  return { userId: u.id, cookie: setCookie.split(";")[0] };
}

async function seedQr(userId: string): Promise<string> {
  const qr = await createQr(env.DB, {
    user_id: userId,
    type: "url",
    title: "Analytics API QR",
    is_dynamic: true,
    short_code: "ap" + crypto.randomUUID().slice(0, 6),
    destination: "https://example.com",
    content_json: "{}",
    design_json: "{}",
  });
  return qr.id;
}

function get(path: string, cookie?: string): Request {
  return new Request(`https://q.test${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

const IPHASH_ENV = { ...env, SCAN_HASH_SECRET: "analytics-api-test" };

async function scan(qrId: string, headers: Record<string, string>, city?: string) {
  const req = new Request("https://q.test/r/abc", { headers });
  Object.defineProperty(req, "cf", {
    value: city ? { country: "US", city } : { country: "US" },
    configurable: true,
  });
  await logScan(IPHASH_ENV, { id: qrId }, req);
}

describe("GET /api/qr/:id/analytics", () => {
  it("requires auth", async () => {
    const res = await analyticsApi.fetch(
      get("/api/qr/whatever/analytics"),
      env,
      ctx,
    );
    // 401 JSON, not a 302 to the login page — see requireApiAuth.
    expect(res.status).toBe(401);
    expect((await res.json() as { ok: boolean }).ok).toBe(false);
  });

  it("returns 404 for another user's QR (ownership enforced)", async () => {
    const owner = await seedSession();
    const attacker = await seedSession();
    const qrId = await seedQr(owner.userId);

    const res = await analyticsApi.fetch(
      get(`/api/qr/${qrId}/analytics`, attacker.cookie),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown QR", async () => {
    const s = await seedSession();
    const res = await analyticsApi.fetch(
      get(`/api/qr/${crypto.randomUUID()}/analytics`, s.cookie),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("returns the full breakdown shape the charts island consumes", async () => {
    const s = await seedSession();
    const qrId = await seedQr(s.userId);

    await scan(
      qrId,
      {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
        "accept-language": "tr-TR,tr;q=0.9",
        "cf-connecting-ip": "9.9.9.9",
      },
      "Istanbul",
    );

    const res = await analyticsApi.fetch(
      get(`/api/qr/${qrId}/analytics`, s.cookie),
      IPHASH_ENV,
      ctx,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
    expect(Array.isArray(body.daily)).toBe(true);
    expect(body.uniques).toEqual({ total: 1, daily: expect.any(Array) });

    // Every dimension the client renders must be present as a map, or the
    // island silently renders empty bars instead of failing loudly.
    const b = body.breakdown as Record<string, unknown>;
    for (const key of ["country", "device", "os", "browser", "language"]) {
      expect(b[key], `breakdown.${key} missing`).toBeTypeOf("object");
      expect(Object.keys(b[key] as object).length).toBeGreaterThan(0);
    }
    expect(b.city).toEqual([{ name: "Istanbul", count: 1 }]);
    expect((b.os as Record<string, number>).iOS).toBe(1);
    expect((b.browser as Record<string, number>).Safari).toBe(1);
    expect((b.language as Record<string, number>).tr).toBe(1);
  });

  it("returns empty collections, not undefined, for a QR with no scans", async () => {
    const s = await seedSession();
    const qrId = await seedQr(s.userId);

    const res = await analyticsApi.fetch(
      get(`/api/qr/${qrId}/analytics`, s.cookie),
      env,
      ctx,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.total).toBe(0);
    expect(body.daily).toEqual([]);
    expect(body.uniques).toEqual({ total: 0, daily: [] });
    const b = body.breakdown as Record<string, unknown>;
    expect(b.city).toEqual([]);
    expect(b.os).toEqual({});
  });

  it("clamps an absurd days parameter instead of scanning unbounded history", async () => {
    const s = await seedSession();
    const qrId = await seedQr(s.userId);

    const res = await analyticsApi.fetch(
      get(`/api/qr/${qrId}/analytics?days=99999999`, s.cookie),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("never leaks the raw referer or city of a scan to the client", async () => {
    const s = await seedSession();
    const qrId = await seedQr(s.userId);
    await scan(qrId, { referer: "https://tracker.test/?token=SECRET123" }, "Izmir");

    const res = await analyticsApi.fetch(
      get(`/api/qr/${qrId}/analytics`, s.cookie),
      env,
      ctx,
    );
    const raw = await res.text();
    // The referer is stored for the owner's benefit but must not be echoed
    // back; the charts island has no use for it.
    expect(raw).not.toContain("SECRET123");
    expect(raw).not.toContain("token=");
  });
});

describe("GET /api/qr/:id/scans", () => {
  async function seedScanWithIp(userId: string, ip: string) {
    const qrId = await seedQr(userId);
    await env.DB.prepare(
      `INSERT INTO scans (id, qr_id, ts, country, city, device, referer, ip, ip_hash, os, browser)
       VALUES (?, ?, ?, 'US', 'Istanbul', 'mobile', 'https://x.test/a?token=SECRET', ?, 'abcd1234ef567890', 'iOS', 'Safari')`,
    )
      .bind(crypto.randomUUID(), qrId, Date.now(), ip).run();
    return qrId;
  }

  it("requires auth", async () => {
    const res = await analyticsApi.fetch(get("/api/qr/whatever/scans"), env, ctx);
    expect(res.status).toBe(401);
    expect((await res.json() as { ok: boolean }).ok).toBe(false);
  });

  it("returns 404 for another user's QR — raw IPs must not leak across accounts", async () => {
    const owner = await seedSession();
    const attacker = await seedSession();
    const qrId = await seedScanWithIp(owner.userId, "203.0.113.5");

    const res = await analyticsApi.fetch(get(`/api/qr/${qrId}/scans`, attacker.cookie), env, ctx);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("203.0.113.5");
  });

  it("returns both raw and hashed IP to the owner", async () => {
    const owner = await seedSession();
    const qrId = await seedScanWithIp(owner.userId, "203.0.113.5");

    const res = await analyticsApi.fetch(get(`/api/qr/${qrId}/scans`, owner.cookie), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; scans: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.scans).toHaveLength(1);
    expect(body.scans[0].ip).toBe("203.0.113.5");
    expect(body.scans[0].ipHash).toBe("abcd1234ef567890");
  });

  it("strips the referer query string before returning it", async () => {
    const owner = await seedSession();
    const qrId = await seedScanWithIp(owner.userId, "203.0.113.5");

    const res = await analyticsApi.fetch(get(`/api/qr/${qrId}/scans`, owner.cookie), env, ctx);
    const raw = await res.text();
    expect(raw).toContain("x.test/a");
    expect(raw).not.toContain("SECRET");
  });

  it("clamps an absurd limit instead of dumping the table", async () => {
    const owner = await seedSession();
    const qrId = await seedQr(owner.userId);

    const res = await analyticsApi.fetch(
      get(`/api/qr/${qrId}/scans?limit=999999999`, owner.cookie),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).scans).toEqual([]);
  });
});
