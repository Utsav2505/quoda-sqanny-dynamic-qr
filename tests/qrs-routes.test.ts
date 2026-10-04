// Route-level tests for the four-step claim flow and the public /q/:serial
// entry point.
//
// The service and its SQL are already covered in qr-registry.test.ts. What these
// pin down is the part that only exists here: that the pages a user actually
// walks form a working sequence, that the flow survives with scripting disabled
// (every step is a URL and a plain form), and that none of the failure branches
// leak another account's data or silently swallow an error.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { qrs } from "../src/routes/qrs";
import { dashboard } from "../src/routes/dashboard";
import { createBusiness, createQr, createUser } from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";
import { registerAsset, getAssetViewForOwner } from "../src/db/qr-registry";
import { generateIdentifier } from "../src/lib/qr-registration";

// Background work (the scan write on /q/:serial) runs in waitUntil. A no-op
// waitUntil lets that promise outlive the test's isolated storage, which fails
// the suite for reasons that have nothing to do with the assertion. Collecting
// the promises and awaiting them keeps the test hermetic — the same approach
// tests/redirect.test.ts uses for the identical /r/:code path.
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(Promise.resolve(p).catch(() => undefined));
    },
    passThroughOnException() {},
    async _drain() {
      await Promise.all(pending);
    },
  };
  return ctx;
}

async function account(prefix = "claim") {
  const user = await createUser(env.DB, `${prefix}-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, user.id);
  return { user, cookie: setCookie.split(";")[0] };
}

async function stand(): Promise<string> {
  const serial = generateIdentifier();
  await registerAsset(env.DB, serial);
  return serial;
}

/** Minimal valid business input, matching the fields parseBusiness requires. */
const BIZ = {
  name: "Corner Cafe",
  category: "cafe",
  address: "12 Bridge Street",
  city: "Pune",
  state: "Maharashtra",
  country: "IN",
};

/**
 * Every helper drains waitUntil work before returning, so a background scan
 * write finishes inside the test's isolated storage instead of outliving it.
 */
function withCtx<T>(run: (c: ReturnType<typeof makeCtx>) => Promise<T>): Promise<T> {
  const c = makeCtx();
  return run(c).then(async (res) => {
    await c._drain();
    return res;
  });
}

function get(cookie: string, path: string) {
  return withCtx((c) =>
    qrs.fetch(new Request(`https://q.test${path}`, { headers: { Cookie: cookie } }), env, c),
  );
}

function post(cookie: string, path: string, body: Record<string, string>) {
  return withCtx((c) =>
    qrs.fetch(
      new Request(`https://q.test${path}`, {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      }),
      env,
      c,
    ),
  );
}

/** GET on the public route, where there is no session. */
function getPublic(path: string) {
  return withCtx((c) => qrs.fetch(new Request(`https://q.test${path}`), env, c));
}

const CLAIM = {
  name: "Counter",
  category: "reviews",
  placement: "Cash Desk",
  destination: "https://maps.google.com?cid=1",
};

describe("GET /qrs/claim (step 1: scan)", () => {
  it("redirects to /login without a session", async () => {
    const res = await getPublic("/qrs/claim");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("renders a manual entry field that works with scripting disabled", async () => {
    const { cookie } = await account();
    const res = await get(cookie, "/qrs/claim");
    expect(res.status).toBe(200);
    const html = await res.text();

    // The form is a plain GET to the next step, so it is the whole flow with
    // JavaScript off.
    expect(html).toContain('action="/qrs/claim/business"');
    expect(html).toContain('name="qr"');
    // …and the field is NOT hidden behind a click, which would leave a no-JS
    // visitor with no way to enter anything.
    expect(html).not.toMatch(/data-scan-manual-panel[^>]*hidden/);
  });
});

describe("the four steps as a URL sequence", () => {
  it("walks scan -> business -> details -> review -> claimed", async () => {
    const { user, cookie } = await account("walk");
    const serial = await stand();
    const business = await createBusiness(env.DB, user.id, {
      name: "Corner Cafe",
      category: "cafe",
      custom_category: null,
      address: "12 Bridge Street",
      city: "Pune",
      state: "Maharashtra",
      country: "IN",
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });

    // Step 1 -> 2 carries the serial in the query string.
    const step2 = await get(cookie, `/qrs/claim/business?qr=${serial}`);
    expect(step2.status).toBe(200);
    expect(await step2.text()).toContain(serial);

    // Step 2 -> 3 picks a business.
    const chose = await post(cookie, "/qrs/claim/business", {
      qr: serial,
      business_id: business.id,
    });
    expect(chose.status).toBe(302);
    const toDetails = chose.headers.get("location")!;
    expect(toDetails).toContain("/qrs/claim/details");
    expect(toDetails).toContain(`business=${encodeURIComponent(business.id)}`);

    // Step 3 -> 4 posts the configuration.
    const reviewed = await post(cookie, "/qrs/claim/review", {
      qr: serial,
      business_id: business.id,
      ...CLAIM,
    });
    expect(reviewed.status).toBe(200);
    const recap = await reviewed.text();
    expect(recap).toContain("Corner Cafe");
    expect(recap).toContain("Counter");
    expect(recap).toContain(CLAIM.destination);

    // Step 4 performs the claim.
    const claimed = await post(cookie, "/qrs/claim", {
      qr: serial,
      business_id: business.id,
      ...CLAIM,
    });
    expect(claimed.status).toBe(302);
    expect(claimed.headers.get("location")).toContain("/qrs/claim/success");

    const success = await get(cookie, claimed.headers.get("location")!);
    expect(success.status).toBe(200);
    expect(await success.text()).toContain("successfully connected");
  });

  it("never offers a 'skip the business' path, because a business is required", async () => {
    const { user, cookie } = await account("nobizskip");
    const business = await createBusiness(env.DB, user.id, {
      ...BIZ,
      custom_category: null,
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });
    const serial = await stand();

    const step2 = await get(cookie, `/qrs/claim/business?qr=${serial}`);
    const html = await step2.text();
    // The old copy promised a way past this step; the claim itself requires a
    // business, so the only honest thing is not to offer one.
    expect(html).not.toContain("Skip for now");
    expect(html).toContain("Create a new business");

    // And arriving at step 3 with no business bounces back to step 2.
    const orphan = await get(cookie, `/qrs/claim/details?qr=${serial}`);
    expect(orphan.status).toBe(302);
    expect(orphan.headers.get("location")).toContain("/qrs/claim/business");
    expect(business.id).toBeTruthy();
  });
});

describe("creating a business inside the claim flow", () => {
  it("creates it, selects it, and carries on without ejecting the user", async () => {
    const { cookie } = await account("createbiz");
    const serial = await stand();

    // No businesses yet, so the create form is the only action offered.
    const step2 = await get(cookie, `/qrs/claim/business?qr=${serial}`);
    expect(step2.status).toBe(200);
    expect(await step2.text()).toContain("Create your first business");

    const created = await post(cookie, "/qrs/claim/business", { qr: serial, create: "1", ...BIZ });
    expect(created.status).toBe(302);
    // Straight to step 3 with the new business already chosen.
    expect(created.headers.get("location")).toContain("/qrs/claim/details");
  });

  it("keeps what the user typed when validation fails", async () => {
    const { cookie } = await account("bizerr");
    const serial = await stand();

    // Missing the required address.
    const res = await post(cookie, "/qrs/claim/business", {
      qr: serial,
      create: "1",
      ...BIZ,
      address: "",
    });
    // Re-rendered, not redirected: a redirect here would throw away the name,
    // city and everything else the user had already entered.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Corner Cafe"); // their name, kept
    expect(html).toContain("Pune"); // their city, kept
    expect(html).toContain(serial); // the scanned serial, kept
  });

  it("does not nest a form inside a form", async () => {
    const { cookie } = await account("nofnest");
    const serial = await stand();
    const res = await get(cookie, `/qrs/claim/business?qr=${serial}`);
    const html = await res.text();
    // The hidden serial/create fields have to reach the POST, which is why they
    // live inside BusinessForm's own form rather than in a wrapper around it.
    const opens = (html.match(/<form\b/gi) ?? []).length;
    const closes = (html.match(/<\/form>/gi) ?? []).length;
    expect(opens).toBe(closes);
    expect(html).toContain('name="create"');
    expect(html).toContain(`name="qr" value="${serial}"`);
  });
});

describe("ownership and privacy at the route layer", () => {
  it("will not let a stranger's business be attached", async () => {
    const { user: victim, cookie: victimCookie } = await account("victim");
    const { cookie: attackerCookie } = await account("attacker");
    const business = await createBusiness(env.DB, victim.id, {
      ...BIZ,
      custom_category: null,
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });
    const serial = await stand();

    const res = await post(attackerCookie, "/qrs/claim/business", {
      qr: serial,
      business_id: business.id,
    });
    // Re-rendered with an error rather than accepted, and the flow did not
    // advance.
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("/qrs/claim/details");

    // Sanity: the victim can still use their own business.
    const ok = await post(victimCookie, "/qrs/claim/business", {
      qr: serial,
      business_id: business.id,
    });
    expect(ok.headers.get("location")).toContain("/qrs/claim/details");
  });

  it("sends someone else's claimed QR away without naming its owner", async () => {
    const { user: owner, cookie: ownerCookie } = await account("owner");
    const { cookie: strangerCookie } = await account("stranger");
    const business = await createBusiness(env.DB, owner.id, {
      ...BIZ,
      custom_category: null,
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });
    const serial = await stand();
    await post(ownerCookie, "/qrs/claim/business", { qr: serial, business_id: business.id });
    await post(ownerCookie, "/qrs/claim/review", { qr: serial, business_id: business.id, ...CLAIM });
    await post(ownerCookie, "/qrs/claim", { qr: serial, business_id: business.id, ...CLAIM });

    const res = await get(strangerCookie, `/qrs/claim/business?qr=${serial}`);
    expect(res.status).toBe(302);
    const body = `${res.headers.get("location")}`;
    expect(body).toContain("qr-already-claimed");
    // No owner identity in the redirect.
    expect(body).not.toContain(owner.email);
  });

  it("does not show a success page for a serial that is not yours", async () => {
    const { cookie: strangerCookie } = await account("fakesuccess");
    const serial = await stand();

    // A guessable URL must not be able to render a convincing "you claimed a QR"
    // screen from a made-up serial.
    const notMine = await get(strangerCookie, `/qrs/claim/success?qr=${serial}`);
    expect(notMine.status).toBe(302);
    expect(notMine.headers.get("location")).toContain("qr-not-yours");

    const nonsense = await get(strangerCookie, "/qrs/claim/success?qr=SQ-ZZZZZZ");
    expect(nonsense.status).toBe(302);
  });
});

describe("validation errors are visible", () => {
  it("re-renders step 3 with the failing field marked", async () => {
    const { user, cookie } = await account("valerr");
    const business = await createBusiness(env.DB, user.id, {
      ...BIZ,
      custom_category: null,
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });
    const serial = await stand();
    await post(cookie, "/qrs/claim/business", { qr: serial, business_id: business.id });

    // Reach step 4, then claim with a junk destination.
    const reviewed = await post(cookie, "/qrs/claim/review", {
      qr: serial,
      business_id: business.id,
      ...CLAIM,
    });
    expect(reviewed.status).toBe(200);

    const res = await post(cookie, "/qrs/claim", {
      qr: serial,
      business_id: business.id,
      ...CLAIM,
      destination: "javascript:alert(1)",
    });
    // Rendered with the error, and the values they typed are still there.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-error-for="destination"');
    expect(html).toContain("Counter"); // their name survived
    expect(user.id).toBeTruthy();
  });
});

describe("GET /q/:serial (the printed URL)", () => {
  it("404s an unknown or malformed serial", async () => {
    expect((await getPublic("/q/SQ-ZZZZZZ")).status).toBe(404);
    expect((await getPublic("/q/not-a-serial")).status).toBe(404);

    const serial = generateIdentifier();
    expect((await getPublic(`/q/${serial}`)).status).toBe(404);
  });

  it("sends an anonymous visitor at an unclaimed stand to sign in", async () => {
    const serial = await stand();
    const res = await getPublic(`/q/${serial}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("302s a claimed, live stand to its destination", async () => {
    const { user, cookie } = await account("public");
    const business = await createBusiness(env.DB, user.id, {
      ...BIZ,
      custom_category: null,
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });
    const serial = await stand();
    await post(cookie, "/qrs/claim/business", { qr: serial, business_id: business.id });
    await post(cookie, "/qrs/claim/review", { qr: serial, business_id: business.id, ...CLAIM });
    await post(cookie, "/qrs/claim", { qr: serial, business_id: business.id, ...CLAIM });

    // Anonymous scan: the whole point of a printed stand.
    const res = await getPublic(`/q/${serial}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(CLAIM.destination);
  });

  it("refuses to serve an archived stand", async () => {
    const { user, cookie } = await account("arch");
    const business = await createBusiness(env.DB, user.id, {
      ...BIZ,
      custom_category: null,
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });
    const serial = await stand();
    await post(cookie, "/qrs/claim/business", { qr: serial, business_id: business.id });
    await post(cookie, "/qrs/claim/review", { qr: serial, business_id: business.id, ...CLAIM });
    await post(cookie, "/qrs/claim", { qr: serial, business_id: business.id, ...CLAIM });

    // Archive it, the way the management screen will.
    const { archiveAsset } = await import("../src/db/qr-registry");
    const { getAssetViewByIdentifier } = await import("../src/db/qr-registry");
    const asset = await getAssetViewByIdentifier(env.DB, serial);
    await archiveAsset(env.DB, asset!.id, user.id);

    // The printed code still resolves — it is permanent — but it must not
    // redirect somewhere the owner retired it from.
    const res = await getPublic(`/q/${serial}`);
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
  });

  it("sends a signed-in visitor at an unclaimed stand into the claim flow", async () => {
    // The regression this pins: an unowned stand is claimable by anyone, so a
    // signed-in user must NOT be shown a 404 as if someone else already had it.
    const { cookie } = await account("unowned");
    const serial = await stand();
    const res = await get(cookie, `/q/${serial}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/qrs/claim?qr=${serial}`);
  });

  it("pre-fills the serial on step 1 so it is not scanned twice", async () => {
    const { cookie } = await account("prefill");
    const serial = await stand();
    const res = await get(cookie, `/qrs/claim?qr=${serial}`);
    const html = await res.text();
    expect(html).toContain(`value="${serial}"`);
    // Step 2 is still a real GET submit of that field, so the no-JS path works.
    expect(html).toContain('action="/qrs/claim/business"');
  });

  it("handles a half-claimed stand: owner resumes, everyone else 404s", async () => {
    // The registry CHECK makes owner-without-business impossible, but it does
    // not require the linked qr_codes row to carry a destination. So a stand
    // that is owned and linked with no target IS reachable - a half-finished
    // configure, or a row from before this migration. The public route has to
    // stay non-leaking in that state: the owner resumes setup, and a stranger
    // learns nothing, not even that the code is real.
    const { user, cookie } = await account("halfdone");
    const business = await createBusiness(env.DB, user.id, {
      ...BIZ,
      custom_category: null,
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });
    const serial = await stand();
    const { getAssetViewByIdentifier } = await import("../src/db/qr-registry");
    const asset = await getAssetViewByIdentifier(env.DB, serial);

    // A linked configuration row with no destination.
    const qrId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO qr_codes
         (id, user_id, type, title, is_dynamic, short_code, destination, content_json, design_json, business_id, created_at, updated_at)
       VALUES (?, ?, 'url', 'Half-claimed', 1, ?, NULL, '{}', '{}', ?, ?, ?)`,
    )
      .bind(qrId, user.id, "hc" + crypto.randomUUID().slice(0, 6), business.id, now, now)
      .run();
    await env.DB.prepare(
      `UPDATE qr_registry
          SET owner_id = ?, business_id = ?, status = 'claimed', claimed_at = ?, qr_code_id = ?
        WHERE id = ?`,
    )
      .bind(user.id, business.id, now, qrId, asset!.id)
      .run();

    const owner = await get(cookie, `/q/${serial}`);
    expect(owner.status).toBe(302);
    expect(owner.headers.get("location")).toBe(`/qrs/claim/details?qr=${serial}`);

    expect((await getPublic(`/q/${serial}`)).status).toBe(404);
    const { cookie: otherCookie } = await account("halfdone-other");
    expect((await get(otherCookie, `/q/${serial}`)).status).toBe(404);
  });

  it("keeps working for a legacy dynamic QR that has no registry row", async () => {
    // Existing users' codes live at /r/<short>, not /q/SQ-…, and a short code
    // is not a serial. The public route must 404 rather than mistake one for
    // the other or try to claim it.
    const user = await createUser(env.DB, `legacy-${crypto.randomUUID()}@example.com`);
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Legacy",
      is_dynamic: true,
      short_code: "leg" + crypto.randomUUID().slice(0, 6),
      destination: "https://example.com/legacy",
      content_json: JSON.stringify({ url: "https://example.com/legacy" }),
      design_json: "{}",
    });
    const res = await getPublic(`/q/${qr.short_code}`);
    expect(res.status).toBe(404);
  });
});

describe("reaching the flow from the dashboard", () => {
  it("offers claiming a printed stand on both an empty and a populated dashboard", async () => {
    // A stand can arrive before the account has any digital code, so the entry
    // point cannot live only behind the "New QR" header button.
    const empty = await createUser(env.DB, `dempty-${crypto.randomUUID()}@example.com`);
    const emptyCookie = (await startSession(env, empty.id)).split(";")[0];
    const emptyHtml = await (
      await dashboard.fetch(
        new Request("https://q.test/app", { headers: { Cookie: emptyCookie } }),
        env,
        makeCtx(),
      )
    ).text();
    expect(emptyHtml).toContain("Connect a printed stand");
    expect(emptyHtml).toContain('href="/qrs/claim"');

    const populated = await createUser(env.DB, `dfull-${crypto.randomUUID()}@example.com`);
    await createQr(env.DB, {
      user_id: populated.id,
      type: "url",
      title: "Existing",
      content_json: "{}",
      design_json: "{}",
    });
    const fullCookie = (await startSession(env, populated.id)).split(";")[0];
    const fullHtml = await (
      await dashboard.fetch(
        new Request("https://q.test/app", { headers: { Cookie: fullCookie } }),
        env,
        makeCtx(),
      )
    ).text();
    expect(fullHtml).toContain("Claim a printed stand");
    expect(fullHtml).toContain('href="/qrs/claim"');
  });
});

describe("managing stands (/qrs and /qrs/:id)", () => {
  /** Claim a stand end to end and hand back the account that owns it. */
  async function claimed(tag: string) {
    const { user, cookie } = await account(tag);
    const business = await createBusiness(env.DB, user.id, {
      ...BIZ,
      custom_category: null,
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });
    const serial = await stand();
    await post(cookie, "/qrs/claim/business", { qr: serial, business_id: business.id });
    await post(cookie, "/qrs/claim/review", { qr: serial, business_id: business.id, ...CLAIM });
    await post(cookie, "/qrs/claim", { qr: serial, business_id: business.id, ...CLAIM });
    const { getAssetViewByIdentifier } = await import("../src/db/qr-registry");
    const asset = await getAssetViewByIdentifier(env.DB, serial);
    return { user, cookie, business, serial, id: asset!.id };
  }

  it("404s the management list without a session and lists stands with one", async () => {
    expect((await getPublic("/qrs")).status).toBe(302);

    const { cookie, serial } = await claimed("list");
    const html = await (await get(cookie, "/qrs")).text();
    expect(html).toContain("Sqanny Stands");
    expect(html).toContain(serial);
  });

  it("explains itself when the account has no stands", async () => {
    const { cookie } = await account("nolist");
    const html = await (await get(cookie, "/qrs")).text();
    expect(html).toContain("No stands yet");
    expect(html).toContain('href="/qrs/claim"');
  });

  it("filters the list by search, business and status", async () => {
    const { cookie, business, serial } = await claimed("filter");
    await claimed("filter-other");

    const hit = await (await get(cookie, `/qrs?q=${serial}`)).text();
    expect(hit).toContain(serial);
    expect(hit).not.toContain("Nothing matches");

    const byBusiness = await (await get(cookie, `/qrs?business=${business.id}`)).text();
    expect(byBusiness).toContain(serial);

    // A nonsense status is dropped rather than producing a silent empty list.
    const bad = await (await get(cookie, "/qrs?status=not-a-status")).text();
    expect(bad).toContain(serial);

    // After retiring it, filtering by active excludes it.
    await post(cookie, `/qrs/${(await assetId(cookie, serial))}/archive`, {});
    const archived = await (await get(cookie, "/qrs?status=archived")).text();
    expect(archived).toContain(serial);
  });

  it("shows the permanent code and current destination on the detail page", async () => {
    const { cookie, id, serial } = await claimed("detail");
    const html = await (await get(cookie, `/qrs/${id}`)).text();
    expect(html).toContain(serial);
    expect(html).toContain(CLAIM.destination);
    // The permanent link is under /q/, not the internal /r/ redirect key.
    expect(html).toContain(`/q/${serial}`);
  });


  it("retargets a stand without changing its printed code", async () => {
    const { cookie, id, serial } = await claimed("repoint");
    const next = "https://example.com/moved";
    const res = await post(cookie, `/qrs/${id}/edit`, {
      name: "Counter",
      business_id: (await businessOf(cookie, id)),
      category: "reviews",
      placement: "Cash Desk",
      destination: next,
    });
    expect(res.status).toBe(302);

    // The printed URL still resolves, and now goes somewhere new.
    const asset = await (await import("../src/db/qr-registry")).getAssetViewByIdentifier(
      env.DB,
      serial,
    );
    expect(asset!.qr_identifier).toBe(serial);
    expect(asset!.destination).toBe(next);
    expect((await getPublic(`/q/${serial}`)).headers.get("location")).toBe(next);
  });

  it("rejects a bad destination on edit and keeps the stand unchanged", async () => {
    const { cookie, id, serial } = await claimed("baddest");
    const res = await post(cookie, `/qrs/${id}/edit`, {
      name: "Counter",
      business_id: await businessOf(cookie, id),
      category: "reviews",
      placement: "",
      destination: "javascript:alert(1)",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("err_destination");

    const asset = await (await import("../src/db/qr-registry")).getAssetViewByIdentifier(
      env.DB,
      serial,
    );
    expect(asset!.destination).toBe(CLAIM.destination);
  });

  it("refuses to move a stand to a business the caller does not belong to", async () => {
    const { user, cookie, id } = await claimed("crossbiz");
    const { user: stranger, cookie: strangerCookie } = await account("crossbiz-other");
    const theirs = await createBusiness(env.DB, stranger.id, {

      ...BIZ,
      name: "Not Yours",
      custom_category: null,
      phone: null,
      email: null,
      website: null,
      google_business_url: null,
      instagram_url: null,
      facebook_url: null,
      description: null,
      logo_key: null,
      hours_json: null,
    });
    expect(strangerCookie).toBeTruthy();

    const res = await post(cookie, `/qrs/${id}/edit`, {
      name: "Counter",
      business_id: theirs.id,
      category: "reviews",
      placement: "",
      destination: "https://example.com/stolen",
    });
expect(res.status).toBe(302);

    // Refused as a FIELD error on the business select, not as a flash. The
    // reason it moved from a flash to a field is that a rejected edit now
    // round-trips everything the user typed: a flash would have bounced them
    // back to the stored configuration and thrown away their destination,
    // placement and category to protect a single field.
    const location = res.headers.get("location")!;
    expect(location).toContain("err_business");
    // Their other answers survive the rejection.
    expect(location).toContain("https%3A%2F%2Fexample.com%2Fstolen");

    // And the stand is genuinely unchanged: still under the original business.
    const after = await getAssetViewForOwner(env.DB, id, user.id);
    expect(after?.business_id).not.toBe(theirs.id);
  });

  it("retires a stand, stops serving it, and restores it", async () => {
    const { cookie, id, serial } = await claimed("lifecycle");

    await post(cookie, `/qrs/${id}/archive`, {});
    expect((await getPublic(`/q/${serial}`)).status).toBe(410);

    const retired = await (await get(cookie, `/qrs/${id}`)).text();
    expect(retired).toContain("This stand is retired");
    // A retired stand must not offer the retarget form.
    expect(retired).not.toContain('name="destination"');

    await post(cookie, `/qrs/${id}/restore`, {});
    expect((await getPublic(`/q/${serial}`)).status).toBe(302);
  });

  it("never shows another account's stand", async () => {
    const { cookie: otherCookie } = await account("cross-tenant");
    const { id, serial } = await claimed("cross-tenant-mine");
    expect((await get(otherCookie, `/qrs/${id}`)).status).toBe(404);
    // And the action endpoints are owner-scoped too, not just the read.
    const arch = await post(otherCookie, `/qrs/${id}/archive`, {});
    expect(arch.status).toBe(302);
    // Still live, so the stranger's archive attempt did nothing.
    expect((await getPublic(`/q/${serial}`)).status).toBe(302);
  });

  it("does not offer editing a stand that is not the caller's", async () => {
    const { cookie: otherCookie } = await account("cross-edit");
    const { id } = await claimed("cross-edit-mine");
    const res = await post(otherCookie, `/qrs/${id}/edit`, {
      name: "Hijacked",
      business_id: "whatever",
      category: "reviews",
      placement: "",
      destination: "https://evil.example",
    });
    expect(res.status).toBe(404);
  });

  async function assetId(cookie: string, serial: string): Promise<string> {
    const { getAssetViewByIdentifier } = await import("../src/db/qr-registry");
    return (await getAssetViewByIdentifier(env.DB, serial))!.id;
  }
  async function businessOf(cookie: string, id: string): Promise<string> {
    const html = await (await get(cookie, `/qrs/${id}`)).text();
    return /name="business_id"[\s\S]*?<option value="([^"]+)"/.exec(html)![1];
  }
});
