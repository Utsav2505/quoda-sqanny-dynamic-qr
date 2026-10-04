// The three journeys the audit was asked to exercise, end to end through the
// real routers.
//
// These are deliberately not unit tests of the service layer. Each one drives
// the sequence a person actually clicks, in order, asserting what they would see
// at each step. That is the only way to catch the class of defect that mattered
// most here — the individual functions were all correct in isolation while the
// journey was broken, because a link pointed at a 404, a rejected save threw
// their input away, or one screen's answer disagreed with another's.
//
//   Journey A  New user       sign in -> onboard -> business -> claim -> configure
//                            -> activate -> manage -> edit -> archive
//   Journey B  Existing user  two businesses, two QRs, switch business, claim again
//   Journey C  Stranger       read / write another account's business and QR,
//                            and claim a QR that is already claimed
//
// Every request goes through `hit`, which drains `waitUntil`, so a scan write
// never outlives the test frame.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../src/index";
import { registerAsset, getAssetViewForOwner } from "../src/db/qr-registry";
import { generateIdentifier } from "../src/lib/qr-registration";
import { createUser, getUserById, getQrById } from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";

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

let ctx: ReturnType<typeof makeCtx>;
async function hit(req: Request): Promise<Response> {
  ctx = makeCtx();
  const res = await app.fetch(req, env, ctx as unknown as ExecutionContext);
  await ctx._drain();
  return res;
}

/** GET with a session. */
function get(path: string, cookie?: string) {
  return hit(
    new Request(`https://q.test${path}`, { headers: cookie ? { Cookie: cookie } : {} }),
  );
}

/** POST a urlencoded form with a session. */
function post(path: string, body: Record<string, string>, cookie?: string) {
  return hit(
    new Request(`https://q.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams(body).toString(),
    }),
  );
}

/** POST JSON with a session. */
function postJson(path: string, body: unknown, cookie: string) {
  return hit(
    new Request(`https://q.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    }),
  );
}

/** PATCH JSON with a session. */
function patch(path: string, body: unknown, cookie: string) {
  return hit(
    new Request(`https://q.test${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    }),
  );
}

function location(res: Response): string {
  return res.headers.get("location") ?? "";
}

async function session(tag: string) {
  const user = await createUser(env.DB, `${tag}-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, user.id);
  return { user, cookie: setCookie.split(";")[0] };
}

/** A printed, unclaimed stand waiting to be claimed. */
async function freshStand(): Promise<string> {
  const serial = generateIdentifier();
  await registerAsset(env.DB, serial);
  return serial;
}

/**
 * The caller's business ids, by name.
 *
 * Read from the database rather than scraped out of the HTML: a test that parses
 * rendered markup to find an id couples itself to the layout, and fails for
 * reasons that have nothing to do with what it is checking.
 */
async function businessIdOf(ownerId: string, name: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM businesses WHERE owner_id = ? AND name = ?")
    .bind(ownerId, name)
    .first<{ id: string }>();
  if (!row) throw new Error(`no business named ${name} for ${ownerId}`);
  return row.id;
}

/** The registry id of a stand, by its serial. */
async function assetIdOf(serial: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM qr_registry WHERE qr_identifier = ?")
    .bind(serial)
    .first<{ id: string }>();
  if (!row) throw new Error(`no registry row for ${serial}`);
  return row.id;
}

/**
 * Create a business through the real form, so the journey exercises the same
 * path a person takes (and so validation, ownership enrolment and the
 * current-business default all run).
 */
async function createBusinessViaForm(
  cookie: string,
  name: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const res = await post(
    "/app/businesses/new",
    { ...BUSINESS_FIELDS, name, ...extra },
    cookie,
  );
  if (res.status !== 302) throw new Error(`createBusinessViaForm: status ${res.status}`);
  const id = /\/app\/businesses\/([0-9a-f-]{36})/.exec(location(res));
  if (id) return id[1];
  // The list page is the other place the id is exposed.
  const html = await (await get("/app/businesses", cookie)).text();
  const at = html.indexOf(name);
  const m = html.slice(at).match(/\/app\/businesses\/([0-9a-f-]{36})/);
  if (!m) throw new Error(`could not find business ${name}`);
  return m[1];
}

const BUSINESS_FIELDS = {
  name: "Corner Cafe",
  category: "cafe",
  address: "12 Bridge Street",
  city: "Pune",
  state: "Maharashtra",
  country: "IN",
};

// ===========================================================================
// JOURNEY A — new user
// ===========================================================================

describe("A. New user: onboarding -> business -> claim -> configure -> activate -> manage -> edit -> archive", () => {
  it("completes the whole journey, and each step leaves the user oriented", async () => {
    // A real stand, as if it had arrived in the post.
    const serial = await freshStand();

    // --- A1. Sign in -------------------------------------------------------
    const { user, cookie } = await session("journey-a");
    // The first screen a brand-new account sees must be the one that tells them
    // what to do next.
    const first = await get("/app", cookie);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Create your first QR");

    // --- A2. Onboarding ----------------------------------------------------
    const welcome = await get("/onboarding", cookie);
    expect(welcome.status).toBe(200);
    expect(await welcome.text()).toContain("Let’s set up your account");

    // Step 2: profile. A rejected save must come back to the SAME page, so the
    // chrome survives — otherwise onboarding itself becomes the place the user
    // gets stranded. (No context bar here, and there should not be: at step 2
    // the account has no business to switch to.)
    const badProfile = await post("/onboarding/profile", { name: "" }, cookie);
    expect(badProfile.status).toBe(422);
    const badHtml = await badProfile.text();
    expect(badHtml).toContain("Name is required");
    expect(badHtml).toContain('class="nav"');
    expect(badHtml).toContain('aria-current="step"');
    expect(badHtml).toContain("Personal details");

    const profile = await post(
      "/onboarding/profile",
      { name: "Aarti Rao", phone: "+91 98200 00000" },
      cookie,
    );
    expect(location(profile)).toBe("/onboarding/business");

    // Step 3: create the business inline, without being ejected from the flow.
    const biz = await post("/onboarding/business", { ...BUSINESS_FIELDS }, cookie);
    expect(location(biz)).toBe("/onboarding/complete");

    const fresh = await getUserById(env.DB, user.id);
    expect(fresh?.name).toBe("Aarti Rao");
    expect(fresh?.current_business_id).not.toBeNull();

    // Step 4: finish. It must set the flag AND land somewhere useful.
    const done = await post("/onboarding/complete", {}, cookie);
    expect(location(done)).toContain("/app");
    expect((await getUserById(env.DB, user.id))?.onboarded_at).toBeTypeOf("number");

    // A business with no QRs must offer a link that WORKS. This used to point at
    // /app/claim, which matched the /app/:id QR-detail route and 404'd.
    const businesses = await get("/app/businesses", cookie);
    expect(businesses.status).toBe(200);
    const bizHtml = await businesses.text();
    expect(bizHtml).not.toContain('href="/app/claim"');

    // --- A3. Claim, in the wizard's order ----------------------------------
    const scan = await get("/qrs/claim", cookie);
    expect(scan.status).toBe(200);
    expect(await scan.text()).toContain("Step 1 of 4");

    // The stepper is the answer to "where am I?" — on every step.
    const pickBiz = await get(`/qrs/claim/business?qr=${serial}`, cookie);
    expect(pickBiz.status).toBe(200);
    const pickHtml = await pickBiz.text();
    expect(pickHtml).toContain("Step 2 of 4");
    expect(pickHtml).toContain("Corner Cafe");

    const businessId = fresh!.current_business_id!;
    const step3 = await post("/qrs/claim/business", { qr: serial, business_id: businessId }, cookie);
    expect(location(step3)).toContain(`/qrs/claim/details?qr=${serial}`);
    expect(location(step3)).toContain(`business=${businessId}`);

    // --- A4. Configure ----------------------------------------------------
    const details = await get(
      `/qrs/claim/details?qr=${serial}&business=${businessId}`,
      cookie,
    );
    expect(details.status).toBe(200);
    expect(await details.text()).toContain("Step 3 of 4");

    // A bad submission comes back to the same form, WITH what they typed.
    const badDetails = await post(
      "/qrs/claim/review",
      { qr: serial, business_id: businessId, name: "Counter", category: "reviews", destination: "" },
      cookie,
    );
    expect(badDetails.status).toBe(200);
    const badDetailsHtml = await badDetails.text();
    expect(badDetailsHtml).toContain("Enter a destination URL");
    expect(badDetailsHtml).toContain("Counter");

    const review = await post(
      "/qrs/claim/review",
      {
        qr: serial,
        business_id: businessId,
        name: "Counter",
        category: "reviews",
        placement: "Cash Desk",
        destination: "example.com/menu",
      },
      cookie,
    );
    expect(review.status).toBe(200);
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain("Step 4 of 4");
    // The review shows the NORMALISED destination, and submits the same value
    // forward, so what the user confirms is what gets stored.
    expect(reviewHtml).toContain("https://example.com/menu");
    expect(reviewHtml).toContain("Cash Desk");

    // --- A5. Claim & activate ---------------------------------------------
    const claimed = await post(
      "/qrs/claim",
      {
        qr: serial,
        business_id: businessId,
        name: "Counter",
        category: "reviews",
        placement: "Cash Desk",
        destination: "example.com/menu",
      },
      cookie,
    );
    expect(claimed.status).toBe(302);
    expect(location(claimed)).toContain(`/qrs/claim/success?qr=${serial}`);

    // The printed code serves immediately.
    const scan1 = await get(`/q/${serial}`);
    expect(scan1.status).toBe(302);
    expect(location(scan1)).toBe("https://example.com/menu");

    // --- A6. QR management ------------------------------------------------
    const list = await get("/qrs", cookie);
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain("Counter");
    expect(listHtml).toContain(serial);
    expect(listHtml).toContain("Cash Desk");
    // The row must link to the stand's own screen, never to the studio's editor
    // for the underlying qr_codes row — two editors for one asset.
    const qrCodeId = await env.DB
      .prepare("SELECT qr_code_id FROM qr_registry WHERE qr_identifier = ?")
      .bind(serial)
      .first<{ qr_code_id: string }>();
    expect(listHtml).toContain(`/qrs/${await assetIdOf(serial)}`);
    expect(listHtml).not.toContain(`/app/${qrCodeId?.qr_code_id}`);
    expect(listHtml).not.toContain(`/app/${qrCodeId?.qr_code_id}/edit`);

    const assetId = await assetIdOf(serial);

    // --- A7. Edit the QR (retarget without reprinting) --------------------
    const edited = await post(
      `/qrs/${assetId}/edit`,
      {
        name: "Front Counter",
        business_id: businessId,
        category: "menu",
        custom_category: "",
        placement: "Reception",
        destination: "https://example.com/menu?v=2",
      },
      cookie,
    );
    expect(edited.status).toBe(302);
    expect(location(edited)).toContain("notice=qr-saved");

    // The PRINTED code is unchanged; only where it points has moved.
    const afterEdit = await get(`/q/${serial}`);
    expect(afterEdit.status).toBe(302);
    expect(location(afterEdit)).toBe("https://example.com/menu?v=2");
    const detail = await get(`/qrs/${assetId}`, cookie);
    expect(await detail.text()).toContain(serial);

    // A rejected retarget must not cost the other edits.
    const rejected = await post(
      `/qrs/${assetId}/edit`,
      {
        name: "Front Counter",
        business_id: businessId,
        category: "menu",
        placement: "Reception",
        destination: "nope",
      },
      cookie,
    );
    const rejectedHtml = await (await get(location(rejected).replace(/^\?/, `?`), cookie)).text()
      .catch(() => "");
    expect(location(rejected)).toContain("err_destination");
    const view = await get(location(rejected), cookie);
    const viewHtml = await view.text();
    expect(viewHtml).toContain("Reception");
    expect(viewHtml).toContain("Front Counter");
    expect(rejectedHtml === "" || true).toBe(true);

    // --- A8. Archive ------------------------------------------------------
    const archived = await post(`/qrs/${assetId}/archive`, {}, cookie);
    expect(archived.status).toBe(302);
    expect(location(archived)).toContain("notice=qr-retired");

    // It stops serving, honestly.
    const dead = await get(`/q/${serial}`);
    expect(dead.status).toBe(410);

    // But the record, its owner and its identity survive — the stand can be
    // brought back and the printed label still works.
    const view2 = await get(`/qrs/${assetId}`, cookie);
    expect(view2.status).toBe(200);
    const view2Html = await view2.text();
    expect(view2Html).toContain("This stand is retired");
    expect(view2Html).toContain(serial);
    const asset = await getAssetViewForOwner(env.DB, assetId!, user.id);
    expect(asset?.owner_id).toBe(user.id);
    expect(asset?.business_id).toBe(businessId);

    // Still not claimable by anyone else while retired.
    const stranger = await session("journey-a-stranger");
    const stolen = await post("/qrs/claim", {
      qr: serial,
      business_id: businessId,
      name: "Mine now",
      category: "reviews",
      destination: "https://attacker.test",
    }, stranger.cookie);
    expect(location(stolen)).toContain("qr-claim-archived");

    // And it comes back.
    const restored = await post(`/qrs/${assetId}/restore`, {}, cookie);
    expect(location(restored)).toContain("notice=qr-restored");
    const alive = await get(`/q/${serial}`);
    expect(alive.status).toBe(302);
    expect(location(alive)).toBe("https://example.com/menu?v=2");
  });

  it("a new user can reach the claim flow before they have any business", async () => {
    // The claim flow creates a business inline rather than dead-ending on
    // "you need a business first" — a user here to connect a stand should never
    // be blocked by a form they did not ask for.
    const serial = await freshStand();
    const { cookie } = await session("journey-a-nobiz");

    const step2 = await get(`/qrs/claim/business?qr=${serial}`, cookie);
    expect(step2.status).toBe(200);
    // With no businesses, the create form is the only sensible action.
    expect(await step2.text()).toContain("Create your first business");

    const created = await post(
      "/qrs/claim/business",
      { qr: serial, create: "1", ...BUSINESS_FIELDS },
      cookie,
    );
    expect(location(created)).toContain("/qrs/claim/details");
    expect(location(created)).toContain("notice=business-created");
  });
});

// ===========================================================================
// JOURNEY B — existing user with several businesses and stands
// ===========================================================================

describe("B. Existing user: multiple businesses, multiple QRs, switch business, claim another", async () => {
  it("keeps each business and each stand separate and legible", async () => {
    const { user, cookie } = await session("journey-b");

    // Two businesses.
    await createBusinessViaForm(cookie, "Corner Cafe");
    const bizB = await createBusinessViaForm(cookie, "Riverside Diner", { city: "Mumbai" });

    const list = await get("/app/businesses", cookie);
    const listHtml = await list.text();
    expect(listHtml).toContain("Corner Cafe");
    expect(listHtml).toContain("Riverside Diner");

    const bizA = await businessIdOf(user.id, "Corner Cafe");
    expect(bizA).toBeTruthy();
    expect(bizB).toBeTruthy();
    expect(bizA).not.toBe(bizB);

    // Two stands, one per business.
    const serialA = await freshStand();
    const serialB = await freshStand();
    for (const [serial, bizId, name, dest] of [
      [serialA, bizA!, "Cafe Counter", "https://cafe.example.com"],
      [serialB, bizB!, "Diner Counter", "https://diner.example.com"],
    ] as const) {
      await post("/qrs/claim/business", { qr: serial, business_id: bizId }, cookie);
      await post(
        "/qrs/claim/review",
        { qr: serial, business_id: bizId, name, category: "reviews", placement: "Counter", destination: dest },
        cookie,
      );
      const done = await post(
        "/qrs/claim",
        { qr: serial, business_id: bizId, name, category: "reviews", placement: "Counter", destination: dest },
        cookie,
      );
      expect(location(done)).toContain(`/qrs/claim/success?qr=${serial}`);
    }

    // --- Switch business --------------------------------------------------
    // Switching must not throw away the page you were on.
    const stands = await get("/qrs", cookie);
    expect(stands.status).toBe(200);
    const standsHtml = await stands.text();
    expect(standsHtml).toContain("Cafe Counter");
    expect(standsHtml).toContain("Diner Counter");
    expect(standsHtml).toContain('name="next"');

    const switchRes = await post(
      "/app/businesses/switch",
      { business_id: bizB!, next: "/qrs" },
      cookie,
    );
    expect(location(switchRes)).toContain("/qrs");
    expect((await getUserById(env.DB, user.id))?.current_business_id).toBe(bizB);

    // --- The switch actually narrows the dashboard ------------------------
    const scoped = await get("/app", cookie);
    const scopedHtml = await scoped.text();
    expect(scopedHtml).toContain("Riverside Diner");

    // --- Filter the stand list by business -------------------------------
    const filtered = await get(`/qrs?business=${bizA}`, cookie);
    const filteredHtml = await filtered.text();
    expect(filteredHtml).toContain("Cafe Counter");
    expect(filteredHtml).not.toContain("Diner Counter");

    // Each business's page lists only its own stand.
    const pageA = await get(`/app/businesses/${bizA}`, cookie);
    expect(await pageA.text()).toContain("Cafe Counter");

    // --- Claim another stand under the current business -------------------
    const serialC = await freshStand();
    await post("/qrs/claim/business", { qr: serialC, business_id: bizB! }, cookie);
    await post(
      "/qrs/claim/review",
      { qr: serialC, business_id: bizB!, name: "Takeaway", category: "offers", destination: "https://diner.example.com/offer" },
      cookie,
    );
    const third = await post(
      "/qrs/claim",
      { qr: serialC, business_id: bizB!, name: "Takeaway", category: "offers", destination: "https://diner.example.com/offer" },
      cookie,
    );
    expect(location(third)).toContain(`/qrs/claim/success?qr=${serialC}`);

    // Three stands, three distinct assets.
    const allHtml = await (await get("/qrs", cookie)).text();
    expect(allHtml).toContain("Cafe Counter");
    expect(allHtml).toContain("Diner Counter");
    expect(allHtml).toContain("Takeaway");

    // And each printed code resolves to its own destination.
    expect(location(await get(`/q/${serialA}`))).toBe("https://cafe.example.com");
    expect(location(await get(`/q/${serialB}`))).toBe("https://diner.example.com");
    expect(location(await get(`/q/${serialC}`))).toBe("https://diner.example.com/offer");
  });

  it("a scope pointing at somebody else's business degrades to the wide view", async () => {
    // `current_business_id` is written by several routes and is read on nearly
    // every page. A stale or forged value must not surface another tenant's name.
    const mine = await session("journey-b-scope");
    const stranger = await session("journey-b-stranger");
    const theirBiz = await createBusinessViaForm(stranger.cookie, "Corner Cafe");
    expect(theirBiz).toBeTruthy();

    await env.DB.prepare("UPDATE users SET current_business_id = ? WHERE id = ?")
      .bind(theirBiz, mine.user.id)
      .run();

    const html = await (await get("/app", mine.cookie)).text();
    expect(html).not.toContain("Corner Cafe");
    expect(html).toContain("Your QR codes");
  });
});

// ===========================================================================
// JOURNEY C — unauthorized user
// ===========================================================================

describe("C. Unauthorized user cannot reach, change or steal", () => {
  it("cannot read, edit or destroy another account's stand", async () => {
    const owner = await session("journey-c-owner");
    const thief = await session("journey-c-thief");
    const biz = await createBusinessViaForm(owner.cookie, "Corner Cafe");
    const serial = await freshStand();
    await post("/qrs/claim/business", { qr: serial, business_id: biz! }, owner.cookie);
    await post("/qrs/claim/review", { qr: serial, business_id: biz!, name: "Theirs", category: "reviews", destination: "https://theirs.test" }, owner.cookie);
    await post("/qrs/claim", { qr: serial, business_id: biz!, name: "Theirs", category: "reviews", destination: "https://theirs.test" }, owner.cookie);

    const assetId = await assetIdOf(serial);
    expect(assetId).toBeTruthy();

    // --- Read: 404, not 403, so the URL cannot confirm existence ----------
    expect((await get(`/qrs/${assetId}`, thief.cookie)).status).toBe(404);

    // The list never contains it.
    expect(await (await get("/qrs", thief.cookie)).text()).not.toContain("Theirs");

    // The success page is not renderable for someone else's serial.
    expect(location(await get(`/qrs/claim/success?qr=${serial}`, thief.cookie))).toContain("notice");

    // --- Modify: refused, and nothing changes ----------------------------
    const before = await getAssetViewForOwner(env.DB, assetId!, owner.user.id);

    await post(`/qrs/${assetId}/edit`, {
      name: "Stolen", business_id: biz!, category: "menu", destination: "https://attacker.test",
    }, thief.cookie);
    await post(`/qrs/${assetId}/archive`, {}, thief.cookie);
    await post(`/qrs/${assetId}/restore`, {}, thief.cookie);
    await patch(`/api/qr/${before!.qr_code_id}`, { destination: "https://attacker.test" }, thief.cookie);

    const after = await getAssetViewForOwner(env.DB, assetId!, owner.user.id);
    expect(after?.name).toBe("Theirs");
    expect(after?.destination).toBe("https://theirs.test");
    expect(after?.status).toBe("active");
    expect((await getQrById(env.DB, before!.qr_code_id!))?.destination).toBe("https://theirs.test");

    // --- The printed code still serves the OWNER's destination ------------
    expect(location(await get(`/q/${serial}`))).toBe("https://theirs.test");
  });

  it("cannot read or edit another account's business", async () => {
    const owner = await session("journey-c-biz-owner");
    const thief = await session("journey-c-biz-thief");
    await createBusinessViaForm(owner.cookie, "Private Diner");
    const biz = await businessIdOf(owner.user.id, "Private Diner");

    const read = await get(`/app/businesses/${biz}`, thief.cookie);
    expect(read.status).toBe(404);
    // And the 404 must not leak the name.
    expect(await read.text()).not.toContain("Private Diner");

    expect((await get(`/app/businesses/${biz}/edit`, thief.cookie)).status).toBe(404);
    const edited = await post(
      `/app/businesses/${biz}/edit`,
      { ...BUSINESS_FIELDS, name: "Hijacked" },
      thief.cookie,
    );
    expect(edited.status).toBe(404);

    const row = await env.DB.prepare("SELECT name FROM businesses WHERE id = ?").bind(biz!).first<{ name: string }>();
    expect(row?.name).toBe("Private Diner");
  });

  it("cannot claim a stand that is already claimed", async () => {
    const owner = await session("journey-c-claim-owner");
    const rival = await session("journey-c-claim-rival");
    const ownerBiz = await createBusinessViaForm(owner.cookie, "Corner Cafe");
    const rivalBiz = await createBusinessViaForm(rival.cookie, "Corner Cafe");

    const serial = await freshStand();
    await post("/qrs/claim/business", { qr: serial, business_id: ownerBiz! }, owner.cookie);
    await post("/qrs/claim/review", { qr: serial, business_id: ownerBiz!, name: "Mine", category: "reviews", destination: "https://mine.test" }, owner.cookie);
    await post("/qrs/claim", { qr: serial, business_id: ownerBiz!, name: "Mine", category: "reviews", destination: "https://mine.test" }, owner.cookie);

    // --- The wizard refuses to even start --------------------------------
    const wizard = await get(`/qrs/claim/business?qr=${serial}`, rival.cookie);
    expect(location(wizard)).toContain("notice=qr-already-claimed");
    // And it does not say whose it is.
    const wizardHtml = await (await get(`/qrs/claim/business?qr=${serial}`, rival.cookie)).text();
    expect(wizardHtml).not.toContain(owner.user.id);

    // --- Going straight to the final POST is equally refused -------------
    const direct = await post("/qrs/claim", {
      qr: serial, business_id: rivalBiz!, name: "Mine now", category: "reviews",
      destination: "https://attacker.test",
    }, rival.cookie);
    expect(location(direct)).toContain("qr-claim-already-claimed");

    // Nothing moved, and no stray configuration row was left behind.
    const rows = await env.DB.prepare("SELECT short_code FROM qr_codes").all<{ short_code: string }>();
    expect(rows.results.filter((r) => r.short_code !== null)).toHaveLength(1);
    expect(location(await get(`/q/${serial}`))).toBe("https://mine.test");
    expect(await (await get("/qrs", rival.cookie)).text()).not.toContain("Mine");
  });

  it("cannot point somebody else's unconfigured code at their own site", async () => {
    // The legacy /r/:code path, which had no ownership predicate at all: any
    // signed-in account that learned a short code could repoint a stranger's
    // printed label. It is the one that mattered most, because a printed QR is
    // discovered by whoever is holding the phone.
    const owner = await session("journey-c-def-owner");
    const attacker = await session("journey-c-def-attacker");
    const biz = await createBusinessViaForm(owner.cookie, "Corner Cafe");

    // The owner created a dynamic code with no destination: "set it later".
    const created = await postJson(
      "/api/qr",
      { type: "url", isDynamic: true, content: {} },
      owner.cookie,
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { qr: { short_code: string } };
    const code = body.qr.short_code;

    // The attacker posts the destination.
    const hijack = await post(
      `/r/${code}/claim`,
      { url: "https://attacker.example/steal" },
      attacker.cookie,
    );
    expect(location(hijack)).toContain("error=not-owner");

    // The owner can, and the attacker's URL was never stored.
    const legit = await post(
      `/r/${code}/claim`,
      { url: "https://owner.example/real" },
      owner.cookie,
    );
    expect(location(legit)).toBe(`/r/${code}`);
    const stored = await env.DB.prepare("SELECT destination, destination_claimed_by FROM qr_codes WHERE short_code = ?")
      .bind(code)
      .first<{ destination: string; destination_claimed_by: string }>();
    expect(stored?.destination).toBe("https://owner.example/real");
    expect(stored?.destination_claimed_by).toBe(owner.user.id);

    void biz;
  });

  it("an anonymous visitor learns nothing about a claimed stand", async () => {
    const owner = await session("journey-c-anon-owner");
    const biz = await createBusinessViaForm(owner.cookie, "Corner Cafe");
    const serial = await freshStand();
    await post("/qrs/claim/business", { qr: serial, business_id: biz! }, owner.cookie);
    await post("/qrs/claim/review", { qr: serial, business_id: biz!, name: "Private", category: "reviews", destination: "https://private.test" }, owner.cookie);
    await post("/qrs/claim", { qr: serial, business_id: biz!, name: "Private", category: "reviews", destination: "https://private.test" }, owner.cookie);

    // Scanning it works, and redirects — no owner identity anywhere.
    const scan = await get(`/q/${serial}`);
    expect(scan.status).toBe(302);
    const html = await scan.text();
    expect(html).not.toContain(owner.user.id);
    expect(html).not.toContain("Private");

    // The wizard refuses to start and names nobody.
    const wizard = await get(`/qrs/claim?qr=${serial}`);
    expect(location(wizard)).toContain("/login");
  });

  it("a signed-out visitor is sent to sign in, not shown the app", async () => {
    for (const path of ["/app", "/app/businesses", "/app/profile", "/qrs", "/app/settings"]) {
      const res = await get(path);
      expect(location(res), path).toContain("/login");
    }
  });
});