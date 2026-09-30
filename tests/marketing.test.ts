import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { marketing } from "../src/routes/marketing";
import { previewApi, RATE_LIMIT_MAX } from "../src/routes/api/preview";

// Minimal ExecutionContext for app.fetch.
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("marketing home", () => {
  it("renders 200 with the live generator input", async () => {
    const res = await marketing.fetch(
      new Request("http://x/"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    // The generator URL input (island target) is present.
    expect(html).toContain('id="gen-url"');
    expect(html).toContain("Your URL");
    // The preview surface the island injects into.
    expect(html).toContain('id="gen-preview-surface"');
    // The island script is wired up.
    expect(html).toContain('src="/js/generator.js"');
    // Tagline / voice.
    expect(html).toContain("The QR code that never breaks.");
  });

  it("hides the 'Make it permanent' CTA until the user types", async () => {
    const res = await marketing.fetch(new Request("http://x/"), env, ctx);
    const html = await res.text();

    // The CTA wrapper exists but is rendered hidden/inactive initially.
    const ctaIdx = html.indexOf('id="gen-cta"');
    expect(ctaIdx).toBeGreaterThan(-1);

    // Inspect the opening tag of the CTA wrapper: it must carry `hidden` and
    // aria-hidden="true" so it is inactive before the user types.
    const tagEnd = html.indexOf(">", ctaIdx);
    const openTag = html.slice(ctaIdx, tagEnd);
    expect(openTag).toContain("hidden");
    expect(openTag).toContain('aria-hidden="true"');

    // The CTA still links to /login for when it is revealed.
    expect(html).toContain('href="/login"');
    expect(html).toContain("Make it permanent");
  });

  it("serves features, pricing, use-cases and docs", async () => {
    for (const path of ["/features", "/pricing", "/use-cases", "/docs"]) {
      const res = await marketing.fetch(
        new Request(`http://x${path}`),
        env,
        ctx,
      );
      expect(res.status, `${path} should be 200`).toBe(200);
      const html = await res.text();
      expect(html.length).toBeGreaterThan(0);
    }
  });

  it("pricing shows the disabled Pro upgrade 'Coming in Cloud'", async () => {
    const res = await marketing.fetch(new Request("http://x/pricing"), env, ctx);
    const html = await res.text();
    expect(html).toContain("Coming in Cloud");
    expect(html).toContain("disabled");
  });

  it("docs include the real self-host commands", async () => {
    const res = await marketing.fetch(new Request("http://x/docs"), env, ctx);
    const html = await res.text();
    expect(html).toContain("npm run dev");
    expect(html).toContain("npm run migrate:local");
    expect(html).toContain("wrangler d1 create sqanny");
    expect(html).toContain("wrangler kv namespace create");
    expect(html).toContain("wrangler r2 bucket create");
  });
});

describe("POST /api/preview", () => {
  it("returns an svg string for a url", async () => {
    const res = await previewApi.fetch(
      new Request("http://x/api/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "1.2.3.4",
        },
        body: JSON.stringify({ type: "url", fields: { url: "example.com" } }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { svg?: string };
    expect(typeof data.svg).toBe("string");
    expect(data.svg).toContain("<svg");
    expect(data.svg).toContain("</svg>");
  });

  it("400s on an incomplete payload without crashing", async () => {
    const res = await previewApi.fetch(
      new Request("http://x/api/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "5.6.7.8",
        },
        body: JSON.stringify({ type: "url", fields: {} }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 429 once the per-IP cap is exceeded", async () => {
    // Unique IP so this test's window is isolated from the others.
    const ip = `9.9.9.${Math.floor(Math.random() * 254) + 1}`;
    const make = () =>
      previewApi.fetch(
        new Request("http://x/api/preview", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": ip,
          },
          body: JSON.stringify({ type: "url", fields: { url: "example.com" } }),
        }),
        env,
        ctx,
      );

    // Uses the real exported budget rather than a hardcoded number, so retuning
    // the cap does not silently turn this into a test that asserts nothing.
    // Sequential (KV read-modify-write) so the counter stays consistent.
    //
    // This is ~300 round trips, so it needs a real timeout: the default 5s is
    // not enough and the failure looks like a flake rather than a slow test.
    const statuses: number[] = [];
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      const res = await make();
      statuses.push(res.status);
    }

    // Everything inside the budget is allowed; the next one is refused.
    expect(statuses.slice(0, RATE_LIMIT_MAX).every((s) => s === 200)).toBe(true);
    expect(statuses[RATE_LIMIT_MAX]).toBe(429);
  }, 30_000);
});

describe("POST /api/preview — dynamic vs static payload", () => {
  // Unique IP per test so the rate-limit window is isolated.
  let n = 0;
  const post = (body: Record<string, unknown>) =>
    previewApi.fetch(
      new Request("http://x/api/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": `7.7.7.${(n = (n + 1) % 250) + 1}`,
        },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );

  it("encodes the redirect URL for a dynamic code, not its destination", async () => {
    const res = await post({
      type: "url",
      isDynamic: true,
      shortCode: "abc123",
      fields: { url: "https://example.com/menu" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { svg: string; payload: string };
    // The whole point: what the studio shows must be what gets printed.
    expect(body.payload).toBe(`${env.APP_URL}/r/abc123`);
    expect(body.payload).not.toContain("example.com");
    expect(body.svg).toBeTruthy();
  });

  it("returns the same payload regardless of the destination", async () => {
    const a = await post({ type: "url", isDynamic: true, shortCode: "same01", fields: { url: "https://one.test" } });
    const b = await post({ type: "url", isDynamic: true, shortCode: "same01", fields: { url: "https://two.test/different" } });
    const pa = ((await a.json()) as { payload: string }).payload;
    const pb = ((await b.json()) as { payload: string }).payload;
    // This is the regression the user reported: retargeting must not change
    // the printed code.
    expect(pa).toBe(pb);
  });

  it("encodes the content for a static code", async () => {
    const res = await post({
      type: "url",
      isDynamic: false,
      shortCode: "abc123",
      fields: { url: "https://example.com/menu" },
    });
    const body = (await res.json()) as { payload: string };
    expect(body.payload).toBe("https://example.com/menu");
  });

  it("falls back to the content for a malformed short code", async () => {
    const res = await post({
      type: "url",
      isDynamic: true,
      shortCode: "../../evil",
      fields: { url: "https://example.com" },
    });
    const body = (await res.json()) as { payload: string };
    // Never interpolates an unvalidated code into the payload.
    expect(body.payload).toBe("https://example.com");
  });

  it("reports no_code_yet for a dynamic code with nothing to render", async () => {
    const res = await post({
      type: "url",
      isDynamic: true,
      fields: { url: "" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no_code_yet");
  });

  it("still reports incomplete for a static code missing its field", async () => {
    const res = await post({ type: "url", isDynamic: false, fields: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("incomplete");
  });
});
