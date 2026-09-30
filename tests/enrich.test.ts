import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { enrichApi } from "../src/routes/api/enrich";
import { createUser, createQr } from "../src/db/queries";
import { logScan } from "../src/lib/analytics";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

/** Hosted app origin — the redirect only sets the cookie for these. */
const APP = env.APP_URL;

async function seedQr(destination: string): Promise<string> {
  const u = await createUser(env.DB, `en-${crypto.randomUUID()}@example.com`);
  const qr = await createQr(env.DB, {
    user_id: u.id,
    type: "social",
    title: "Enrich QR",
    is_dynamic: true,
    short_code: "en" + crypto.randomUUID().slice(0, 6),
    destination,
    content_json: "{}",
    design_json: "{}",
  });
  return qr.id;
}

/** Create a real scan row and return its id, mirroring what the redirect does. */
async function seedScan(qrId: string, scanId = crypto.randomUUID()): Promise<string> {
  const req = new Request("https://q.test/r/abc", {
    headers: { "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1" },
  });
  await logScan(env, { id: qrId }, req, scanId);
  return scanId;
}

function post(
  body: unknown,
  opts: { cookie?: string; origin?: string } = {},
): Request {
  return new Request("https://q.test/api/enrich", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.origin ? { Origin: opts.origin } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = {
  screen_w: 390,
  screen_h: 844,
  viewport_w: 390,
  viewport_h: 700,
  dpr: 3,
  color_depth: 24,
  touch_points: 5,
  timezone: "Europe/Istanbul",
  hardware_concurrency: 8,
  device_memory: 4,
};

async function rowFor(scanId: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM scans WHERE id = ?")
    .bind(scanId)
    .first<Record<string, unknown>>();
}

describe("POST /api/enrich", () => {
  it("writes client measurements onto the correlated scan", async () => {
    const qrId = await seedQr(`${APP}/p/abc123`);
    const scanId = await seedScan(qrId);

    const res = await enrichApi.fetch(
      post(VALID, { cookie: `sqanny_scan=${scanId}` }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);

    const row = await rowFor(scanId);
    expect(row?.screen_w).toBe(390);
    expect(row?.screen_h).toBe(844);
    expect(row?.dpr).toBe(3);
    expect(row?.timezone).toBe("Europe/Istanbul");
    expect(row?.hardware_concurrency).toBe(8);
  });

  it("clears the correlation cookie so the token is single-use", async () => {
    const qrId = await seedQr(`${APP}/p/abc123`);
    const scanId = await seedScan(qrId);

    const res = await enrichApi.fetch(
      post(VALID, { cookie: `sqanny_scan=${scanId}` }),
      env,
      ctx,
    );
    expect(res.headers.get("set-cookie") ?? "").toContain("sqanny_scan=;");
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("is idempotent: a repeat call writes the same values", async () => {
    const qrId = await seedQr(`${APP}/p/abc123`);
    const scanId = await seedScan(qrId);
    const cookie = `sqanny_scan=${scanId}`;

    await enrichApi.fetch(post(VALID, { cookie }), env, ctx);
    const first = await rowFor(scanId);
    await enrichApi.fetch(post(VALID, { cookie }), env, ctx);
    const second = await rowFor(scanId);

    expect(second?.screen_w).toBe(first?.screen_w);
    expect(second?.timezone).toBe(first?.timezone);
  });

  describe("token handling", () => {
    it("rejects a request with no cookie", async () => {
      const res = await enrichApi.fetch(post(VALID), env, ctx);
      expect(res.status).toBe(400);
    });

    it("rejects a non-UUID cookie value", async () => {
      for (const bad of ["not-a-uuid", "../../etc/passwd", "'; DROP TABLE scans;--"]) {
        const res = await enrichApi.fetch(
          post(VALID, { cookie: `sqanny_scan=${encodeURIComponent(bad)}` }),
          env,
          ctx,
        );
        expect(res.status).toBe(400);
      }
    });

    it("rejects a well-formed token for a scan that does not exist", async () => {
      const res = await enrichApi.fetch(
        post(VALID, { cookie: `sqanny_scan=${crypto.randomUUID()}` }),
        env,
        ctx,
      );
      expect(res.status).toBe(404);
    });

    it("rejects a token for a scan older than the enrichment window", async () => {
      const qrId = await seedQr(`${APP}/p/abc123`);
      const scanId = await seedScan(qrId);
      // Age the row past the 30-minute window.
      await env.DB.prepare("UPDATE scans SET ts = ? WHERE id = ?")
        .bind(Date.now() - 60 * 60 * 1000, scanId)
        .run();

      const res = await enrichApi.fetch(
        post(VALID, { cookie: `sqanny_scan=${scanId}` }),
        env,
        ctx,
      );
      expect(res.status).toBe(404);
    });

    it("refuses to enrich a scan whose destination is external", async () => {
      // This is the case the redirect never issues a cookie for, so a forged
      // cookie must not be able to attach client data to it.
      const qrId = await seedQr("https://example.com/landing");
      const scanId = await seedScan(qrId);

      const res = await enrichApi.fetch(
        post(VALID, { cookie: `sqanny_scan=${scanId}` }),
        env,
        ctx,
      );
      expect(res.status).toBe(404);

      const row = await rowFor(scanId);
      expect(row?.screen_w).toBeNull();
    });
  });

  describe("payload validation", () => {
    async function enrichWith(body: unknown): Promise<Record<string, unknown> | null> {
      const qrId = await seedQr(`${APP}/p/abc123`);
      const scanId = await seedScan(qrId);
      await enrichApi.fetch(post(body, { cookie: `sqanny_scan=${scanId}` }), env, ctx);
      return rowFor(scanId);
    }

    it("clamps out-of-range numbers instead of writing them", async () => {
      const row = await enrichWith({
        screen_w: 99_999_999,
        dpr: -50,
        viewport_h: 1e12,
        touch_points: 5000,
      });
      expect(row?.screen_w).toBe(20000);
      expect(row?.dpr).toBe(0);
      expect(row?.viewport_h).toBe(20000);
      expect(row?.touch_points).toBe(20);
    });

    it("cannot overwrite server-owned columns", async () => {
      const qrId = await seedQr(`${APP}/p/abc123`);
      const scanId = await seedScan(qrId);
      const before = await rowFor(scanId);

      // An attacker with a valid token tries to rewrite who scanned, when, and
      // from where. None of these are in the client allowlist.
      const res = await enrichApi.fetch(
        post(
          {
            screen_w: 390,
            qr_id: "someone-elses-code",
            ts: 0,
            country: "XX",
            city: "Nowhere",
            os: "Windows",
            browser: "Fake",
            device: "desktop",
            ip_hash: "forged-hash",
            referer: "https://evil.test/",
          },
          { cookie: `sqanny_scan=${scanId}` },
        ),
        env,
        ctx,
      );
      expect(res.status).toBe(204);

      const after = await rowFor(scanId);
      // The one client field landed...
      expect(after?.screen_w).toBe(390);
      // ...and every server-owned column is untouched.
      expect(after?.qr_id).toBe(before?.qr_id);
      expect(after?.qr_id).toBe(qrId);
      expect(after?.ts).toBe(before?.ts);
      expect(after?.country).toBe(before?.country);
      expect(after?.city).toBe(before?.city);
      expect(after?.os).toBe(before?.os);
      expect(after?.browser).toBe(before?.browser);
      expect(after?.device).toBe(before?.device);
      expect(after?.ip_hash).toBe(before?.ip_hash);
      expect(after?.referer).toBe(before?.referer);
    });

    it("ignores non-numeric values for numeric fields", async () => {
      const row = await enrichWith({
        screen_w: "huge",
        dpr: null,
        color_depth: {},
        touch_points: [],
      });
      expect(row?.screen_w).toBeNull();
      expect(row?.dpr).toBeNull();
      expect(row?.color_depth).toBeNull();
      expect(row?.touch_points).toBeNull();
    });

    it("truncates an oversized timezone and rejects a malformed one", async () => {
      const long = await enrichWith({ timezone: "A".repeat(500) });
      expect((long?.timezone as string).length).toBe(64);

      const bad = await enrichWith({ timezone: "not a timezone!" });
      expect(bad?.timezone).toBeNull();
    });

    it("only accepts geolocation when BOTH coordinates are present and in range", async () => {
      const ok = await enrichWith({
        geo_lat: 41.0082, geo_lon: 28.9784, geo_accuracy_m: 25,
      });
      expect(ok?.geo_lat).toBeCloseTo(41.0082, 3);
      expect(ok?.geo_lon).toBeCloseTo(28.9784, 3);

      // Latitude only — no longitude, so nothing is written.
      const half = await enrichWith({ geo_lat: 41.0082 });
      expect(half?.geo_lat).toBeNull();
      expect(half?.geo_lon).toBeNull();

      // Out of range.
      const bogus = await enrichWith({ geo_lat: 999, geo_lon: 999 });
      expect(bogus?.geo_lat).toBe(90);
      expect(bogus?.geo_lon).toBe(180);
    });

    it("tolerates a malformed or empty body without erroring", async () => {
      for (const body of ["not json", "", "[]", "null"]) {
        const qrId = await seedQr(`${APP}/p/abc123`);
        const scanId = await seedScan(qrId);
        const res = await enrichApi.fetch(
          post(body, { cookie: `sqanny_scan=${scanId}` }),
          env,
          ctx,
        );
        expect(res.status).toBe(204);
      }
    });
  });

  describe("abuse controls", () => {
    it("rejects a cross-origin Origin header", async () => {
      const qrId = await seedQr(`${APP}/p/abc123`);
      const scanId = await seedScan(qrId);
      const res = await enrichApi.fetch(
        post(VALID, { cookie: `sqanny_scan=${scanId}`, origin: "https://evil.test" }),
        env,
        ctx,
      );
      expect(res.status).toBe(403);
    });

    it("accepts a same-origin Origin header", async () => {
      const qrId = await seedQr(`${APP}/p/abc123`);
      const scanId = await seedScan(qrId);
      const res = await enrichApi.fetch(
        post(VALID, { cookie: `sqanny_scan=${scanId}`, origin: APP }),
        env,
        ctx,
      );
      expect(res.status).toBe(204);
    });

    it("rate-limits after the per-IP cap", async () => {
      const qrId = await seedQr(`${APP}/p/abc123`);
      const scanId = await seedScan(qrId);
      const cookie = `sqanny_scan=${scanId}`;

      let limited = 0;
      for (let i = 0; i < 40; i++) {
        const res = await enrichApi.fetch(post(VALID, { cookie }), env, ctx);
        if (res.status === 429) limited++;
      }
      expect(limited).toBeGreaterThan(0);
    });
  });
});
