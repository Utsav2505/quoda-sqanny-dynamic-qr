import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { issueMagicLink, verifyMagicLink } from "../src/lib/auth/magic-link";
import {
  startSession,
  getUserFromRequest,
  endSession,
  readCookie,
  SESSION_COOKIE,
} from "../src/lib/auth/session";
import { getUserByEmail, getUserById } from "../src/db/queries";
import { sendMagicLink } from "../src/lib/auth/email";

function envWith(overrides: Partial<typeof env>): typeof env {
  return { ...env, ...overrides } as typeof env;
}

describe("readCookie", () => {
  it("parses a named cookie from the request header", () => {
    const req = new Request("https://q.test/", {
      headers: { cookie: `a=1; ${SESSION_COOKIE}=sess123; b=2` },
    });
    expect(readCookie(req, SESSION_COOKIE)).toBe("sess123");
    expect(readCookie(req, "a")).toBe("1");
    expect(readCookie(req, "missing")).toBeNull();
  });

  it("returns null when there is no cookie header", () => {
    expect(readCookie(new Request("https://q.test/"), SESSION_COOKIE)).toBeNull();
  });
});

describe("sendMagicLink", () => {
  it("logs to console in dev (no RESEND key) and warns", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendMagicLink(
      envWith({ RESEND_API_KEY: undefined }),
      "dev@example.com",
      "https://app/auth/verify?token=t",
    );
    expect(log).toHaveBeenCalledWith(
      "[DEV MAGIC LINK] dev@example.com -> https://app/auth/verify?token=t",
    );
    expect(warn).toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it("POSTs to Resend when an API key is configured", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await sendMagicLink(
      envWith({ RESEND_API_KEY: "re_test_key" }),
      "user@example.com",
      "https://app/auth/verify?token=abc",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.from).toBe("Sqanny <sqanny-noreply@chetnaverse.com>");
    expect(body.to).toContain("user@example.com");
    expect(body.subject).toBe("Your Sqanny sign-in link");
    expect(body.html).toContain("https://app/auth/verify?token=abc");
    fetchSpy.mockRestore();
  });

  it("throws (never silent) when Resend returns an error", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("nope", { status: 422 }));
    await expect(
      sendMagicLink(
        envWith({ RESEND_API_KEY: "re_test_key" }),
        "user@example.com",
        "https://app/x",
      ),
    ).rejects.toThrow();
    fetchSpy.mockRestore();
  });
});

describe("magic link issue + verify", () => {
  it("happy path: issue then verify creates the user and returns userId", async () => {
    const e = envWith({ RESEND_API_KEY: undefined });
    const email = `ml-${crypto.randomUUID()}@example.com`;
    expect(await getUserByEmail(env.DB, email)).toBeNull();

    const { token, url } = await issueMagicLink(e, email);
    expect(token.length).toBeGreaterThan(20);
    expect(url).toContain("/auth/verify?token=" + token);

    const result = await verifyMagicLink(e, token);
    expect(result).not.toBeNull();
    const user = await getUserById(env.DB, result!.userId);
    expect(user?.email).toBe(email);
  });

  it("reuses an existing user on second login", async () => {
    const e = envWith({ RESEND_API_KEY: undefined });
    const email = `ml2-${crypto.randomUUID()}@example.com`;
    const a = await issueMagicLink(e, email);
    const first = await verifyMagicLink(e, a.token);
    const b = await issueMagicLink(e, email);
    const second = await verifyMagicLink(e, b.token);
    expect(first!.userId).toBe(second!.userId);
  });

  it("rejects an unknown / garbage token", async () => {
    const e = envWith({ RESEND_API_KEY: undefined });
    expect(await verifyMagicLink(e, "not-a-real-token")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const e = envWith({ RESEND_API_KEY: undefined });
    const email = `mlexp-${crypto.randomUUID()}@example.com`;
    const { token } = await issueMagicLink(e, email);

    // Expire the link by force-updating its stored row.
    const hash = await sha256Hex(token);
    await env.DB.prepare(
      "UPDATE magic_links SET expires_at = ? WHERE token_hash = ?",
    )
      .bind(Date.now() - 1000, hash)
      .run();

    expect(await verifyMagicLink(e, token)).toBeNull();
  });

  it("rejects a consumed token (single use)", async () => {
    const e = envWith({ RESEND_API_KEY: undefined });
    const email = `mlcon-${crypto.randomUUID()}@example.com`;
    const { token } = await issueMagicLink(e, email);
    const first = await verifyMagicLink(e, token);
    expect(first).not.toBeNull();
    // Second verify must fail — token already consumed.
    expect(await verifyMagicLink(e, token)).toBeNull();
  });
});

describe("sessions", () => {
  it("round-trips a user via the session cookie", async () => {
    const e = envWith({ RESEND_API_KEY: undefined });
    const email = `sess-${crypto.randomUUID()}@example.com`;
    const { token } = await issueMagicLink(e, email);
    const { userId } = (await verifyMagicLink(e, token))!;

    const setCookie = await startSession(env, userId, "vitest-UA");
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=");

    const sessionId = setCookie.split(";")[0].split("=")[1];
    const req = new Request("https://q.test/app", {
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    const user = await getUserFromRequest(env, req);
    expect(user?.id).toBe(userId);
    expect(user?.email).toBe(email);
    expect(user?.plan_id).toBe("free");
  });

  it("returns null for a request with no session cookie", async () => {
    const user = await getUserFromRequest(env, new Request("https://q.test/"));
    expect(user).toBeNull();
  });

  it("endSession clears the session and a subsequent lookup fails", async () => {
    const e = envWith({ RESEND_API_KEY: undefined });
    const email = `end-${crypto.randomUUID()}@example.com`;
    const { token } = await issueMagicLink(e, email);
    const { userId } = (await verifyMagicLink(e, token))!;
    const setCookie = await startSession(env, userId, "ua");
    const sessionId = setCookie.split(";")[0].split("=")[1];

    const req = new Request("https://q.test/app", {
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    const cleared = await endSession(env, req);
    expect(cleared).toContain("Max-Age=0");

    // After ending, the cookie no longer resolves to a user.
    expect(await getUserFromRequest(env, req)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const e = envWith({ RESEND_API_KEY: undefined });
    const email = `exps-${crypto.randomUUID()}@example.com`;
    const { token } = await issueMagicLink(e, email);
    const { userId } = (await verifyMagicLink(e, token))!;
    const setCookie = await startSession(env, userId, "ua");
    const sessionId = setCookie.split(";")[0].split("=")[1];

    // Force-expire in D1 and drop the KV cache so the slow path runs.
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, sessionId)
      .run();
    await env.SESSION_CACHE.delete(`session:${sessionId}`);

    const req = new Request("https://q.test/app", {
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(await getUserFromRequest(env, req)).toBeNull();
  });
});

// Local sha256 hex helper for the expiry test (mirrors the auth module).
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
