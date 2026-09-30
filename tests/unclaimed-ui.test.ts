import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { dashboard } from "../src/routes/dashboard";
import { qrDetail } from "../src/routes/qr-detail";
import { createUser, createQr } from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function seedSession() {
  const u = await createUser(env.DB, `un-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, u.id);
  return { userId: u.id, cookie: setCookie.split(";")[0] };
}

async function seedQr(
  userId: string,
  opts: { dynamic: boolean; destination: string | null; shortCode?: string; type?: "url" | "social" },
) {
  const qr = await createQr(env.DB, {
    user_id: userId,
    type: opts.type ?? "url",
    title: "Packaging",
    is_dynamic: opts.dynamic,
    short_code: opts.shortCode,
    destination: opts.destination,
    content_json: "{}",
    design_json: "{}",
  });
  return qr;
}

async function renderDashboard(cookie: string): Promise<string> {
  const res = await dashboard.fetch(new Request("https://q.test/app", { headers: { Cookie: cookie } }), env, ctx);
  expect(res.status).toBe(200);
  return res.text();
}

async function renderDetail(cookie: string, id: string): Promise<string> {
  const res = await qrDetail.fetch(new Request(`https://q.test/app/${id}`, { headers: { Cookie: cookie } }), env, ctx);
  expect(res.status).toBe(200);
  return res.text();
}

describe("dashboard — unclaimed destination is visible", () => {
  it("badges a dynamic code that has no destination", async () => {
    const s = await seedSession();
    await seedQr(s.userId, { dynamic: true, destination: null, shortCode: "uncl001" });

    const html = await renderDashboard(s.cookie);
    expect(html).toContain("No destination yet");
  });

  it("does not badge a configured dynamic code", async () => {
    const s = await seedSession();
    await seedQr(s.userId, { dynamic: true, destination: "https://example.com", shortCode: "cfgd001" });

    const html = await renderDashboard(s.cookie);
    expect(html).not.toContain("No destination yet");
  });

  it("does not badge a static code (a static code always has content)", async () => {
    const s = await seedSession();
    await seedQr(s.userId, { dynamic: false, destination: null, shortCode: "stat001" });

    const html = await renderDashboard(s.cookie);
    expect(html).not.toContain("No destination yet");
  });

  it("shows the short code, so two identically-titled codes are distinguishable", async () => {
    const s = await seedSession();
    // Exactly the collision that caused the original confusion.
    await seedQr(s.userId, { dynamic: true, destination: null, shortCode: "aaaa111" });
    await seedQr(s.userId, { dynamic: true, destination: "https://chetnaverse.com", shortCode: "bbbb222" });

    const html = await renderDashboard(s.cookie);
    expect(html).toContain("aaaa111");
    expect(html).toContain("bbbb222");
  });

  it("makes the short code searchable", async () => {
    const s = await seedSession();
    await seedQr(s.userId, { dynamic: true, destination: null, shortCode: "findme9" });

    const html = await renderDashboard(s.cookie);
    // data-search drives the client-side filter, so the code must be in it.
    expect(html).toMatch(/data-search="[^"]*findme9/);
  });
});

describe("QR detail — unclaimed destination", () => {
  it("shows a callout and the permanent printed URL when unclaimed", async () => {
    const s = await seedSession();
    const qr = await seedQr(s.userId, { dynamic: true, destination: null, shortCode: "detl001" });

    const html = await renderDetail(s.cookie, qr.id);
    expect(html).toContain("No destination set yet");
    expect(html).toContain(`${env.APP_URL}/r/detl001`);
    // The inline editor is offered immediately, so scanning is not the only route.
    expect(html).toContain("Set the destination");
    expect(html).toContain('data-dest-input');
  });

  it("omits the callout once a destination is set", async () => {
    const s = await seedSession();
    const qr = await seedQr(s.userId, { dynamic: true, destination: "https://example.com", shortCode: "detl002" });

    const html = await renderDetail(s.cookie, qr.id);
    expect(html).not.toContain("No destination set yet");
    expect(html).toContain("Current target");
  });

  it("never badges a hosted/rich code, whose destination is managed", async () => {
    const s = await seedSession();
    const qr = await seedQr(s.userId, {
      dynamic: true,
      destination: `${env.APP_URL}/p/rich001`,
      shortCode: "rich001",
      type: "social",
    });

    const html = await renderDetail(s.cookie, qr.id);
    expect(html).not.toContain("No destination set yet");
  });
});
