import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { redirect } from "../src/routes/redirect";
import { normalizeClaimUrl } from "../src/routes/claim";
import { safeNextPath } from "../src/lib/auth/magic-link";
import { createUser, createQr, getQrByShortCode, claimDestination } from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";

/**
 * Minimal ExecutionContext that TRACKS waitUntil work. It must drain: the
 * redirect logs its scan inside waitUntil, and a detached promise outliving the
 * test's isolated-storage frame corrupts the runner (and hides write failures).
 */
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

/** Adapt the draining context to what Hono's fetch expects. */
function asCtx(c: ReturnType<typeof makeCtx>): ExecutionContext {
  return c as unknown as ExecutionContext;
}

/**
 * Dispatch a request and wait for the response's background work.
 *
 * The redirect logs its scan inside waitUntil. Draining here is what keeps the
 * scan write inside the test's isolated-storage frame — otherwise it outlives
 * the test and the runner tears the database down underneath it.
 */
async function dispatch(req: Request): Promise<Response> {
  const c = makeCtx();
  const res = await redirect.fetch(req, env, asCtx(c));
  await c._drain();
  return res;
}

/** A dynamic code created with no destination — the deferred state. */
async function seedDeferred(): Promise<{ code: string; id: string; ownerId: string }> {
  const owner = await createUser(env.DB, `cl-${crypto.randomUUID()}@example.com`);
  const code = "dfd" + crypto.randomUUID().slice(0, 6);
  const qr = await createQr(env.DB, {
    user_id: owner.id,
    type: "url",
    title: "Packaging code",
    is_dynamic: true,
    short_code: code,
    destination: null,
    content_json: "{}",
    design_json: "{}",
  });
  return { code, id: qr.id, ownerId: owner.id };
}

async function seedUserWithSession() {
  const u = await createUser(env.DB, `cu-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, u.id);
  return { id: u.id, cookie: setCookie.split(";")[0] };
}

function get(code: string, cookie?: string) {
  return new Request(`https://q.test/r/${code}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function post(code: string, body: string, cookie?: string) {
  return new Request(`https://q.test/r/${code}/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
}

describe("GET /r/:code with a deferred destination", () => {
  it("404s for an unknown code", async () => {
    const res = await dispatch(get("nosuchcode"));
    expect(res.status).toBe(404);
  });

  it("shows a sign-in CTA to a signed-out visitor and no form", async () => {
    const { code } = await seedDeferred();
    const res = await dispatch(get(code));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to set the destination");
    expect(html).toContain(`/login?next=${encodeURIComponent(`/r/${code}`)}`);
    expect(html).not.toContain('name="url"');
  });

  it("shows the form to a signed-in visitor", async () => {
    const { code } = await seedDeferred();
    const s = await seedUserWithSession();
    const res = await dispatch(get(code, s.cookie));
    const html = await res.text();
    expect(html).toContain('name="url"');
    expect(html).toContain(`action="/r/${code}/claim"`);
    // The owner's email is disclosed to whoever scans, so only ever the
    // signed-in account's own address.
    expect(html).not.toContain("Sign in to set the destination");
  });

  it("surfaces an error message passed as a query param", async () => {
    const { code } = await seedDeferred();
    const res = await dispatch(
      new Request(`https://q.test/r/${code}?error=invalid-url`),
    );
    expect(await res.text()).toContain("valid web address");
  });

  it("logs the scan — an unconfigured code is still real interest", async () => {
    const { code, id } = await seedDeferred();
    // dispatch drains the waitUntil write; a bare sleep would be both flaky
    // and blind to a rejected write.
    await dispatch(get(code));
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM scans WHERE qr_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(Number(n?.n)).toBe(1);
  });
});

describe("POST /r/:code/claim", () => {
  it("sends a signed-out visitor to sign in, returning them here", async () => {
    const { code } = await seedDeferred();
    const res = await dispatch(
      post(code, "url=https%3A%2F%2Fexample.com"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent(`/r/${code}`)}`,
    );
  });

  it("sets the destination and bounces back through /r/:code", async () => {
    const { code, id } = await seedDeferred();
    const s = await seedUserWithSession();
    const res = await dispatch(
      post(code, "url=https%3A%2F%2Fexample.com%2Fmenu", s.cookie),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/r/${code}`);

    const qr = await getQrByShortCode(env.DB, code);
    expect(qr?.destination).toBe("https://example.com/menu");
    expect(qr?.destination_claimed_by).toBe(s.id);
    expect(qr?.destination_claimed_at).toBeGreaterThan(0);
    expect(id).toBe(qr?.id);
  });

  it("a configured code now redirects instead of showing the claim page", async () => {
    const { code } = await seedDeferred();
    const s = await seedUserWithSession();
    await dispatch(post(code, "url=https%3A%2F%2Fexample.com%2Fmenu", s.cookie));

    const res = await dispatch(get(code, s.cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/menu");
  });

  it("rejects a non-http scheme instead of creating a script-injection redirect", async () => {
    const { code } = await seedDeferred();
    const s = await seedUserWithSession();
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
    ]) {
      const res = await dispatch(
        post(code, `url=${encodeURIComponent(url)}`, s.cookie),
      );
      expect(res.headers.get("location")).toBe(`/r/${code}?error=invalid-url`);
    }
    expect((await getQrByShortCode(env.DB, code))?.destination).toBeNull();
  });

  it("rejects a malformed or empty url", async () => {
    const { code } = await seedDeferred();
    const s = await seedUserWithSession();
    for (const body of ["", "url=", "url=notaurl", "url=https%3A%2F%2F"]) {
      const res = await dispatch(post(code, body, s.cookie));
      expect(res.headers.get("location")).toBe(`/r/${code}?error=invalid-url`);
    }
  });

  it("404s for an unknown short code", async () => {
    const s = await seedUserWithSession();
    const res = await dispatch(post("nosuchcode", "url=https://x.test", s.cookie));
    expect(res.status).toBe(404);
  });

  it("rejects a malformed short code before touching the database", async () => {
    const s = await seedUserWithSession();
    const res = await dispatch(post("../../etc", "url=https://x.test", s.cookie));
    expect(res.status).toBe(404);
  });

  it("is first-come-first-served when two visitors race", async () => {
    const { code } = await seedDeferred();
    const a = await seedUserWithSession();
    const b = await seedUserWithSession();

    const [ra, rb] = await Promise.all([
      claimDestination(env.DB, code, "https://a.test", a.id),
      claimDestination(env.DB, code, "https://b.test", b.id),
    ]);

    // Exactly one winner, whatever the interleaving.
    expect([ra, rb].filter((r) => r === "claimed")).toHaveLength(1);
    expect([ra, rb].filter((r) => r === "already-set")).toHaveLength(1);
    const qr = await getQrByShortCode(env.DB, code);
    expect(["https://a.test", "https://b.test"]).toContain(qr?.destination);
  });

  it("reports not-found distinctly from already-set", async () => {
    const { code } = await seedDeferred();
    const s = await seedUserWithSession();
    expect(await claimDestination(env.DB, "nosuchcode", "https://x.test", s.id)).toBe("not-found");
    expect(await claimDestination(env.DB, code, "https://x.test", s.id)).toBe("claimed");
    expect(await claimDestination(env.DB, code, "https://y.test", s.id)).toBe("already-set");
  });

  it("rate-limits repeated claims from one IP", async () => {
    const s = await seedUserWithSession();
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const { code } = await seedDeferred();
      const res = await dispatch(
        post(code, "url=https%3A%2F%2Fexample.com", s.cookie),
      );
      if (res.headers.get("location")?.includes("rate-limited")) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("normalizeClaimUrl", () => {
  it("accepts http and https and normalises them", () => {
    expect(normalizeClaimUrl("https://example.com/menu")).toBe("https://example.com/menu");
    expect(normalizeClaimUrl("http://example.com")).toBe("http://example.com/");
  });

  it("rejects every non-http scheme", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://example.com",
      "mailto:a@b.test",
      "tel:+15551234",
    ]) {
      expect(normalizeClaimUrl(bad), bad).toBeNull();
    }
  });

  it("rejects empty, hostless and overlong input", () => {
    expect(normalizeClaimUrl("")).toBeNull();
    expect(normalizeClaimUrl("   ")).toBeNull();
    expect(normalizeClaimUrl("https://")).toBeNull();
    expect(normalizeClaimUrl(`https://x.test/${"a".repeat(3000)}`)).toBeNull();
  });

  it("normalises a triple-slash input to a real (if odd) host", () => {
    // "https:///path" parses with hostname "path" — it is not hostless, just a
    // typo'd domain. Rejecting it would be guesswork about intent; it resolves
    // to a normal host that simply will not exist, which is the honest outcome.
    expect(normalizeClaimUrl("https:///path")).toBe("https://path/");
  });
});

describe("safeNextPath (open-redirect guard)", () => {
  it("accepts a normal same-origin path", () => {
    expect(safeNextPath("/r/abc123")).toBe("/r/abc123");
    expect(safeNextPath("/app?q=1")).toBe("/app?q=1");
  });

  it("rejects protocol-relative and absolute URLs", () => {
    expect(safeNextPath("//evil.test/phish")).toBeNull();
    expect(safeNextPath("https://evil.test")).toBeNull();
    expect(safeNextPath("http://evil.test")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });

  it("rejects backslash and whitespace tricks", () => {
    // Browsers normalise "\" to "/", so "/\evil.test" is protocol-relative.
    expect(safeNextPath("/\\evil.test")).toBeNull();
    expect(safeNextPath("/ /evil.test")).toBeNull();
    expect(safeNextPath("/path\nSet-Cookie: x")).toBeNull();
    expect(safeNextPath("/\t/evil.test")).toBeNull();
  });

  it("rejects a path carrying a scheme-like prefix", () => {
    expect(safeNextPath("/javascript:alert(1)")).toBeNull();
  });

  it("rejects null, empty and overlong values", () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(`/${"a".repeat(600)}`)).toBeNull();
  });
});
