import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { qrApi } from "../src/routes/api/qr";
import { createUser } from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

/** Create a user + session and return the Cookie header value for authed requests. */
async function seedSession(email?: string): Promise<{ userId: string; cookie: string }> {
  const u = await createUser(env.DB, email ?? `qr-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, u.id);
  const cookie = setCookie.split(";")[0];
  return { userId: u.id, cookie };
}

function post(path: string, cookie: string, body: unknown): Request {
  return new Request(`https://q.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe("POST /api/qr (create)", () => {
  it("requires auth", async () => {
    const res = await qrApi.fetch(
      new Request("https://q.test/api/qr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url", content: { url: "https://x.com" } }),
      }),
      env,
      ctx,
    );
// 401 with a JSON body, NOT a 302 to the login page. A fetch() that
      // follows the redirect gets HTML, `res.json()` throws a SyntaxError, and
      // an expired session is reported to the user as "Couldn't save. Check your
      // connection." A machine caller needs a status it can branch on.
      expect(res.status).toBe(401);
      const body = (await res.json()) as { ok: boolean; code?: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("unauthenticated");
      // And it must not redirect: a 302 here is what the old guard did.
      expect(res.headers.get("location")).toBeNull();
    });

  it("creates a static QR (row persisted, no short_code)", async () => {
    const { userId, cookie } = await seedSession();
    const res = await qrApi.fetch(
      post("/api/qr", cookie, { type: "url", title: "My site", content: { url: "https://example.com" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const json = await res.json<{ ok: boolean; qr: { id: string; is_dynamic: number; short_code: string | null; user_id: string } }>();
    expect(json.ok).toBe(true);
    expect(json.qr.is_dynamic).toBe(0);
    expect(json.qr.short_code).toBeNull();
    const row = await env.DB.prepare("SELECT user_id FROM qr_codes WHERE id = ?").bind(json.qr.id).first<{ user_id: string }>();
    expect(row?.user_id).toBe(userId);
  });

  it("creates a dynamic QR (mints short_code + destination)", async () => {
    const { cookie } = await seedSession();
    const res = await qrApi.fetch(
      post("/api/qr", cookie, { type: "url", isDynamic: true, destination: "example.org/landing" }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const json = await res.json<{ qr: { is_dynamic: number; short_code: string; destination: string } }>();
    expect(json.qr.is_dynamic).toBe(1);
    expect(json.qr.short_code).toBeTruthy();
    expect(json.qr.destination).toBe("https://example.org/landing"); // scheme normalized
  });

  it("enforces the free plan's dynamic limit (blocks the 4th)", async () => {
    const { cookie } = await seedSession();
    for (let i = 0; i < 3; i++) {
      const ok = await qrApi.fetch(
        post("/api/qr", cookie, { type: "url", isDynamic: true, destination: `https://x${i}.com` }),
        env,
        ctx,
      );
      expect(ok.status).toBe(201);
    }
    const blocked = await qrApi.fetch(
      post("/api/qr", cookie, { type: "url", isDynamic: true, destination: "https://x4.com" }),
      env,
      ctx,
    );
    expect(blocked.status).toBe(402);
    const json = await blocked.json<{ ok: boolean; code: string }>();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("plan_limit");
  });
});

describe("PATCH /api/qr/:id", () => {
  it("updates a dynamic destination without changing the short_code", async () => {
    const { cookie } = await seedSession();
    const created = await qrApi.fetch(
      post("/api/qr", cookie, { type: "url", isDynamic: true, destination: "https://before.com" }),
      env,
      ctx,
    );
    const { qr } = await created.json<{ qr: { id: string; short_code: string } }>();

    const patched = await qrApi.fetch(
      new Request(`https://q.test/api/qr/${qr.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: JSON.stringify({ destination: "https://after.com" }),
      }),
      env,
      ctx,
    );
    expect(patched.status).toBe(200);
    const json = await patched.json<{ qr: { destination: string; short_code: string } }>();
    expect(json.qr.destination).toBe("https://after.com");
    expect(json.qr.short_code).toBe(qr.short_code); // code unchanged — never breaks
  });
});

describe("ownership (no IDOR)", () => {
  it("returns 404 when another user touches your QR", async () => {
    const owner = await seedSession();
    const created = await qrApi.fetch(
      post("/api/qr", owner.cookie, { type: "url", content: { url: "https://owned.com" } }),
      env,
      ctx,
    );
    const { qr } = await created.json<{ qr: { id: string } }>();

    const attacker = await seedSession();
    const patch = await qrApi.fetch(
      new Request(`https://q.test/api/qr/${qr.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", Cookie: attacker.cookie },
        body: JSON.stringify({ title: "hijacked" }),
      }),
      env,
      ctx,
    );
    expect(patch.status).toBe(404);

    const del = await qrApi.fetch(
      new Request(`https://q.test/api/qr/${qr.id}`, { method: "DELETE", headers: { Cookie: attacker.cookie } }),
      env,
      ctx,
    );
    expect(del.status).toBe(404);
  });
});

describe("DELETE /api/qr/:id", () => {
  it("removes an owned QR", async () => {
    const { cookie } = await seedSession();
    const created = await qrApi.fetch(
      post("/api/qr", cookie, { type: "text", content: { text: "hello" } }),
      env,
      ctx,
    );
    const { qr } = await created.json<{ qr: { id: string } }>();
    const del = await qrApi.fetch(
      new Request(`https://q.test/api/qr/${qr.id}`, { method: "DELETE", headers: { Cookie: cookie } }),
      env,
      ctx,
    );
    expect(del.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM qr_codes WHERE id = ?").bind(qr.id).first();
    expect(row).toBeNull();
  });
});

describe("GET /api/qr/:id.svg", () => {
  it("renders the stored QR as an SVG image", async () => {
    const { cookie } = await seedSession();
    const created = await qrApi.fetch(
      post("/api/qr", cookie, { type: "url", content: { url: "https://example.com" } }),
      env,
      ctx,
    );
    const { qr } = await created.json<{ qr: { id: string } }>();
    const res = await qrApi.fetch(
      new Request(`https://q.test/api/qr/${qr.id}.svg`, { headers: { Cookie: cookie } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await res.text();
    expect(svg.startsWith("<svg")).toBe(true);
  });
});
