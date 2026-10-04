import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../src/index";
import { createUser } from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";
import { registerAsset } from "../src/db/qr-registry";
import { generateIdentifier } from "../src/lib/qr-registration";

/**
 * Guards the architecture that the frontend migration depends on.
 *
 * These are not UI tests. Each one asserts a structural property that, if broken,
 * would silently cost a customer latency or hand a broken document to the
 * scanner. They exist because "React must not be on the redirect path" is a
 * property of ROUTING, and routing is exactly the kind of thing that gets broken
 * by an innocent-looking edit months later.
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

async function call(req: Request): Promise<Response> {
  const c = makeCtx();
  const res = await app.fetch(req, env, c as unknown as ExecutionContext);
  await c._drain();
  return res;
}

function get(path: string, cookie?: string) {
  return call(
    new Request(`https://q.test${path}`, { headers: cookie ? { Cookie: cookie } : {} }),
  );
}

describe("SPA mounting", () => {
  /**
   * `env.ASSETS` is not provisioned by @cloudflare/vitest-pool-workers, so these
   * tests cannot assert the shell's actual markup - that is verified by
   * `npm run build:web` plus a real `wrangler dev` preview. What they CAN assert,
   * and what actually matters here, is the routing contract and the failure
   * behaviour: a missing build must degrade to an actionable 503, never a 500
   * and never a blank document.
   */
  it("degrades to an actionable 503 when the React build is absent", async () => {
    const res = await get("/_app/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("npm run build:web");
  });

  it("404s a missing hashed asset instead of answering with HTML", async () => {
    // A JS request answered with index.html produces "Unexpected token '<'",
    // which tells the user nothing. This has to be a clean 404.
    const res = await get("/_app/assets/index-doesnotexist.js");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<div id=\"root\">");
  });

  it("reports whether the shell build is present", async () => {
    const res = await get("/api/app-info");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      shell: string;
      shellPath: string;
      note: string;
    };
    expect(body.ok).toBe(true);
    // Documents itself as unbuilt rather than pretending, and names the command.
    expect(body.shell).toBe("missing - run npm run build:web");
    // The shell lives under /_app because that is where Vite writes it. Asserting
    // the exact path catches a move that would 503 in production only.
    expect(body.shellPath).toBe("/_app/index.html");
    expect(body.note).toContain("never serves this app");
  });

  it("does not hijack the existing SSR /app routes yet", async () => {
    // The migration is incremental. Until an area is explicitly moved, the SSR
    // frontend must keep serving it, or production breaks with nothing deployed.
    const user = await createUser(env.DB, `spa-${crypto.randomUUID()}@example.com`);
    const setCookie = await startSession(env, user.id);
    const res = await get("/app", setCookie.split(";")[0]);
    expect(res.status).toBe(200);
    // SSR output, not the React shell.
    const html = await res.text();
    expect(html).not.toContain("<div id=\"root\">");
  });

  it("does not claim the legacy frontend's asset paths", async () => {
    // The platform asset layer serves /styles/* and /js/* before the Worker runs,
    // which the Workers test pool does not simulate - so a 404 here is expected
    // and says nothing about production. What matters, and IS testable, is that
    // the SPA router does not lay claim to those prefixes: if it ever did, the
    // build would start emitting files that shadow the still-live SSR frontend.
    const res = await get("/styles/app.css");
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    // i.e. the SPA never answered it with a document.
    const js = await get("/js/ui.js");
    expect(js.headers.get("content-type") ?? "").not.toContain("text/html");
  });
});

describe("the QR redirect path stays React-free", () => {
  /**
   * The single most important assertion in this file. A customer scanning a
   * Sqanny Stand must not download React, Tailwind, the dashboard, or any chart
   * library. This test fails if anyone registers the SPA before `qrs`/`redirect`,
   * or widens SPA_PREFIXES carelessly.
   */
  it("serves a redirect, not an HTML document, for an unconfigured QR", async () => {
    const user = await createUser(env.DB, `redir-${crypto.randomUUID()}@example.com`);
    const serial = generateIdentifier();
    await registerAsset(env.DB, serial);

    // With no destination yet, the owner is sent into the claim flow. Whatever it
    // answers, it must be a redirect - never the SPA.
    const setCookie = await startSession(env, user.id);
    const res = await get(`/q/${serial}`, setCookie.split(";")[0]);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBeTruthy();
  });

  it("never returns the SPA shell for /r/:code, including for a miss", async () => {
    const res = await get("/r/definitelynotacode");
    // 404 for an unknown code is correct; the SPA shell is not.
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("<div id=\"root\">");
  });

  it("does not let the SPA intercept /api/* errors", async () => {
    // A catch-all mounted early would turn a JSON 404 into 200 text/html and
    // break every client `fetch` with an opaque res.json() failure.
    const res = await call(
      new Request("https://q.test/api/qr/00000000-0000-0000-0000-000000000000", {
        headers: { accept: "application/json" },
      }),
    );
    expect([401, 404]).toContain(res.status);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });
});