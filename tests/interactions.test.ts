import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../src/index";
import { createBusiness, createQr, createUser } from "../src/db/queries";
import { claimAsset, insertRegistrationQr, registerAsset } from "../src/db/qr-registry";
import { generateIdentifier } from "../src/lib/qr-registration";
import { startSession } from "../src/lib/auth/session";

// --- Part 2: interaction micro-audit ---------------------------------------
//
// Every test here defends a fix that a reasonable-looking edit could silently
// undo. They are written against rendered HTML and response headers rather than
// against the islands, because the islands are exactly what these tests exist to
// protect a fallback for.

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

function post(path: string, body: Record<string, string>, cookie: string) {
  return call(
    new Request(`https://q.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams(body).toString(),
    }),
  );
}

async function account(tag: string) {
  const user = await createUser(env.DB, `${tag}-${crypto.randomUUID()}@example.com`);
  const setCookie = await startSession(env, user.id);
  return { user, cookie: setCookie.split(";")[0] };
}

async function businessFor(userId: string, name = "Corner Cafe") {
  return createBusiness(env.DB, userId, {
    name,
    category: "cafe",
    address: "12 Bridge Street",
    city: "Pune",
    state: "Maharashtra",
    country: "IN",
  });
}

/**
 * A printed serial registered at manufacture, then claimed by `ownerId`.
 *
 * This is the shape the registry actually models, and both halves matter:
 *  - a serial exists before anyone owns it (`registerAsset`), which is what makes
 *    "guess a serial and take someone's QR" a 404;
 *  - the stand's configuration row is `source = 'registration'` (`insertRegistrationQr`),
 *    which is load-bearing. A `source = 'studio'` row bolted onto a registry entry
 *    is a state the code deliberately forbids: the studio edit path refuses
 *    `registration` rows so a printed code's destination can only change through
 *    the stand rules, and the orphan-cleanup queries only ever consider
 *    `registration` rows. Building a stand any other way produces a fixture that
 *    passes while testing a state production cannot reach.
 */
async function claimedStand(ownerId: string, businessId: string) {
  const serial = generateIdentifier();
  await registerAsset(env.DB, serial);

  const qrId = crypto.randomUUID();
  await insertRegistrationQr(env.DB, {
    id: qrId,
    ownerId,
    businessId,
    name: "Table 1",
    category: "cafe",
    customCategory: null,
    placement: null,
    destination: "https://example.com/menu",
    shortCode: "s" + crypto.randomUUID().slice(0, 6),
  });

  const claimed = await claimAsset(env.DB, {
    identifier: serial,
    ownerId,
    businessId,
    qrCodeId: qrId,
    status: "active",
  });
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) throw new Error("setup failed");
  return { serial, qrId };
}

/** Every `<form>` in the document, with its attributes as written. */
function forms(html: string): Array<{ method: string; action: string; guarded: boolean; raw: string }> {
  const out: Array<{ method: string; action: string; guarded: boolean; raw: string }> = [];
  for (const m of html.matchAll(/<form\b([^>]*)>/g)) {
    const attrs = m[1];
    out.push({
      method: /\bmethod="([^"]*)"/.exec(attrs)?.[1]?.toLowerCase() ?? "get",
      action: /\baction="([^"]*)"/.exec(attrs)?.[1] ?? "",
      guarded: attrs.includes("data-guard-submit"),
      raw: attrs,
    });
  }
  return out;
}

// --- Double-submission -----------------------------------------------------

describe("double-submission guards", () => {
  /**
   * The durable check. Rather than asserting one page at a time, this walks the
   * pages an owner actually lands on and asserts the INVARIANT: every form that
   * changes state is guarded. A new destructive form added next quarter without
   * the attribute fails here instead of in production.
   */
  it("guards every state-changing form on the pages that change state", async () => {
    const { user, cookie } = await account("guard");
    const biz = await businessFor(user.id);
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Table 4",
      is_dynamic: true,
      short_code: "d" + crypto.randomUUID().slice(0, 6),
      destination: "https://example.com/menu",
      content_json: "{}",
      design_json: "{}",
      business_id: biz.id,
    });

    const pages = [
      "/app",
      "/app/profile",
      "/app/settings",
      "/app/businesses",
      `/app/${qr.id}`,
    ];

    const unguarded: string[] = [];
    for (const path of pages) {
      const res = await get(path, cookie);
      expect(res.status, `${path} should render`).toBe(200);
      const html = await res.text();
      for (const f of forms(html)) {
        if (f.method !== "post") continue;
        // A guard is pointless on a form whose action cannot change state, and
        // these are the two that only pick a filter/preference in the UI.
        if (!f.action || f.action.startsWith("#")) continue;
        if (!f.guarded) unguarded.push(`${path} -> ${f.action}`);
      }
    }

    expect(unguarded, `unguarded state-changing forms:\n${unguarded.join("\n")}`).toEqual([]);
  });

  it("guards the claim POSTs across the 4-step claim flow", async () => {
    // Two taps on the final submit is the classic double-fire: it would either
    // create two entries or trip the one-time-claim guard and show an error the
    // user did not cause.
    const { user, cookie } = await account("guard-claim");
    const biz = await businessFor(user.id);
    const serial = generateIdentifier();
    await registerAsset(env.DB, serial);

    const postsTo = (h: string, prefix: string) =>
      forms(h).filter((f) => f.method === "post" && f.action.startsWith(prefix));

    // Step 1 is the scan. Its no-JS fallback is a GET to step 2 — nothing is
    // written, so a guard there would be wrong, not merely redundant.
    const scan = await get(`/qrs/claim?qr=${serial}`, cookie);
    expect(scan.status).toBe(200);
    const scanHtml = await scan.text();
    expect(postsTo(scanHtml, "/qrs/claim")).toHaveLength(0);
    expect(forms(scanHtml).filter((f) => f.action === "/qrs/claim/business")).not.toHaveLength(0);

    // Step 2 picks a business; it POSTs.
    const pick = await get(`/qrs/claim/business?qr=${serial}`, cookie);
    expect(pick.status).toBe(200);
    const pickPosts = postsTo(await pick.text(), "/qrs/claim");
    expect(pickPosts.length).toBeGreaterThan(0);
    for (const f of pickPosts) {
      expect(f.guarded, `claim form ${f.action} is unguarded`).toBe(true);
    }

    // Step 3 holds the final, irreversible submit.
    const review = await get(`/qrs/claim/details?qr=${serial}&business=${biz.id}`, cookie);
    expect(review.status).toBe(200);
    const reviewPosts = postsTo(await review.text(), "/qrs/claim");
    expect(reviewPosts.length).toBeGreaterThan(0);
    for (const f of reviewPosts) {
      expect(f.guarded, `claim form ${f.action} is unguarded`).toBe(true);
    }
  });

  it("guards the claim form on an unconfigured code's own page", async () => {
    // The flow a visitor reaches by scanning a code that exists but has no
    // destination yet: GET /r/:code renders the form, POST /r/:code/claim
    // performs it. (There is no GET /r/:code/claim — the redirect route renders
    // the form itself.) A physical stand is deliberately NOT claimable here; its
    // destination is owned by the registry service.
    const { user, cookie } = await account("guard-rclaim");
    const shortCode = "u" + crypto.randomUUID().slice(0, 6);
    await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Not configured yet",
      is_dynamic: true,
      short_code: shortCode,
      destination: null,
      content_json: "{}",
      design_json: "{}",
    });

    const res = await get(`/r/${shortCode}`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    const claimPosts = forms(html).filter(
      (f) => f.method === "post" && f.action.includes("/claim"),
    );
    expect(claimPosts.length, "expected a claim form on the unconfigured page").toBeGreaterThan(0);
    for (const f of claimPosts) {
      expect(f.guarded, `claim form ${f.action} is unguarded`).toBe(true);
    }
  });

  it("does not disable the button on a form that never submits", async () => {
    // Sanity check on the invariant itself: a GET form must not be guarded, or
    // the island would disable a control that was never going to submit.
    const { cookie } = await account("guard-get");
    const html = await (await get("/app", cookie)).text();
    const getForms = forms(html).filter((f) => f.method === "get");
    for (const f of getForms) {
      expect(f.guarded, `GET form ${f.action} should not be guarded`).toBe(false);
    }
  });
});

// --- Sign out ---------------------------------------------------------------

describe("sign out", () => {
  it("is a POST form on the settings page, not a link", async () => {
    // This regressed once already: logout became POST-only (so a GET link could
    // not log anyone out, and could not be triggered by a cross-site <img>), and
    // the settings page kept rendering the old href. The link looked perfect and
    // 405'd on click.
    const { cookie } = await account("signout");
    const html = await (await get("/app/settings", cookie)).text();

    expect(html).not.toMatch(/href="\/auth\/logout"/);

    // Two are correct: the Session card and the account menu in the nav, both
    // rendered on this page. What matters is that every one of them is a POST.
    const logout = forms(html).filter(
      (f) => f.method === "post" && f.action === "/auth/logout",
    );
    expect(logout.length).toBeGreaterThanOrEqual(1);
    for (const f of logout) {
      expect(f.guarded, "every logout form needs a double-submit guard").toBe(true);
    }
    // And the Session card specifically exists, not just the nav.
    expect(html).toMatch(/settings-signout-text/);
  });

  it("actually ends the session when submitted", async () => {
    const { cookie } = await account("signout-live");

    expect((await get("/app/settings", cookie)).status).toBe(200);

    const res = await post("/auth/logout", {}, cookie);
    // 303, not 302: after a state change the browser must follow up with a GET.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");

    // The old cookie must be dead. This is the part that matters.
    const after = await get("/app", cookie);
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toContain("/login");
  });

  it("does NOT end the session on a bare GET, and says why", async () => {
    // The actual security property. `SameSite=Lax` still allows cross-site
    // top-level GET navigations, so if GET signed you out then any page on the
    // internet could do it with one <img>. GET explains and asks instead.
    const { cookie } = await account("signout-get");

    const res = await get("/auth/logout", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();

    const html = await res.text();
    expect(html).toMatch(/Sign out of Sqanny\?/);
    // The way out is a POST form, guarded.
    const posts = forms(html).filter((f) => f.action === "/auth/logout");
    expect(posts.length).toBe(1);
    expect(posts[0].method).toBe("post");
    expect(posts[0].guarded).toBe(true);

    // Still signed in after the GET: the session survived.
    expect((await get("/app", cookie)).status).toBe(200);
  });
});

// --- Destructive confirmation ----------------------------------------------

describe("delete confirmation", () => {
  it("uses an accessible in-app dialog instead of a native confirm()", async () => {
    const { user, cookie } = await account("del-modal");
    const biz = await businessFor(user.id);
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Table 4",
      is_dynamic: true,
      short_code: "d" + crypto.randomUUID().slice(0, 6),
      destination: "https://example.com/menu",
      content_json: "{}",
      design_json: "{}",
      business_id: biz.id,
    });

    const html = await (await get(`/app/${qr.id}`, cookie)).text();

    // A real dialog, wired for assistive tech.
    expect(html).toMatch(/data-modal/);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="qr-delete-title"/);
    expect(html).toMatch(/data-delete-confirm/);
    // Focus trap sentinels, so Tab cannot escape the dialog.
    expect(html).toMatch(/data-focus-sentinel/);

    // The old native-dialog code path left no trace: no inline confirm string in
    // markup, and the trigger is a plain button the island opens the dialog from.
    expect(html).not.toMatch(/onclick="confirm\(/);
    expect(html).toMatch(/<button[^>]*data-delete/);

    // The dialog is closed until asked for, and the escape hatch is present.
    expect(html).toMatch(/data-modal-close/);
    expect(html).toMatch(/aria-label="Close dialog"/);
  });

  it("keeps the wording about printed codes, because that is the actual consequence", async () => {
    const { user, cookie } = await account("del-copy");
    const biz = await businessFor(user.id);
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Table 4",
      is_dynamic: true,
      short_code: "d" + crypto.randomUUID().slice(0, 6),
      destination: "https://example.com/menu",
      content_json: "{}",
      design_json: "{}",
      business_id: biz.id,
    });
    const html = await (await get(`/app/${qr.id}`, cookie)).text();
    expect(html).toMatch(/undone/);
    expect(html).toMatch(/printed codes stop pointing/);
  });

  it("does not offer Delete on a claimed stand", async () => {
    // A stand is archived, never deleted: the registry keeps the identity for
    // every code ever printed. Deleting through a second path would break the
    // guarantee the whole product rests on.
    const { user, cookie } = await account("del-stand");
    const biz = await businessFor(user.id);
    const { qrId } = await claimedStand(user.id, biz.id);
    const html = await (await get(`/app/${qrId}`, cookie)).text();

    // It IS a stand: the detail page links to the stand manager, not the editor.
    expect(html).toMatch(/Manage stand/);
    // ...and therefore offers no Delete. Deleting a stand is a different, audited
    // operation (archive) that keeps the serial reserved forever.
    expect(html).not.toMatch(/data-delete-confirm/);
  });
});

// --- Copy to clipboard ------------------------------------------------------

describe("copy to clipboard", () => {
  it("keeps its icon, so the control does not change shape after one click", async () => {
    const { user, cookie } = await account("copy");
    const biz = await businessFor(user.id);
    // A claimed stand has a printed URL worth copying; an unclaimed code does not.
    const { qrId } = await claimedStand(user.id, biz.id);

    const html = await (await get(`/app/${qrId}`, cookie)).text();
    const copyBtn = /<button[^>]*data-copy="[^"]*"[^>]*>/.exec(html);
    expect(copyBtn, "expected a copy button on the printed URL").not.toBeNull();

    // The icon lives inside .btn-icon and the text inside .btn-label. The island
    // swaps only the label's text; if it ever used textContent the icon would be
    // destroyed on the first successful copy and never come back.
    const btnHtml = html.slice(copyBtn!.index, html.indexOf("</button>", copyBtn!.index));
    expect(btnHtml).toMatch(/btn-icon/);
    expect(btnHtml).toMatch(/btn-label/);

    // The value to copy is also in the DOM as selectable text, so a blocked
    // clipboard still leaves the user something to select and copy by hand.
    expect(html).toMatch(/id="qr-detail-printed-url"/);
    expect(btnHtml).toMatch(/data-copy-source="#qr-detail-printed-url"/);
  });
});

// --- Downloads --------------------------------------------------------------

describe("downloads", () => {
  it("serves a single QR's SVG as an attachment, not an inline document", async () => {
    // Inline + an href-only button opened a new tab that then had to be saved by
    // hand. The button is the download; the endpoint must cooperate.
    const { user, cookie } = await account("dl-svg");
    const biz = await businessFor(user.id);
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Table 4",
      is_dynamic: true,
      short_code: "d" + crypto.randomUUID().slice(0, 6),
      destination: "https://example.com/menu",
      content_json: "{}",
      design_json: "{}",
      business_id: biz.id,
    });

    const res = await get(`/api/qr/${qr.id}.svg`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");

    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/filename="?[^"]+\.svg"?/);

    // A Content-Disposition filename has to survive non-ASCII titles. RFC 6266
    // allows either the plain form or filename*, and this one carries the id so
    // the file is identifiable even when the title is emoji.
    expect(disposition).toMatch(/filename\*?=/);
  });

  it("still refuses to serve another owner's SVG", async () => {
    const { user: owner, cookie: ownerCookie } = await account("dl-owner");
    const { cookie: strangerCookie } = await account("dl-stranger");
    const biz = await businessFor(owner.id);
    const qr = await createQr(env.DB, {
      user_id: owner.id,
      type: "url",
      title: "Table 4",
      is_dynamic: true,
      short_code: "e" + crypto.randomUUID().slice(0, 6),
      destination: "https://example.com/menu",
      content_json: "{}",
      design_json: "{}",
      business_id: biz.id,
    });

    const mine = await get(`/api/qr/${qr.id}.svg`, ownerCookie);
    expect(mine.status).toBe(200);

    const theirs = await get(`/api/qr/${qr.id}.svg`, strangerCookie);
    expect(theirs.status).toBe(404);

    const anon = await get(`/api/qr/${qr.id}.svg`);
    expect(anon.status).toBe(401);
  });

  it("answers an unauthenticated JSON request with JSON, not a redirect to HTML", async () => {
    // A fetch that follows the 302 to /login gets an HTML login page and then
    // fails on res.json() with a parse error that tells the user nothing.
    const { user } = await account("dl-json");
    const biz = await businessFor(user.id);
    const qr = await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Table 4",
      is_dynamic: true,
      short_code: "d" + crypto.randomUUID().slice(0, 6),
      destination: "https://example.com/menu",
      content_json: "{}",
      design_json: "{}",
      business_id: biz.id,
    });

    const res = await call(
      new Request(`https://q.test/api/qr/${qr.id}.svg`, {
        headers: { accept: "application/json" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});