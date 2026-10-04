// Regression tests for the audit findings.
//
// Each block names the defect it pins down and, where the original behaviour was
// a silent failure rather than a crash, states what the user used to see. A test
// that only asserts the new value would pass just as happily if someone reverted
// the fix and changed something else, so these check the OBSERVABLE consequence:
// the bytes on the page, the row in the database, the status code a client sees.
//
// The two hardest-won lessons here, kept in the file headers because they are the
// ones most likely to be undone by a well-meaning refactor:
//
//   1. A physical stand's identity lives in `qr_registry` and its configuration in
//      `qr_codes`. Two writers for one row is how they drift.
//   2. Authorization that lives in the ROUTE is authorization that a second route
//      will forget. Every predicate that matters is in the SQL.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { qrApi } from "../src/routes/api/qr";
import { qrs } from "../src/routes/qrs";
import { dashboard } from "../src/routes/dashboard";
import { businesses } from "../src/routes/businesses";
import { profile } from "../src/routes/profile";
import { studio } from "../src/routes/studio";
import { qrDetail } from "../src/routes/qr-detail";
import {
  assignQrToBusiness,
  createBusiness,
  createQr,
  createUser,
  setCurrentBusiness,
  updateBusinessForUser,
  updateQr,
  deleteQrForUser,
  getQrById,
  getQrByShortCode,
  listQrByUserScoped,
} from "../src/db/queries";
import {
  getAssetViewForOwner,
  getRegistryByQrCodeId,
  registerAsset,
} from "../src/db/qr-registry";
import { claimQr } from "../src/lib/claim";
import { generateIdentifier } from "../src/lib/qr-registration";
import { countScansForQrs } from "../src/lib/analytics";
import { startSession } from "../src/lib/auth/session";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

/** Dispatch and drain, so background scan writes stay inside the test frame. */
async function hit(app: typeof qrApi, req: Request): Promise<Response> {
  const c = makeCtx();
  const res = await app.fetch(req, env, c as unknown as ExecutionContext);
  await c._drain();
  return res;
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const JSONH = { "content-type": "application/json" };

async function session(tag: string) {
  const user = await createUser(env.DB, `${tag}-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, user.id);
  return { user, cookie: setCookie.split(";")[0] };
}

const BIZ = {
  name: "Corner Cafe",
  category: "cafe",
  address: "12 Bridge Street",
  city: "Pune",
  state: "Maharashtra",
  country: "IN",
} as const;

async function business(ownerId: string, over: Record<string, unknown> = {}) {
  return createBusiness(env.DB, ownerId, { ...BIZ, ...over } as never);
}

/**
 * A claimed stand, as a customer would have one: registered, claimed, active,
 * with a real configuration row.
 */
async function stand(tag: string) {
  const { user, cookie } = await session(tag);
  const biz = await business(user.id);
  const serial = generateIdentifier();
  await registerAsset(env.DB, serial);
  const result = await claimQr(
    env.DB,
    {
      identifier: serial,
      viewerId: user.id,
      businessId: biz.id,
      name: "Counter",
      category: "reviews",
      placement: "Cash Desk",
      destination: "https://example.com/menu",
    },
    "pro",
  );
  if (!result.ok) throw new Error(`${tag}: claim failed (${result.reason})`);
  return { user, cookie, biz, serial, asset: result.asset };
}

// ===========================================================================
// Finding 2 & 3: the studio API was a second writer for a stand's config
// ===========================================================================

describe("a stand's configuration has exactly one writer", () => {
  it("PATCHing the destination through the studio API keeps the registry in step", async () => {
    // The defect: PATCH /api/qr/:id wrote qr_codes.destination directly and never
    // touched qr_registry, so the ledger kept saying "Setup pending" for a stand
    // that was already serving traffic, and the two tables disagreed about which
    // business the asset belonged to.
    const s = await stand("drift-destination");

    // Blank the destination to reach the half-configured state the bug needs.
    await env.DB.prepare("UPDATE qr_codes SET destination = NULL WHERE id = ?")
      .bind(s.asset.qr_code_id)
      .run();
    await env.DB.prepare("UPDATE qr_registry SET status = 'claimed' WHERE id = ?")
      .bind(s.asset.id)
      .run();

    const res = await hit(
      qrApi,
      new Request(`https://q.test/api/qr/${s.asset.qr_code_id}`, {
        method: "PATCH",
        headers: { ...JSONH, Cookie: s.cookie },
        body: JSON.stringify({ destination: "https://new.example.com" }),
      }),
    );
    expect(res.status).toBe(200);

    const registry = await env.DB
      .prepare("SELECT status, last_configured_at FROM qr_registry WHERE id = ?")
      .bind(s.asset.id)
      .first<{ status: string; last_configured_at: number | null }>();
    // 'claimed' -> 'active': a destination is exactly what 'active' means.
    expect(registry?.status).toBe("active");
    // The ledger records that this stand was (re)configured, which is what the
    // detail page uses to tell a freshly-registered stand from a settled one.
    expect(registry?.last_configured_at).toBeGreaterThan(0);

    const qr = await getQrById(env.DB, s.asset.qr_code_id);
    expect(qr?.destination).toBe("https://new.example.com");
  });

  it("PATCHing the business through the studio API keeps both tables in step", async () => {
    const s = await stand("drift-business");
    const second = await business(s.user.id, { name: "Second Site" });

    const res = await hit(
      qrApi,
      new Request(`https://q.test/api/qr/${s.asset.qr_code_id}`, {
        method: "PATCH",
        headers: { ...JSONH, Cookie: s.cookie },
        body: JSON.stringify({ business_id: second.id }),
      }),
    );
    expect(res.status).toBe(200);

    const registry = await env.DB.prepare("SELECT business_id FROM qr_registry WHERE id = ?")
      .bind(s.asset.id)
      .first<{ business_id: string }>();
    const qr = await getQrById(env.DB, s.asset.qr_code_id);
    // The exact invariant from migrations/0006: one place owns the association.
    expect(registry?.business_id).toBe(second.id);
    expect(qr?.business_id).toBe(second.id);
  });

  it("refuses to edit a retired stand through the studio", async () => {
    // Archiving promises the code stops serving. An edit must not quietly undo it.
    const s = await stand("retired-edit");
    await env.DB.prepare("UPDATE qr_registry SET status = 'archived', archived_at = ? WHERE id = ?")
      .bind(Date.now(), s.asset.id)
      .run();

    const res = await hit(
      qrApi,
      new Request(`https://q.test/api/qr/${s.asset.qr_code_id}`, {
        method: "PATCH",
        headers: { ...JSONH, Cookie: s.cookie },
        body: JSON.stringify({ destination: "https://sneaky.example.com" }),
      }),
    );
    expect(res.status).toBe(409);
    expect((await getQrById(env.DB, s.asset.qr_code_id))?.destination)
      .toBe("https://example.com/menu");
  });

  it("DELETE refuses a stand, with a message that names the right action", async () => {
    // The defect: DELETE /api/qr/:id issued an unconditional DELETE, which D1
    // rejected with a raw FOREIGN KEY error -> a bare 500 on the Delete button.
    // A stand is retired, never deleted.
    const s = await stand("delete-stand");
    const res = await hit(
      qrApi,
      new Request(`https://q.test/api/qr/${s.asset.qr_code_id}`, {
        method: "DELETE",
        headers: { Cookie: s.cookie },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; code: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("is-stand");
    // The copy has to be actionable, not just accurate.
    expect(body.error).toContain("Sqanny Stand");
    expect(body.error).toContain("Stands");
    // And the row is untouched.
    expect(await getQrById(env.DB, s.asset.qr_code_id)).not.toBeNull();
  });

  it("DELETE refuses a code that has scan history", async () => {
    const { user, cookie } = await session("delete-scanned");
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Scanned",
      is_dynamic: true,
      short_code: `sc${crypto.randomUUID().slice(0, 6)}`,
      destination: "https://x.test",
      content_json: "{}",
      design_json: "{}",
    });
    await env.DB.prepare("INSERT INTO scans (id, qr_id, ts) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID(), qr.id, Date.now())
      .run();

    const res = await hit(
      qrApi,
      new Request(`https://q.test/api/qr/${qr.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("has-scans");
    expect(await getQrById(env.DB, qr.id)).not.toBeNull();
  });

  it("still deletes a plain studio code that nothing references", async () => {
    const { user, cookie } = await session("delete-plain");
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Throwaway",
      content_json: "{}",
      design_json: "{}",
    });
    const res = await hit(
      qrApi,
      new Request(`https://q.test/api/qr/${qr.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      }),
    );
    expect(res.status).toBe(200);
    expect(await getQrById(env.DB, qr.id)).toBeNull();
  });

  it("the studio edit URL sends a stand to the screen that owns it", async () => {
    // Two editors for one asset is the UI half of the drift problem: the user
    // could set a destination in one and not see it in the other.
    const s = await stand("studio-redirect");
    const res = await hit(
      studio,
      new Request(`https://q.test/app/${s.asset.qr_code_id}/edit`, {
        headers: { Cookie: s.cookie },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/qrs/${s.asset.id}`);
  });

  it("the QR detail page offers no Delete button for a stand", async () => {
    const s = await stand("detail-stand");
    const html = await (await hit(
      qrDetail,
      new Request(`https://q.test/app/${s.asset.qr_code_id}`, { headers: { Cookie: s.cookie } }),
    )).text();
    expect(html).not.toContain("data-delete");
    // It points at the stand's own screen instead.
    expect(html).toContain(`/qrs/${s.asset.id}`);
  });
});

// ===========================================================================
// Finding 20: /qrs/:id/edit stored an unvalidated category
// ===========================================================================

describe("the stand editor validates every field it renders", () => {
  it("refuses a tampered category instead of storing it verbatim", async () => {
    // The defect: body.category went straight to SQL. A hand-crafted POST could
    // put arbitrary text in a column that every filter, label and group-by
    // reads as a controlled key. Values are bound, so this was never SQL
    // injection — it was the integrity of the vocabulary that broke.
    const s = await stand("bad-category");
    const res = await hit(
      qrs,
      new Request(`https://q.test/qrs/${s.asset.id}/edit`, {
        method: "POST",
        headers: { ...FORM, Cookie: s.cookie },
        body: new URLSearchParams({
          name: "Counter",
          business_id: s.biz.id,
          category: "'; DROP TABLE qr_codes; --",
          custom_category: "smuggled",
          placement: "Counter",
          destination: "https://example.com/menu",
        }).toString(),
      }),
    );
    expect(res.status).toBe(302);

    const row = await env.DB
      .prepare("SELECT category, custom_category FROM qr_codes WHERE id = ?")
      .bind(s.asset.qr_code_id)
      .first<{ category: string; custom_category: string | null }>();
    expect(row?.category).toBe("reviews");
    // The "non-custom discards free text" rule applies here too.
    expect(row?.custom_category).toBeNull();
    // The table is, of course, still there.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_codes").first<{ n: number }>())
      .toBeTruthy();
  });

  it("requires free text for a custom category, and keeps it", async () => {
    const s = await stand("custom-category");
    // No custom text -> refused.
    await hit(
      qrs,
      new Request(`https://q.test/qrs/${s.asset.id}/edit`, {
        method: "POST",
        headers: { ...FORM, Cookie: s.cookie },
        body: new URLSearchParams({
          name: "Counter",
          business_id: s.biz.id,
          category: "custom",
          custom_category: "",
          placement: "Counter",
          destination: "https://example.com/menu",
        }).toString(),
      }),
    );
    expect((await getQrById(env.DB, s.asset.qr_code_id))?.category).toBe("reviews");

    // With it -> accepted, and distinguishable from every other custom stand.
    await hit(
      qrs,
      new Request(`https://q.test/qrs/${s.asset.id}/edit`, {
        method: "POST",
        headers: { ...FORM, Cookie: s.cookie },
        body: new URLSearchParams({
          name: "Counter",
          business_id: s.biz.id,
          category: "custom",
          custom_category: "Wayfinding",
          placement: "Counter",
          destination: "https://example.com/menu",
        }).toString(),
      }),
    );
    const row = await getQrById(env.DB, s.asset.qr_code_id);
    expect(row?.category).toBe("custom");
    expect(row?.custom_category).toBe("Wayfinding");
  });

  it("enforces the placement limit the form advertises", async () => {
    // The handler capped placement at LIMITS.name (80) rather than
    // QR_PLACEMENT_MAX (60), so anything the form marked too long was silently
    // accepted.
    const s = await stand("long-placement");
    const res = await hit(
      qrs,
      new Request(`https://q.test/qrs/${s.asset.id}/edit`, {
        method: "POST",
        headers: { ...FORM, Cookie: s.cookie },
        body: new URLSearchParams({
          name: "Counter",
          business_id: s.biz.id,
          category: "reviews",
          placement: "x".repeat(70),
          destination: "https://example.com/menu",
        }).toString(),
      }),
    );
    expect(res.headers.get("location")).toContain("err_placement");
    expect((await getQrById(env.DB, s.asset.qr_code_id))?.placement).toBe("Cash Desk");
  });
});

// ===========================================================================
// Finding 19: a rejected edit destroyed every field
// ===========================================================================

describe("a rejected edit never costs the user their typing", () => {
  it("renders the name error, which the page used to set and then ignore", async () => {
    // The defect: the handler put err_name in the query string and the GET never
    // read it, so a blank name produced a silent no-op save.
    const s = await stand("err-name");
    const res = await hit(
      qrs,
      new Request(`https://q.test/qrs/${s.asset.id}/edit`, {
        method: "POST",
        headers: { ...FORM, Cookie: s.cookie },
        body: new URLSearchParams({ name: "", business_id: s.biz.id, category: "reviews" }).toString(),
      }),
    );
    const location = res.headers.get("location")!;
    expect(location).toContain("err_name");

    const html = await (await hit(
      qrs,
      new Request(`https://q.test${location}`, { headers: { Cookie: s.cookie } }),
    )).text();
    expect(html).toContain("Give this QR a name");
  });

  it("round-trips every submitted field through a failed save", async () => {
    // The defect: the GET re-rendered from the STORED row, so one bad field
    // silently discarded the other four. Verified before the fix: submitting an
    // invalid destination returned a page containing none of the submitted name,
    // category or placement.
    const s = await stand("roundtrip");
    const res = await hit(
      qrs,
      new Request(`https://q.test/qrs/${s.asset.id}/edit`, {
        method: "POST",
        headers: { ...FORM, Cookie: s.cookie },
        body: new URLSearchParams({
          name: "Table Nine",
          business_id: s.biz.id,
          category: "menu",
          custom_category: "",
          placement: "Window Seat",
          destination: "not-a-url",
        }).toString(),
      }),
    );
    const location = res.headers.get("location")!;
    expect(location).toContain("err_destination");

    const html = await (await hit(
      qrs,
      new Request(`https://q.test${location}`, { headers: { Cookie: s.cookie } }),
    )).text();

    // Everything the user typed is still on the page.
    expect(html).toContain("Table Nine");
    expect(html).toContain("Window Seat");
    expect(html).toContain('value="menu" selected');
    expect(html).toContain("not-a-url");
    // The failure is announced, and says the rest of their work survived.
    expect(html).toContain("Enter a valid URL");
    expect(html).toContain("Your other changes are still here");
    // And nothing was written.
    const stored = await getQrById(env.DB, s.asset.qr_code_id);
    expect(stored?.title).toBe("Counter");
    expect(stored?.placement).toBe("Cash Desk");
  });

  it("a clean GET renders the stored row, not an empty form", async () => {
    // The submitted-values path must not activate when nothing was submitted,
    // or every visit to a saved stand would show a blank form.
    const s = await stand("clean-get");
    const html = await (await hit(
      qrs,
      new Request(`https://q.test/qrs/${s.asset.id}`, { headers: { Cookie: s.cookie } }),
    )).text();
    expect(html).toContain("Counter");
    expect(html).toContain("Cash Desk");
    expect(html).toContain("https://example.com/menu");
    expect(html).not.toContain("Your other changes are still here");
  });
});

// ===========================================================================
// Finding 14 & 15: broken navigation
// ===========================================================================

describe("navigation reaches a real page from every entry point", () => {
  it("a business with no QRs offers a working Claim a QR link", async () => {
    // The defect: href="/app/claim" matched the /app/:id QR-detail route, so the
    // primary call to action on an empty business 404'd with "QR code not found".
    const { user, cookie } = await session("nav-claim");
    const biz = await business(user.id);
    const html = await (await hit(
      businesses,
      new Request(`https://q.test/app/businesses/${biz.id}`, { headers: { Cookie: cookie } }),
    )).text();
    expect(html).not.toContain('href="/app/claim"');
    expect(html).toContain('href="/qrs/claim"');
  });

  it("the QR detail page keeps the nav and the business switcher", async () => {
    // The defect: /app/:id passed neither `active` nor `businesses`, so the
    // switcher vanished and no nav item was marked current.
    const { user, cookie } = await session("nav-detail");
    const biz = await business(user.id);
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Menu",
      business_id: biz.id,
      content_json: "{}",
      design_json: "{}",
    });
    const html = await (await hit(
      qrDetail,
      new Request(`https://q.test/app/${qr.id}`, { headers: { Cookie: cookie } }),
    )).text();
    expect(html).toContain('class="context-bar"');
    expect(html).toContain("Corner Cafe");
    expect(html).toContain('aria-current="page"');
  });

  it("the QR detail 404 keeps the nav too", async () => {
    const { cookie } = await session("nav-detail-404");
    const html = await (await hit(
      qrDetail,
      new Request("https://q.test/app/no-such-qr", { headers: { Cookie: cookie } }),
    )).text();
    expect(html).toContain("QR code not found");
    expect(html).toContain('href="/app"');
    expect(html).toContain('class="nav"');
  });

  it("the studio edit page keeps the nav and the switcher", async () => {
    const { user, cookie } = await session("nav-studio");
    await business(user.id);
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Studio code",
      content_json: "{}",
      design_json: "{}",
    });
    const html = await (await hit(
      studio,
      new Request(`https://q.test/app/${qr.id}/edit`, { headers: { Cookie: cookie } }),
    )).text();
    expect(html).toContain('class="context-bar"');
    expect(html).toContain('aria-current="page"');
  });

  it("the switcher returns you to the page you switched from", async () => {
    // The defect: no `next` field, so changing context always yanked the user to
    // the dashboard even from the stands list.
    const s = await stand("switch-next");
    const html = await (await hit(
      qrs,
      new Request("https://q.test/qrs", { headers: { Cookie: s.cookie } }),
    )).text();
    expect(html).toContain('name="next"');
    expect(html).toContain('value="/qrs"');
  });
});

describe("a stand is always routed to its own screen", () => {
  it("the dashboard links a stand to /qrs, not the studio", async () => {
    const s = await stand("dash-stand");
    const html = await (await hit(
      dashboard,
      new Request("https://q.test/app", { headers: { Cookie: s.cookie } }),
    )).text();
    expect(html).toContain(`/qrs/${s.asset.id}`);
    expect(html).toContain("Sqanny Stand");
    // No studio edit link for a stand — that was the second editor.
    expect(html).not.toContain(`/app/${s.asset.qr_code_id}/edit`);
  });

  it("a business page's QR rows resolve stands through the registry", async () => {
    const s = await stand("biz-stand");
    const html = await (await hit(
      businesses,
      new Request(`https://q.test/app/businesses/${s.biz.id}`, { headers: { Cookie: s.cookie } }),
    )).text();
    expect(html).toContain(`/qrs/${s.asset.id}`);
    expect(html).toContain("Manage stand");
  });

  it("the list query itself carries the registry id", async () => {
    // The routing rule must live in ONE place. If the join is missing, a list has
    // to guess which editor a code belongs to and gets it wrong.
    const s = await stand("join");
    const rows = await listQrByUserScoped(env.DB, s.user.id);
    const row = rows.find((r) => r.id === s.asset.qr_code_id);
    expect(row?.registry_id).toBe(s.asset.id);

    const { user, cookie } = await session("join-plain");
    const plain = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Plain",
      content_json: "{}",
      design_json: "{}",
    });
    const plainRows = await listQrByUserScoped(env.DB, user.id);
    expect(plainRows.find((r) => r.id === plain.id)?.registry_id).toBeNull();
  });
});

// ===========================================================================
// Finding 5, 6, 7, 11: the data layer's authorization predicates
// ===========================================================================

describe("authorization lives in the SQL, not in the caller", () => {
  it("assignQrToBusiness refuses a business the caller does not belong to", async () => {
    const owner = await createUser(env.DB, `own-${crypto.randomUUID()}@e.test`);
    const stranger = await createUser(env.DB, `str-${crypto.randomUUID()}@e.test`);
    const theirBiz = await business(stranger.id);
    const qr = await createQr(env.DB, {
      user_id: owner.id,
      type: "url",
      title: "Mine",
      content_json: "{}",
      design_json: "{}",
    });

    // The predicate re-checks the QR's owner AND the business membership.
    expect(await assignQrToBusiness(env.DB, qr.id, owner.id, theirBiz.id)).toBe(false);
    expect((await getQrById(env.DB, qr.id))?.business_id).toBeNull();

    const mine = await business(owner.id);
    expect(await assignQrToBusiness(env.DB, qr.id, owner.id, mine.id)).toBe(true);
  });

  it("updateQr cannot write to somebody else's row", async () => {
    const owner = await createUser(env.DB, `own-${crypto.randomUUID()}@e.test`);
    const stranger = await createUser(env.DB, `str-${crypto.randomUUID()}@e.test`);
    const qr = await createQr(env.DB, {
      user_id: owner.id,
      type: "url",
      title: "Theirs",
      destination: "https://theirs.test",
      content_json: "{}",
      design_json: "{}",
    });

    expect(await updateQr(env.DB, qr.id, stranger.id, { destination: "https://stolen.test" })).toBe(false);
    expect((await getQrById(env.DB, qr.id))?.destination).toBe("https://theirs.test");
  });

  it("updateQr refuses to rewrite the printed short code", async () => {
    // A rewriteable short code is a label that silently stops resolving to the
    // same thing. Identity is not configuration.
    const { user } = await session("shortcode-identity");
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Printed",
      is_dynamic: true,
      short_code: "keepme1",
      content_json: "{}",
      design_json: "{}",
    });
    await updateQr(env.DB, qr.id, user.id, { short_code: "hijack1" } as never);
    expect((await getQrById(env.DB, qr.id))?.short_code).toBe("keepme1");
  });

  it("updateBusinessForUser drops keys that are not writable", async () => {
    const { user } = await session("patch-allowlist");
    const biz = await business(user.id);
    // `status` has its own route and `owner_id` is structural. A hidden field
    // must not be able to un-archive a business or reassign its owner.
    await updateBusinessForUser(env.DB, biz.id, user.id, {
      name: "Renamed",
      owner_id: "someone-else",
    } as never);
    const row = await env.DB.prepare("SELECT name, owner_id, status FROM businesses WHERE id = ?")
      .bind(biz.id)
      .first<{ name: string; owner_id: string; status: string }>();
    expect(row?.name).toBe("Renamed");
    expect(row?.owner_id).toBe(user.id);
    expect(row?.status).toBe("active");
  });

  it("setCurrentBusiness refuses a business you are not a member of", async () => {
    const { user } = await session("scope-stranger");
    const stranger = await createUser(env.DB, `st-${crypto.randomUUID()}@e.test`);
    const theirBiz = await business(stranger.id);

    expect(await setCurrentBusiness(env.DB, user.id, theirBiz.id)).toBe(false);
    const row = await env.DB.prepare("SELECT current_business_id FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ current_business_id: string | null }>();
    expect(row?.current_business_id).toBeNull();

    const mine = await business(user.id);
    expect(await setCurrentBusiness(env.DB, user.id, mine.id)).toBe(true);
    // Null is a legitimate state — "All businesses" — not an error.
    expect(await setCurrentBusiness(env.DB, user.id, null)).toBe(true);
  });

  it("setCurrentBusiness refuses an archived business", async () => {
    const { user } = await session("scope-archived");
    const biz = await business(user.id);
    await env.DB.prepare("UPDATE businesses SET status = 'archived' WHERE id = ?").bind(biz.id).run();
    expect(await setCurrentBusiness(env.DB, user.id, biz.id)).toBe(false);
  });

  it("deleteQrForUser 404s rather than confirming another account's row", async () => {
    const { user } = await session("delete-stranger");
    const stranger = await createUser(env.DB, `st-${crypto.randomUUID()}@e.test`);
    const qr = await createQr(env.DB, {
      user_id: stranger.id,
      type: "url",
      title: "Theirs",
      content_json: "{}",
      design_json: "{}",
    });
    expect(await deleteQrForUser(env.DB, qr.id, user.id)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(await getQrById(env.DB, qr.id)).not.toBeNull();
  });
});

// ===========================================================================
// Finding 9: re-entering the claim flow orphaned a live QR
// ===========================================================================

describe("resuming a claim does not leave a second live QR behind", () => {
  it("swaps the configuration row instead of stranding it", async () => {
    // The defect: re-entry by the owner was allowed — correctly, since it is how
    // an interrupted setup resumes — but it created a SECOND configuration row
    // and repointed the registry at it. The old row kept a short code, still
    // answered on /r/<code>, and was invisible to every user-facing query.
    //
    // Re-entry only applies to a stand that is claimed but NOT yet serving, which
    // is the state an abandoned setup leaves behind. An active stand is not
    // re-claimable at all.
    const { user } = await session("reclaim");
    const biz = await business(user.id);
    const serial = generateIdentifier();
    await registerAsset(env.DB, serial);

    const first = await claimQr(
      env.DB,
      { identifier: serial, viewerId: user.id, businessId: biz.id, name: "Counter", category: "reviews", placement: null, destination: "https://first.test" },
      "pro",
    );
    expect(first.ok).toBe(true);
    const firstQrId = first.ok ? first.asset.qr_code_id : null;
    const firstCode = first.ok ? first.asset.short_code : null;

    // Back to "Setup pending": the owner walked away before finishing.
    await env.DB.prepare("UPDATE qr_codes SET destination = NULL WHERE id = ?")
      .bind(firstQrId!)
      .run();
    await env.DB.prepare("UPDATE qr_registry SET status = 'claimed' WHERE id = ?")
      .bind(first.asset.id)
      .run();

    // Resume: the same owner re-claims the same stand.
    const second = await claimQr(
      env.DB,
      { identifier: serial, viewerId: user.id, businessId: biz.id, name: "Counter", category: "menu", placement: "Table 4", destination: "https://second.test" },
      "pro",
    );
    expect(second.ok).toBe(true);

    // The registry now points at the NEW row, and its own identity (the serial,
    // the claim timestamp) is unchanged — a stand is the same physical asset
    // throughout.
    const registry = await env.DB
      .prepare("SELECT qr_code_id, qr_identifier, claimed_at FROM qr_registry WHERE id = ?")
      .bind(first.asset.id)
      .first<{ qr_code_id: string; qr_identifier: string; claimed_at: number }>();
    expect(registry?.qr_code_id).toBe(second.ok ? second.asset.qr_code_id : null);
    expect(registry?.qr_identifier).toBe(serial);
    expect(registry?.claimed_at).toBe(first.asset.claimed_at);

    // And the superseded row is gone, so there is no orphaned live QR.
    const orphan = await env.DB.prepare("SELECT id FROM qr_codes WHERE id = ?")
      .bind(firstQrId!)
      .first<{ id: string }>();
    expect(orphan).toBeNull();
    // Including its short code, which would otherwise still redirect.
    const staleCode = await env.DB.prepare("SELECT short_code FROM qr_codes WHERE short_code = ?")
      .bind(firstCode!)
      .first<{ short_code: string }>();
    expect(staleCode).toBeNull();
  });

  it("will not re-claim a stand that is already serving", async () => {
    // The other half of the rule: re-entry resumes an INTERRUPTED setup, it is
    // not a way to overwrite a working stand's configuration behind the owner's
    // back.
    const { user } = await session("reclaim-active");
    const biz = await business(user.id);
    const serial = generateIdentifier();
    await registerAsset(env.DB, serial);

    const first = await claimQr(
      env.DB,
      { identifier: serial, viewerId: user.id, businessId: biz.id, name: "Counter", category: "reviews", placement: null, destination: "https://first.test" },
      "pro",
    );
    expect(first.ok).toBe(true);

    const again = await claimQr(
      env.DB,
      { identifier: serial, viewerId: user.id, businessId: biz.id, name: "Counter", category: "menu", placement: null, destination: "https://overwritten.test" },
      "pro",
    );
    expect(again).toEqual({ ok: false, reason: "not-claimable" });

    // Still serving what it was serving.
    const qr = await getQrById(env.DB, first.asset.qr_code_id!);
    expect(qr?.destination).toBe("https://first.test");
    expect(qr?.category).toBe("reviews");
  });

  it("does not touch a rival's row when the CAS is lost", async () => {
    const a = await session("race-a");
    const b = await session("race-b");
    const bizA = await business(a.user.id);
    const bizB = await business(b.user.id);
    const serial = generateIdentifier();
    await registerAsset(env.DB, serial);

    const winner = await claimQr(
      env.DB,
      { identifier: serial, viewerId: a.user.id, businessId: bizA.id, name: "A", category: "reviews", placement: null, destination: "https://a.test" },
      "pro",
    );
    expect(winner.ok).toBe(true);

    const loser = await claimQr(
      env.DB,
      { identifier: serial, viewerId: b.user.id, businessId: bizB.id, name: "B", category: "reviews", placement: null, destination: "https://b.test" },
      "pro",
    );
    expect(loser).toEqual({ ok: false, reason: "already-claimed" });

    // Exactly one configuration row exists, and it belongs to the winner.
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_codes")
      .first<{ n: number }>();
    const rows = await env.DB.prepare("SELECT user_id FROM qr_codes").all<{ user_id: string }>();
    expect(rows.results.every((r) => r.user_id === a.user.id)).toBe(true);
  });
});

// ===========================================================================
// Finding 12: one source of truth for scan counts
// ===========================================================================

describe("scan totals come from one place", () => {
  it("the grouped count agrees with a direct count, and reads zero, never null", async () => {
    const s = await stand("scans");
    const qrId = s.asset.qr_code_id!;

    // Never scanned. A stand reporting "null scans" instead of "0 scans" is the
    // exact regression the LEFT JOIN introduced before COALESCE was added.
    // An absent group produces no map entry, so callers read `?? 0`.
    expect((await countScansForQrs(env.DB, [qrId])).get(qrId) ?? 0).toBe(0);
    expect((await getAssetViewForOwner(env.DB, s.asset.id, s.user.id))?.scan_count).toBe(0);

    for (const ts of [1, 2, 3]) {
      await env.DB.prepare("INSERT INTO scans (id, qr_id, ts) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), qrId, Date.now() + ts)
        .run();
    }
    expect((await countScansForQrs(env.DB, [qrId])).get(qrId)).toBe(3);
    // The same number the management list shows.
    expect((await getAssetViewForOwner(env.DB, s.asset.id, s.user.id))?.scan_count).toBe(3);
  });

  it("an empty id list is not a syntax error", async () => {
    // `IN ()` is a syntax error in SQLite, so an account with no codes would have
    // taken the whole dashboard down.
    expect((await countScansForQrs(env.DB, [])).size).toBe(0);
  });

  it("last_scanned_at is populated from the same pass", async () => {
    const s = await stand("scans-last");
    const at = Date.now();
    await env.DB.prepare("INSERT INTO scans (id, qr_id, ts) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID(), s.asset.qr_code_id, at)
      .run();
    const view = await getAssetViewForOwner(env.DB, s.asset.id, s.user.id);
    expect(view?.last_scanned_at).toBe(at);
  });
});

// ===========================================================================
// Finding 18: the switcher must not report another account's inventory
// ===========================================================================

describe("the business QR count is the caller's own", async () => {
  it("a member sees their own count, not the owner's total", async () => {
    const owner = await createUser(env.DB, `ow-${crypto.randomUUID()}@e.test`);
    const member = await createUser(env.DB, `mb-${crypto.randomUUID()}@e.test`);
    const biz = await business(owner.id);
    // Give the member membership, as sharing a business eventually will.
    await env.DB.prepare(
      "INSERT INTO business_members (business_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
    ).bind(biz.id, member.id, Date.now()).run();

    for (let i = 0; i < 3; i++) {
      await createQr(env.DB, {
        user_id: owner.id,
        type: "url",
        title: `Owner code ${i}`,
        business_id: biz.id,
        content_json: "{}",
        design_json: "{}",
      });
    }
    await createQr(env.DB, {
      user_id: member.id,
      type: "url",
      title: "My code",
      business_id: biz.id,
      content_json: "{}",
      design_json: "{}",
    });

    const ownerView = await import("../src/db/queries").then((m) =>
      m.getBusinessForUser(env.DB, biz.id, owner.id));
    const memberView = await import("../src/db/queries").then((m) =>
      m.getBusinessForUser(env.DB, biz.id, member.id));

    expect(ownerView?.qr_count).toBe(3);
    // The owner's inventory is a fact about the owner's account.
    expect(memberView?.qr_count).toBe(1);
  });
});

// ===========================================================================
// Finding 21: a rejected profile save must not change the page
// ===========================================================================

describe("the profile page is the same page whatever the outcome", async () => {
  it("a rejected save keeps the aside, not just the form", async () => {
    // The defect: the POST's error branch re-rendered only .profile-main, so a
    // rejected save dropped the completeness meter, the business list and the
    // account card — the "what next" prompt at the moment it was needed.
    const { user, cookie } = await session("profile-aside");
    await business(user.id);

    const ok = await (await hit(
      profile,
      new Request("https://q.test/app/profile", { headers: { Cookie: cookie } }),
    )).text();
    const res = await hit(
      profile,
      new Request("https://q.test/app/profile", {
        method: "POST",
        headers: { ...FORM, Cookie: cookie },
        body: new URLSearchParams({ name: "", phone: "" }).toString(),
      }),
    );
    expect(res.status).toBe(422);
    const rejected = await res.text();

    for (const marker of ["Profile strength", "Businesses", "Account", "Profile completeness"]) {
      expect(ok, `GET is missing ${marker}`).toContain(marker);
      expect(rejected, `rejected POST is missing ${marker}`).toContain(marker);
    }
    // And the nav survives too.
    expect(rejected).toContain('class="nav"');
    expect(rejected).toContain('class="context-bar"');
  });
});

// ===========================================================================
// Finding 27: a plan limit the claim flow used to ignore
// ===========================================================================

describe("claiming a stand counts against the plan", async () => {
  it("refuses a claim beyond the free plan's dynamic limit", async () => {
    // A stand is a dynamic QR like any other. Ungated, the claim flow was a
    // postbox around the limit the studio enforces.
    const { user } = await session("plan-limit");
    const biz = await business(user.id);
    const free = { identifier: "", viewerId: user.id, businessId: biz.id, name: "S", category: "reviews", placement: null, destination: "https://x.test" };

    for (let i = 0; i < 3; i++) {
      const serial = generateIdentifier();
      await registerAsset(env.DB, serial);
      const r = await claimQr(env.DB, { ...free, identifier: serial }, "free");
      expect(r.ok, `claim ${i + 1}`).toBe(true);
    }

    const serial = generateIdentifier();
    await registerAsset(env.DB, serial);
    const blocked = await claimQr(env.DB, { ...free, identifier: serial }, "free");
    expect(blocked).toEqual({ ok: false, reason: "plan-limit" });

    // And the same stand is claimable on an unlimited plan — the limit is the
    // plan's, not a permanent block on the asset.
    const allowed = await claimQr(env.DB, { ...free, identifier: serial }, "pro");
    expect(allowed.ok).toBe(true);
  });
});

// ===========================================================================
// Finding 24: text corruption that reached the page
// ===========================================================================

describe("no replacement characters reach the user", () => {
  it("the stand list and detail render clean separators", async () => {
    // Five U+FFFD literals had been committed into the separators between the QR
    // ID, the business and the destination. They render as visible garbage.
    const s = await stand("encoding");
    for (const path of ["/qrs", `/qrs/${s.asset.id}`]) {
      const html = await (await hit(
        qrs,
        new Request(`https://q.test${path}`, { headers: { Cookie: s.cookie } }),
      )).text();
      expect(html.includes("�"), `${path} contains U+FFFD`).toBe(false);
    }
    expect(await (await hit(
      businesses,
      new Request(`https://q.test/app/businesses/${s.biz.id}`, { headers: { Cookie: s.cookie } }),
    )).text()).not.toMatch(/\u00C2[\u00A0\u00B7]/);
  });
});