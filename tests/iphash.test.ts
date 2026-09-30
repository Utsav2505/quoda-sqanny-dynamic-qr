import { describe, it, expect } from "vitest";
import { hashIp, hashRequestIp, clientIp } from "../src/lib/iphash";

const SECRET = "test-secret-value";
const DAY_1 = Date.parse("2026-01-14T00:00:00Z");
const DAY_2 = Date.parse("2026-01-15T00:00:00Z");

function req(headers: Record<string, string>): Request {
  return new Request("https://q.test/r/abc", { headers });
}

describe("clientIp", () => {
  it("prefers the Cloudflare header", () => {
    expect(clientIp(req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))).toBe("1.2.3.4");
  });

  it("falls back to the first x-forwarded-for entry when self-hosted", () => {
    expect(clientIp(req({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" }))).toBe("5.6.7.8");
  });

  it("returns null when no IP header is present", () => {
    expect(clientIp(req({}))).toBeNull();
  });

  it("rejects malformed addresses rather than hashing junk", () => {
    expect(clientIp(req({ "x-forwarded-for": "<script>alert(1)</script>" }))).toBeNull();
  });
});

describe("hashIp", () => {
  it("is stable for the same IP within a day (enables unique counts)", async () => {
    const a = await hashIp("1.2.3.4", SECRET, DAY_1);
    const b = await hashIp("1.2.3.4", SECRET, DAY_1);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs for different IPs on the same day", async () => {
    const a = await hashIp("1.2.3.4", SECRET, DAY_1);
    const b = await hashIp("1.2.3.5", SECRET, DAY_1);
    expect(a).not.toBe(b);
  });

  it("differs across days for the same IP (salt rotation defeats tracking)", async () => {
    const a = await hashIp("1.2.3.4", SECRET, DAY_1);
    const b = await hashIp("1.2.3.4", SECRET, DAY_2);
    expect(a).not.toBe(b);
  });

  it("differs across secrets for the same IP and day", async () => {
    const a = await hashIp("1.2.3.4", SECRET, DAY_1);
    const b = await hashIp("1.2.3.4", "another-secret", DAY_1);
    expect(a).not.toBe(b);
  });

  it("never returns the raw IP", async () => {
    const hash = await hashIp("1.2.3.4", SECRET, DAY_1);
    expect(hash).not.toContain("1.2.3.4");
    expect(hash).toBeTruthy();
  });

  it("returns null without a secret rather than storing a raw address", async () => {
    expect(await hashIp("1.2.3.4", undefined, DAY_1)).toBeNull();
    expect(await hashIp("1.2.3.4", "", DAY_1)).toBeNull();
  });

  it("returns null for a missing IP", async () => {
    expect(await hashIp(null, SECRET, DAY_1)).toBeNull();
  });
});

describe("hashRequestIp", () => {
  it("resolves and hashes the request IP", async () => {
    const hash = await hashRequestIp(req({ "cf-connecting-ip": "8.8.8.8" }), SECRET, DAY_1);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns null when the request carries no IP", async () => {
    expect(await hashRequestIp(req({}), SECRET, DAY_1)).toBeNull();
  });
});
