import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { redirect } from "../src/routes/redirect";
import { normalizeClaimUrl } from "../src/routes/claim";
import { normalizeUrl } from "../src/lib/validate";
import { safeNextPath } from "../src/lib/auth/magic-link";
import { createUser, createQr, getQrByShortCode, createBusiness, claimDestination } from "../src/db/queries";
import { registerAsset } from "../src/db/qr-registry";
import { claimQr } from "../src/lib/claim";
import { generateIdentifier } from "../src/lib/qr-registration";
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

/**
 * A physical stand: a `qr_registry` row claimed to a business, with the
 * configuration row it owns deliberately left WITHOUT a destination (the
 * `claimed` / "Setup pending" state).
 *
 * This is the row that must be unreachable from the legacy deferred-destination
 * path: the registry service is the only writer of a stand's destination.
 */
async function seedStand(): Promise<{ code: string; ownerId: string; serial: string }> {
  const ownerId = await seedUserWithSession().then((s) => s.id);
  const business = await createBusiness(env.DB, ownerId, {
    name: "Stand Cafe",
    category: "cafe",
    address: "1 Road",
    city: "Delhi",
    state: "Delhi",
    country: "IN",
  });
  const serial = generateIdentifier();
  await registerAsset(env.DB, serial);
  const result = await claimQr(
    env.DB,
    {
      identifier: serial,
      viewerId: ownerId,
      businessId: business.id,
      name: "Counter",
      category: "reviews",
      placement: null,
      destination: "https://example.com",
    },
    "pro",
  );
  if (!result.ok) throw new Error(`seedStand: claim failed (${result.reason})`);
  // Blank the destination to reach the half-configured state.
  await env.DB.prepare("UPDATE qr_codes SET destination = NULL WHERE id = ?")
    .bind(result.asset.qr_code_id)
    .run();
  return { code: result.asset.short_code!, ownerId, serial };
}

/** The owner of a stand seeded by seedStand. */
async function standOwnerId(code: string): Promise<string> {
  const row = await env.DB.prepare("SELECT user_id FROM qr_codes WHERE short_code = ?")
    .bind(code)
    .first<{ user_id: string }>();
  return row!.user_id;
}

async function seedUserWithSession() {
  const u = await createUser(env.DB, `cu-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, u.id);
  return { id: u.id, cookie: setCookie.split(";")[0] };
}

/**
 * A session for an EXISTING user.
 *
 * Needed because setting a destination is owner-scoped. A fresh account per test
 * is fine for every other suite here, but this one has to act as the account that
 * actually owns the code — which is exactly the boundary the tests below exist to
 * pin down.
 */
async function sessionFor(userId: string) {
  const setCookie = await startSession(env, userId);
  return { id: userId, cookie: setCookie.split(";")[0] };
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

  it("shows the form to the OWNER, and only to the owner", async () => {
    const { code, ownerId } = await seedDeferred();
    const owner = await sessionFor(ownerId);
    const res = await dispatch(get(code, owner.cookie));
    const html = await res.text();
    expect(html).toContain('name="url"');
    expect(html).toContain(`action="/r/${code}/claim"`);
    // The owner's email is disclosed to whoever scans, so only ever the
    // signed-in account's own address.
    expect(html).not.toContain("Sign in to set the destination");
  });

  it("does NOT show the form to a different signed-in visitor", async () => {
    // Being signed in is not authority over somebody else's code. Offering the
    // form here would advertise an action the handler is guaranteed to refuse,
    // and it was the first half of a cross-tenant hijack.
    const { code } = await seedDeferred();
    const stranger = await seedUserWithSession();
    const html = await (await dispatch(get(code, stranger.cookie))).text();
    expect(html).not.toContain('name="url"');
    // They get somewhere to go rather than a dead end, and learn nothing about
    // who owns it.
    expect(html).toContain("/qrs");
    expect(html).not.toContain("ownerId");
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
    const { code, id, ownerId } = await seedDeferred();
    const s = await sessionFor(ownerId);
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
    const { code, ownerId } = await seedDeferred();
    const s = await sessionFor(ownerId);
    await dispatch(post(code, "url=https%3A%2F%2Fexample.com%2Fmenu", s.cookie));

    const res = await dispatch(get(code, s.cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/menu");
  });

  it("will NOT let a different account set the destination", async () => {
    // THE hijack test. `claimDestination` used to carry no ownership predicate
    // at all, so any signed-in account that learned a short code could point
    // somebody else's printed label at a URL of their choosing — a stored open
    // redirect served from a physical stand, and recorded in the audit trail as
    // if the attacker had been authorised.
    const { code, ownerId } = await seedDeferred();
    const attacker = await seedUserWithSession();
    expect(attacker.id).not.toBe(ownerId);

    const res = await dispatch(
      post(code, "url=https%3A%2F%2Fattacker.example%2Fsteal", attacker.cookie),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/r/${code}?error=not-owner`);

    // Unchanged, and still attributable to nobody.
    const qr = await getQrByShortCode(env.DB, code);
    expect(qr?.destination).toBeNull();
    expect(qr?.destination_claimed_by).toBeNull();
  });

  it("refuses a physical Sqanny Stand, whose destination the registry owns", async () => {
    // A stand is not a deferred studio code: it has a serial, a lifecycle and a
    // business, all owned by the registry service. Letting this legacy path write
    // its destination would give the same field two authorities.
    const { code } = await seedStand();
    const owner = await sessionFor(await standOwnerId(code));

    const res = await dispatch(
      post(code, "url=https%3A%2F%2Fattacker.example%2Fsteal", owner.cookie),
    );
    expect(res.headers.get("location")).toBe(`/r/${code}?error=managed-elsewhere`);
    expect((await getQrByShortCode(env.DB, code))?.destination).toBeNull();
  });

  it("rejects a non-http scheme instead of creating a script-injection redirect", async () => {
    const { code, ownerId } = await seedDeferred();
    const s = await sessionFor(ownerId);
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
    const { code, ownerId } = await seedDeferred();
    const s = await sessionFor(ownerId);
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

  it("is first-come-first-served when two OWNERS race", async () => {
    const { code, ownerId } = await seedDeferred();
    const a = await sessionFor(ownerId);

    const [ra, rb] = await Promise.all([
      claimDestination(env.DB, code, "https://a.test", a.id),
      // The same owner from two tabs — the realistic race for a deferred code.
      claimDestination(env.DB, code, "https://b.test", a.id),
    ]);

    // Exactly one winner, whatever the interleaving.
    expect([ra, rb].filter((r) => r === "claimed")).toHaveLength(1);
    expect([ra, rb].filter((r) => r === "already-set")).toHaveLength(1);
    const qr = await getQrByShortCode(env.DB, code);
    expect(["https://a.test", "https://b.test"]).toContain(qr?.destination);
  });

  it("reports not-found, not-owner and already-set distinctly", async () => {
    const { code, ownerId } = await seedDeferred();
    const owner = await sessionFor(ownerId);
    const stranger = await seedUserWithSession();

    expect(await claimDestination(env.DB, "nosuchcode", "https://x.test", owner.id)).toBe("not-found");
    // A stranger gets a refusal that does not confirm anything beyond what
    // scanning the code already revealed.
    expect(await claimDestination(env.DB, code, "https://x.test", stranger.id)).toBe("not-owner");
    expect(await claimDestination(env.DB, code, "https://x.test", owner.id)).toBe("claimed");
    expect(await claimDestination(env.DB, code, "https://y.test", owner.id)).toBe("already-set");
  });

  it("rate-limits repeated claims from one IP", async () => {
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const { code, ownerId } = await seedDeferred();
      const s = await sessionFor(ownerId);
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
    expect(normalizeClaimUrl("http://example.com")).toBe("http://example.com");
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

  it("rejects a host with no dot, the same as the shared normalizer", () => {
    // Was "https://path/" — the local parser accepted it because it only checked
    // that a hostname existed. Now this route defers to the one product-wide
    // policy, so `https:///path` is refused the same way a business website of
    // the same shape is. Guessing at intent was the wrong trade: a destination
    // is configuration, and configuration has one rule.
    expect(normalizeClaimUrl("https:///path")).toBeNull();
    expect(normalizeClaimUrl("http://localhost:8787/x")).toBeNull();
  });
});

/**
 * There was once a second destination parser — `normalizeClaimUrl` in
 * routes/claim.tsx — alongside the shared `normalizeUrl` in lib/validate.ts, and
 * they disagreed on policy. Three separate parsers existed once this was counted
 * (the studio API carried its own, which accepted `mailto:` and no host at all).
 *
 * All of them now resolve to `normalizeUrl`. That is the whole point of the block
 * below: it pins that there is ONE policy, so the next hand-written parser is a
 * review finding rather than something a user discovers by getting a different
 * answer from a different screen.
 */
describe("there is one destination normalizer, not several", () => {
  const MUST_REJECT = [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "ftp://example.com",
    "mailto:a@b.test",
    "tel:+15551234",
    "vbscript:msgbox(1)",
    "blob:https://example.com/x",
  ];

  it("no normalizer ever returns a non-http(s) URL", () => {
    for (const bad of MUST_REJECT) {
      expect(normalizeClaimUrl(bad), `normalizeClaimUrl: ${bad}`).toBeNull();
      expect(normalizeUrl(bad), `normalizeUrl: ${bad}`).toBeNull();
    }
  });

  it("the two entry points agree on every input", () => {
    for (const input of [
      "https://example.com/menu",
      "http://example.com",
      "example.com",
      "example.com:8080/x",
      "http://localhost:8787/x",
      "https:///path",
      "https://user:pw@example.com/x",
      "notaurl",
      "",
    ]) {
      expect(normalizeClaimUrl(input), `input: ${input}`).toBe(normalizeUrl(input));
    }
  });

  it("one of them supplies a scheme and requires a dotted host", () => {
    // Both behaviours now come from lib/validate, so both flows give the same
    // answer for the same typing: "example.com" becomes a URL, and a host with
    // no dot is refused as a typo rather than accepted as a live destination.
    expect(normalizeClaimUrl("example.com")).toBe("https://example.com");
    expect(normalizeClaimUrl("http://localhost:8787/x")).toBeNull();
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

describe("normalizeUrl (the shared destination normalizer)", () => {
  it("adds a scheme to a bare host and keeps real paths", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("example.com/menu?a=1")).toBe("https://example.com/menu?a=1");
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("does not mistake a port for a scheme", () => {
    // "example.com:8080" is a host and a port, not a "example.com" scheme.
    expect(normalizeUrl("example.com:8080/x")).toBe("https://example.com:8080/x");
  });

  it("rejects a declared scheme that is not http(s)", () => {
    // The regression: these have no "://", so a naive prefixer turned them into
    // valid-looking https URLs. "mailto:a@b.test" in particular became
    // "https://b.test" - the email's domain became a live destination.
    expect(normalizeUrl("mailto:a@b.test")).toBeNull();
    expect(normalizeUrl("tel:+15551234")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("data:text/html,x")).toBeNull();
    expect(normalizeUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects a host with no dot, and embedded credentials", () => {
    expect(normalizeUrl("http://localhost:8787/x")).toBeNull();
    expect(normalizeUrl("https://")).toBeNull();
    // Userinfo is a phishing shape and is never a legitimate destination here.
    expect(normalizeUrl("https://user:pw@example.com/x")).toBeNull();
  });

  it("rejects empty and overlong input", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl(`https://x.test/${"a".repeat(3000)}`)).toBeNull();
  });
});
