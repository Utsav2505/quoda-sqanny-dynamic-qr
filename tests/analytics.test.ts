import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import {
  logScan,
  getTotals,
  getDaily,
  getBreakdown,
  getUniques,
  getScans,
  refererLabel,
  deviceFromUA,
} from "../src/lib/analytics";

const day = new Date().toISOString().slice(0, 10);

async function seedQr(): Promise<string> {
  const userId = crypto.randomUUID();
  const qrId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, plan_id, created_at) VALUES (?,?,?,?)",
  )
    .bind(userId, `an-${userId}@example.com`, "free", now)
    .run();
  await env.DB.prepare(
    `INSERT INTO qr_codes (id, user_id, type, title, is_dynamic, short_code, destination, content_json, design_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(qrId, userId, "url", "Analytics QR", 1, null, "https://example.com", "{}", "{}", now, now)
    .run();
  return qrId;
}

function mobileRequest(country = "US", city = "NYC"): Request {
  const req = new Request("https://q.test/r/abc", {
    headers: {
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      referer: "https://twitter.com/",
    },
  });
  // request.cf is read-only on the Request prototype; attach for the test.
  Object.defineProperty(req, "cf", {
    value: { country, city },
    configurable: true,
  });
  return req;
}

describe("deviceFromUA", () => {
  it("classifies mobile, tablet, desktop and null", () => {
    expect(deviceFromUA("iPhone Mobile Safari")).toBe("mobile");
    expect(deviceFromUA("Mozilla/5.0 (iPad; CPU OS 17_0) Safari")).toBe("tablet");
    expect(deviceFromUA("Mozilla/5.0 (Macintosh) Chrome Safari")).toBe("desktop");
    expect(deviceFromUA(null)).toBe("desktop");
  });
});

// Each test is self-contained because the worker test pool uses isolated
// storage per test (DB + KV writes do not leak across `it` blocks).

describe("logScan", () => {
  it("increments KV total + day counters", async () => {
    const qrId = await seedQr();
    await logScan(env, { id: qrId }, mobileRequest());
    await logScan(env, { id: qrId }, mobileRequest());

    const total = await env.SCAN_COUNTERS.get(`qr:${qrId}:total`);
    const dayCount = await env.SCAN_COUNTERS.get(`qr:${qrId}:${day}`);
    expect(Number(total)).toBe(2);
    expect(Number(dayCount)).toBe(2);

    expect(await getTotals(env, qrId)).toBe(2);
  });

  it("inserts scans rows with derived fields", async () => {
    const qrId = await seedQr();
    await logScan(env, { id: qrId }, mobileRequest());
    await logScan(env, { id: qrId }, mobileRequest());

    const row = await env.DB.prepare(
      "SELECT * FROM scans WHERE qr_id = ? ORDER BY ts DESC LIMIT 1",
    )
      .bind(qrId)
      .first<{ country: string; city: string; device: string; referer: string; ts: number }>();
    expect(row?.country).toBe("US");
    expect(row?.city).toBe("NYC");
    expect(row?.device).toBe("mobile");
    expect(row?.referer).toBe("https://twitter.com/");
    expect(row?.ts).toBeGreaterThan(0);

    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM scans WHERE qr_id = ?",
    )
      .bind(qrId)
      .first<{ n: number }>();
    expect(countRow?.n).toBe(2);
  });

  it("upserts scan_daily aggregate (count accumulates)", async () => {
    const qrId = await seedQr();
    await logScan(env, { id: qrId }, mobileRequest());
    await logScan(env, { id: qrId }, mobileRequest());

    const row = await env.DB.prepare(
      "SELECT count FROM scan_daily WHERE qr_id = ? AND day = ? AND country = ? AND device = ?",
    )
      .bind(qrId, day, "US", "mobile")
      .first<{ count: number }>();
    expect(row?.count).toBe(2);
  });

  it("getDaily returns aggregated rows", async () => {
    const qrId = await seedQr();
    await logScan(env, { id: qrId }, mobileRequest());
    await logScan(env, { id: qrId }, mobileRequest());

    const daily = await getDaily(env, qrId, 30);
    const found = daily.find((d) => d.day === day);
    expect(found?.count).toBe(2);
  });

  it("getBreakdown returns country + device maps", async () => {
    const qrId = await seedQr();
    await logScan(env, { id: qrId }, mobileRequest());
    await logScan(env, { id: qrId }, mobileRequest());

    const b = await getBreakdown(env, qrId);
    expect(b.country.US).toBe(2);
    expect(b.device.mobile).toBe(2);
  });
});

describe("logScan device + cf fallbacks", () => {
  it("falls back to null country/city when cf absent and detects desktop", async () => {
    const qrId = await seedQr();
    const req = new Request("https://q.test/r/xyz", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });
    await logScan(env, { id: qrId }, req);

    const row = await env.DB.prepare(
      "SELECT country, city, device, referer FROM scans WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<{ country: string | null; city: string | null; device: string; referer: string | null }>();
    expect(row?.country).toBeNull();
    expect(row?.city).toBeNull();
    expect(row?.device).toBe("desktop");
    expect(row?.referer).toBeNull();
  });

  it("detects tablet from an iPad user-agent", async () => {
    const qrId = await seedQr();
    const req = new Request("https://q.test/r/tab", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
      },
    });
    await logScan(env, { id: qrId }, req);
    const row = await env.DB.prepare(
      "SELECT device FROM scans WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<{ device: string }>();
    expect(row?.device).toBe("tablet");
  });
});

describe("logScan rich dimensions", () => {
  it("persists UA-derived OS, browser, versions and language", async () => {
    const qrId = await seedQr();
    const req = new Request("https://q.test/r/abc", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "accept-language": "tr-TR,tr;q=0.9,en;q=0.8",
      },
    });
    await logScan(env, { id: qrId }, req);

    const row = await env.DB.prepare(
      "SELECT device, os, os_version, browser, browser_version, language FROM scans WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<Record<string, string | null>>();
    expect(row?.device).toBe("mobile");
    expect(row?.os).toBe("iOS");
    expect(row?.os_version).toBe("17.0");
    expect(row?.browser).toBe("Safari");
    expect(row?.browser_version).toBe("17.0");
    // Region subtag stripped so tr-TR and tr cannot split into two rows.
    expect(row?.language).toBe("tr");
  });

  it("persists the extended Cloudflare geo fields, coercing strings to numbers", async () => {
    const qrId = await seedQr();
    const req = new Request("https://q.test/r/abc", {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0" },
    });
    Object.defineProperty(req, "cf", {
      value: {
        country: "TR",
        city: "Istanbul",
        continent: "EU",
        region: "Marmara",
        postalCode: "34110",
        latitude: "41.0082", // Cloudflare delivers these as strings
        longitude: "28.9784",
        asOrganization: "Turk Telekom",
      },
      configurable: true,
    });
    await logScan(env, { id: qrId }, req);

    const row = await env.DB.prepare(
      "SELECT continent, region, postal_code, latitude, longitude, as_org FROM scans WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<Record<string, string | number | null>>();
    expect(row?.continent).toBe("EU");
    expect(row?.region).toBe("Marmara");
    expect(row?.postal_code).toBe("34110");
    expect(row?.latitude).toBeCloseTo(41.0082, 4);
    expect(row?.longitude).toBeCloseTo(28.9784, 4);
    expect(row?.as_org).toBe("Turk Telekom");
  });

  it("leaves client-side enrichment columns NULL until /api/enrich runs", async () => {
    const qrId = await seedQr();
    await logScan(env, { id: qrId }, mobileRequest());

    const row = await env.DB.prepare(
      `SELECT screen_w, viewport_w, dpr, timezone, geo_lat, geo_lon
         FROM scans WHERE qr_id = ? LIMIT 1`,
    )
      .bind(qrId)
      .first<Record<string, unknown>>();
    for (const [k, v] of Object.entries(row ?? {})) {
      expect(v, `${k} should be NULL before enrichment`).toBeNull();
    }
  });

  it("stores ip_hash when a secret is configured, and never the raw address", async () => {
    const qrId = await seedQr();
    const req = new Request("https://q.test/r/abc", {
      headers: {
        "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1",
        "cf-connecting-ip": "1.2.3.4",
      },
    });
    // vitest-pool-workers injects .dev.vars, so the secret is present.
    await logScan({ ...env, SCAN_HASH_SECRET: "unit-test-secret" }, { id: qrId }, req);

    const row = await env.DB.prepare(
      "SELECT ip_hash FROM scans WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<{ ip_hash: string | null }>();
    expect(row?.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(row?.ip_hash).not.toContain("1.2.3.4");
  });

  it("stores NULL ip_hash when no secret is configured", async () => {
    const qrId = await seedQr();
    const req = new Request("https://q.test/r/abc", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    await logScan({ ...env, SCAN_HASH_SECRET: undefined }, { id: qrId }, req);

    const row = await env.DB.prepare(
      "SELECT ip_hash FROM scans WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<{ ip_hash: string | null }>();
    expect(row?.ip_hash).toBeNull();
  });

  it("uses the caller-supplied scan id so the cookie can be correlated", async () => {
    const qrId = await seedQr();
    const scanId = crypto.randomUUID();
    await logScan(env, { id: qrId }, mobileRequest(), scanId);

    const row = await env.DB.prepare(
      "SELECT id FROM scans WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<{ id: string }>();
    expect(row?.id).toBe(scanId);
  });

  it("separates scan_daily rows by OS and browser, not just country", async () => {
    const qrId = await seedQr();
    await logScan(env, { id: qrId }, mobileRequest());

    const desktop = new Request("https://q.test/r/abc", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    Object.defineProperty(desktop, "cf", { value: { country: "US" }, configurable: true });
    await logScan(env, { id: qrId }, desktop);

    const rows = await env.DB.prepare(
      "SELECT os, browser, count FROM scan_daily WHERE qr_id = ?",
    )
      .bind(qrId)
      .all<{ os: string; browser: string; count: number }>();

    expect(rows.results).toHaveLength(2);
    expect(rows.results.find((r) => r.os === "iOS")?.browser).toBe("Safari");
    expect(rows.results.find((r) => r.os === "Windows")?.browser).toBe("Chrome");
  });

  it("clips oversized free-text dimensions instead of storing them whole", async () => {
    const qrId = await seedQr();
    const req = new Request("https://q.test/r/abc", {
      headers: { "referer": `https://evil.test/${"a".repeat(2000)}` },
    });
    Object.defineProperty(req, "cf", {
      value: { city: "C".repeat(500) },
      configurable: true,
    });
    await logScan(env, { id: qrId }, req);

    const row = await env.DB.prepare(
      "SELECT city, referer FROM scans WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<{ city: string; referer: string }>();
    expect(row?.city).toHaveLength(64);
    expect(row?.referer).toHaveLength(512);
  });
});

describe("logScan IP debug logging", () => {
  function withIp(ua: string): Request {
    return new Request("https://q.test/r/abc", {
      headers: { "user-agent": ua, "cf-connecting-ip": "203.0.113.77", referer: "https://x.test/" },
    });
  }

  it("stays silent by default (raw IP must never reach logs implicitly)", async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => {
      seen.push(a.join(" "));
    });
    try {
      const qrId = await seedQr();
      // Pinned explicitly rather than relying on env, because the test pool
      // loads .dev.vars and SCAN_LOG_IP may be set there for local debugging.
      await logScan(
        { ...env, SCAN_LOG_IP: undefined },
        { id: qrId },
        withIp("Mozilla/5.0 (iPhone) Mobile Safari"),
      );
    } finally {
      spy.mockRestore();
    }
    expect(seen.join("\n")).not.toContain("203.0.113.77");
  });

  it("stays silent when SCAN_LOG_IP is set to a falsy value", async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => {
      seen.push(a.join(" "));
    });
    try {
      const qrId = await seedQr();
      for (const v of ["0", "false", "no", ""]) {
        await logScan(
          { ...env, SCAN_LOG_IP: v },
          { id: qrId },
          withIp("Mozilla/5.0 (iPhone) Mobile Safari"),
        );
      }
    } finally {
      spy.mockRestore();
    }
    expect(seen.join("\n")).not.toContain("203.0.113.77");
  });

  it("logs the IP and parsed dimensions when enabled", async () => {
    const seen: string[] = [];
    const qrId = await seedQr();
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => {
      seen.push(a.join(" "));
    });
    try {
      const req = new Request("https://q.test/r/abc", {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
          "cf-connecting-ip": "203.0.113.77",
          "accept-language": "tr-TR,tr;q=0.9",
        },
      });
      await logScan({ ...env, SCAN_LOG_IP: "1" }, { id: qrId }, req);
    } finally {
      spy.mockRestore();
    }

    const line = seen.join("\n");
    expect(line).toContain("203.0.113.77");
    expect(line).toContain(`qr=${qrId}`);
    expect(line).toContain("os=iOS 17.0");
    expect(line).toContain("browser=Safari 17.0");
    expect(line).toContain("device=mobile");
    expect(line).toContain("lang=tr");
  });

  it("logs even without a hash secret (debugging must not depend on config)", async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => {
      seen.push(a.join(" "));
    });
    try {
      const qrId = await seedQr();
      await logScan(
        { ...env, SCAN_LOG_IP: "true", SCAN_HASH_SECRET: undefined },
        { id: qrId },
        withIp("Mozilla/5.0 (iPhone) Mobile Safari"),
      );
    } finally {
      spy.mockRestore();
    }
    expect(seen.join("\n")).toContain("203.0.113.77");
  });

  it("persists the raw IP, and keeps the hash distinct from it", async () => {
    // This is the opposite of the original assertion in this file, and
    // deliberately so: storing raw addresses was an explicit product decision
    // (migration 0003). The hash is still stored alongside because it is the
    // only field that survives dropping or anonymising the `ip` column.
    const qrId = await seedQr();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await logScan(
        { ...env, SCAN_LOG_IP: "1" },
        { id: qrId },
        withIp("Mozilla/5.0 (iPhone) Mobile Safari"),
      );
    } finally {
      spy.mockRestore();
    }
    const row = await env.DB.prepare(
      "SELECT ip, ip_hash FROM scans WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<{ ip: string | null; ip_hash: string | null }>();
    expect(row?.ip).toBe("203.0.113.77");
    expect(row?.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(row?.ip_hash).not.toContain("203.0.113.77");
  });
});

describe("getScans", () => {
  const IPHASH_ENV = { ...env, SCAN_HASH_SECRET: "scanlog-secret" };

  async function seed(qrId: string, headers: Record<string, string>, city?: string) {
    const req = new Request("https://q.test/r/abc", { headers });
    Object.defineProperty(req, "cf", {
      value: city ? { country: "US", city } : { country: "US" },
      configurable: true,
    });
    await logScan(IPHASH_ENV, { id: qrId }, req);
  }

  it("returns both the raw IP and the hash", async () => {
    const qrId = await seedQr();
    await seed(qrId, {
      "cf-connecting-ip": "198.51.100.9",
      "user-agent": "Mozilla/5.0 (iPhone) Mobile Safari",
    });

    const rows = await getScans(IPHASH_ENV, qrId);
    expect(rows).toHaveLength(1);
    expect(rows[0].ip).toBe("198.51.100.9");
    expect(rows[0].ipHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("stores a NULL ip when the request carries no address", async () => {
    const qrId = await seedQr();
    await seed(qrId, { "user-agent": "Mozilla/5.0 (iPhone) Mobile Safari" });
    const rows = await getScans(IPHASH_ENV, qrId);
    expect(rows[0].ip).toBeNull();
  });

  it("orders newest first", async () => {
    const qrId = await seedQr();
    await env.DB.prepare(
      `INSERT INTO scans (id, qr_id, ts, country, city, device, referer, ip)
       VALUES (?, ?, ?, 'US', 'NYC', 'mobile', NULL, '1.1.1.1')`,
    )
      .bind("old", qrId, 1_000).run();
    await env.DB.prepare(
      `INSERT INTO scans (id, qr_id, ts, country, city, device, referer, ip)
       VALUES (?, ?, ?, 'US', 'NYC', 'mobile', NULL, '2.2.2.2')`,
    )
      .bind("new", qrId, 9_000).run();

    const rows = await getScans(IPHASH_ENV, qrId);
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("clamps limit and rejects a negative offset", async () => {
    const qrId = await seedQr();
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare(
        `INSERT INTO scans (id, qr_id, ts, ip) VALUES (?, ?, ?, '1.1.1.1')`,
      )
        .bind(`s${i}`, qrId, 1000 + i).run();
    }
    expect(await getScans(IPHASH_ENV, qrId, 2)).toHaveLength(2);
    expect(await getScans(IPHASH_ENV, qrId, 10_000)).toHaveLength(5);
    expect(await getScans(IPHASH_ENV, qrId, 5, -50)).toHaveLength(5);
    // Offset past the end yields nothing rather than erroring.
    expect(await getScans(IPHASH_ENV, qrId, 5, 99)).toHaveLength(0);
  });

  it("paginates with offset", async () => {
    const qrId = await seedQr();
    for (let i = 0; i < 4; i++) {
      await env.DB.prepare(
        `INSERT INTO scans (id, qr_id, ts, ip) VALUES (?, ?, ?, '1.1.1.1')`,
      )
        .bind(`p${i}`, qrId, 2000 + i).run();
    }
    const page1 = await getScans(IPHASH_ENV, qrId, 2, 0);
    const page2 = await getScans(IPHASH_ENV, qrId, 2, 2);
    expect(page1.map((r) => r.id)).toEqual(["p3", "p2"]);
    expect(page2.map((r) => r.id)).toEqual(["p1", "p0"]);
  });

  it("returns [] for a QR with no scans", async () => {
    const qrId = await seedQr();
    expect(await getScans(IPHASH_ENV, qrId)).toEqual([]);
  });

  it("flags rows the client pass has enriched", async () => {
    const qrId = await seedQr();
    await seed(qrId, { "user-agent": "Mozilla/5.0 (iPhone) Mobile Safari" });
    const before = await getScans(IPHASH_ENV, qrId);
    expect(before[0].enriched).toBe(false);

    await env.DB.prepare("UPDATE scans SET screen_w = 390, timezone = 'Europe/Istanbul' WHERE qr_id = ?")
      .bind(qrId).run();
    const after = await getScans(IPHASH_ENV, qrId);
    expect(after[0].enriched).toBe(true);
  });

  it("surfaces precise geo only when the client pass wrote it", async () => {
    const qrId = await seedQr();
    await seed(qrId, { "user-agent": "Mozilla/5.0 (iPhone) Mobile Safari" }, "Izmir");
    expect((await getScans(IPHASH_ENV, qrId))[0].geoLat).toBeNull();

    await env.DB.prepare("UPDATE scans SET geo_lat = 41.01, geo_lon = 28.98, geo_accuracy_m = 30 WHERE qr_id = ?")
      .bind(qrId).run();
    const row = (await getScans(IPHASH_ENV, qrId))[0];
    expect(row.geoLat).toBeCloseTo(41.01, 2);
    expect(row.geoAccuracyM).toBe(30);
  });
});

describe("refererLabel", () => {
  it("keeps the host and first two path segments", () => {
    expect(refererLabel("https://www.instagram.com/explore/tags/foo/bar/baz")).toBe(
      "www.instagram.com/explore/tags",
    );
  });

  it("drops the query string and fragment, which can carry tokens", () => {
    // A referer routinely contains session ids, search terms and campaign tags.
    expect(refererLabel("https://app.test/page?token=SECRET&q=hello#frag")).toBe(
      "app.test/page",
    );
  });

  it("handles a bare host, trailing slashes, and null", () => {
    expect(refererLabel("https://example.com")).toBe("example.com");
    expect(refererLabel("https://example.com/")).toBe("example.com");
    expect(refererLabel("https://example.com/a/b/")).toBe("example.com/a/b");
    expect(refererLabel(null)).toBeNull();
    expect(refererLabel("")).toBeNull();
  });

  it("clips an unparseable referer instead of dropping it", () => {
    expect(refererLabel("not a url at all")).toBe("not a url at all");
    expect(refererLabel("x".repeat(200))).toHaveLength(48);
  });
});

describe("getBreakdown", () => {
  function scan(qrId: string, headers: Record<string, string>, city?: string): Promise<void> {
    const req = new Request("https://q.test/r/abc", { headers });
    Object.defineProperty(req, "cf", {
      value: city ? { country: "US", city } : { country: "US" },
      configurable: true,
    });
    return logScan(env, { id: qrId }, req);
  }

  it("breaks down os, browser and language alongside country and device", async () => {
    const qrId = await seedQr();
    await scan(qrId, {
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      "accept-language": "tr-TR,tr;q=0.9",
    });
    await scan(qrId, {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    });

    const b = await getBreakdown(env, qrId);
    expect(b.os.iOS).toBe(1);
    expect(b.os.Windows).toBe(1);
    expect(b.browser.Safari).toBe(1);
    expect(b.browser.Chrome).toBe(1);
    expect(b.language.tr).toBe(1);
    expect(b.language.en).toBe(1);
    expect(b.country.US).toBe(2);
    expect(b.device.mobile).toBe(1);
    expect(b.device.desktop).toBe(1);
  });

  it("returns empty maps for a QR with no scans rather than throwing", async () => {
    const qrId = await seedQr();
    const b = await getBreakdown(env, qrId);
    expect(b).toEqual({ country: {}, device: {}, os: {}, browser: {}, language: {}, city: [] });
  });

  it("folds missing dimensions into an 'unknown' key", async () => {
    const qrId = await seedQr();
    // No UA and no Accept-Language at all.
    await logScan(env, { id: qrId }, new Request("https://q.test/r/abc"));
    const b = await getBreakdown(env, qrId);
    expect(b.country.unknown).toBe(1);
    expect(b.language.unknown).toBe(1);
  });

  it("ranks top cities and caps the list", async () => {
    const qrId = await seedQr();
    await scan(qrId, {}, "Istanbul");
    await scan(qrId, {}, "Istanbul");
    await scan(qrId, {}, "Ankara");
    await scan(qrId, {}, "Izmir");

    const b = await getBreakdown(env, qrId);
    expect(b.city[0]).toEqual({ name: "Istanbul", count: 2 });
    expect(b.city.map((c) => c.name)).toEqual(["Istanbul", "Ankara", "Izmir"]);
  });

  it("excludes scans with no city from the city breakdown", async () => {
    const qrId = await seedQr();
    await scan(qrId, {});
    await scan(qrId, {}, "Izmir");
    const b = await getBreakdown(env, qrId);
    expect(b.city).toEqual([{ name: "Izmir", count: 1 }]);
  });
});

describe("getUniques", () => {
  const IPHASH_ENV = { ...env, SCAN_HASH_SECRET: "uniques-test-secret" };

  function withIp(ip: string): Request {
    return new Request("https://q.test/r/abc", {
      headers: { "cf-connecting-ip": ip, "user-agent": "Mozilla/5.0 (iPhone) Safari" },
    });
  }

  it("counts distinct scanners when a secret is configured", async () => {
    const qrId = await seedQr();
    await logScan(IPHASH_ENV, { id: qrId }, withIp("1.1.1.1"));
    await logScan(IPHASH_ENV, { id: qrId }, withIp("1.1.1.1"));
    await logScan(IPHASH_ENV, { id: qrId }, withIp("2.2.2.2"));

    const u = await getUniques(IPHASH_ENV, qrId, 30);
    // Three scans, two distinct addresses.
    expect(u.total).toBe(2);
  });

  it("returns zeros when no hash secret is configured", async () => {
    const qrId = await seedQr();
    // Write AND query without a secret. Querying with the secret stripped would
    // only be a no-op if the row was already written without one, so both
    // sides are pinned here rather than relying on ambient .dev.vars state.
    const noSecret = { ...env, SCAN_HASH_SECRET: undefined };
    await logScan(noSecret, { id: qrId }, withIp("1.1.1.1"));

    const row = await env.DB.prepare("SELECT ip_hash FROM scans WHERE qr_id = ? LIMIT 1")
      .bind(qrId)
      .first<{ ip_hash: string | null }>();
    expect(row?.ip_hash).toBeNull();

    const u = await getUniques(noSecret, qrId, 30);
    expect(u.total).toBe(0);
    expect(u.daily).toEqual([]);
  });

  it("returns zeros for a QR with no scans", async () => {
    const qrId = await seedQr();
    const u = await getUniques(IPHASH_ENV, qrId, 30);
    expect(u.total).toBe(0);
    expect(u.daily).toEqual([]);
  });

  it("buckets a scan under the same UTC day string the rest of the app uses", async () => {
    // The day in `getUniques` is derived by SQLite's date(), while
    // scan_daily uses JS toISOString(). If the two ever disagree, the uniques
    // chart silently misaligns against the scans-over-time chart with no error.
    const qrId = await seedQr();
    await logScan(IPHASH_ENV, { id: qrId }, withIp("1.1.1.1"));

    const u = await getUniques(IPHASH_ENV, qrId, 30);
    expect(u.daily.map((d) => d.day)).toEqual([day]);

    // Cross-check directly against the aggregate table's own day value.
    const row = await env.DB.prepare(
      "SELECT day FROM scan_daily WHERE qr_id = ? LIMIT 1",
    )
      .bind(qrId)
      .first<{ day: string }>();
    expect(u.daily[0].day).toBe(row?.day);
  });
});
