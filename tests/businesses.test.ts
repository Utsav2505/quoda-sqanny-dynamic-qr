import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { businesses } from "../src/routes/businesses";
import { dashboard } from "../src/routes/dashboard";
import { profile } from "../src/routes/profile";
import { qrApi } from "../src/routes/api/qr";
import {
  createUser,
  createBusiness,
  createQr,
  getBusinessRole,
  listBusinessesForUser,
  getBusinessForUser,
  updateUserProfile,
} from "../src/db/queries";
import { startSession } from "../src/lib/auth/session";
import { getUserById } from "../src/db/queries";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

/** A signed-in request for `userId` against `path`. */
function authed(userId: string, path: string): Promise<Request> {
  return startSession(env, userId).then((setCookie) => {
    const cookie = setCookie.split(";")[0];
    return new Request(`https://q.test${path}`, { headers: { Cookie: cookie } });
  });
}

function form(userId: string, path: string, body: Record<string, string>) {
  return authed(userId, path).then(
    (req) =>
      new Request(req, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Cookie: req.headers.get("Cookie")!,
        },
        body: new URLSearchParams(body).toString(),
      }),
  );
}

/** The minimum valid create payload — the six required fields. */
const VALID = {
  name: "ABC Cafe",
  category: "cafe",
  address: "12 Connaught Place",
  city: "New Delhi",
  state: "Delhi",
  country: "India",
};

async function seedBusiness(userId: string, over: Record<string, unknown> = {}) {
  return createBusiness(env.DB, userId, {
    ...VALID,
    ...over,
  } as Parameters<typeof createBusiness>[2]);
}

describe("POST /app/businesses/new", () => {
  it("creates a business and records the owner membership", async () => {
    const user = await createUser(env.DB, `biz-${crypto.randomUUID()}@example.com`);
    const res = await businesses.fetch(
      await form(user.id, "/app/businesses/new", VALID),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("notice=business-created");

    const list = await listBusinessesForUser(env.DB, user.id);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("ABC Cafe");
    expect(list[0].city).toBe("New Delhi");
    expect(await getBusinessRole(env.DB, list[0].id, user.id)).toBe("owner");
  });

  it("makes the first business the active scope", async () => {
    const user = await createUser(env.DB, `first-${crypto.randomUUID()}@example.com`);
    await businesses.fetch(
      await form(user.id, "/app/businesses/new", VALID),
      env,
      ctx,
    );
    const reloaded = await getUserById(env.DB, user.id);
    const list = await listBusinessesForUser(env.DB, user.id);
    expect(reloaded?.current_business_id).toBe(list[0].id);
  });

  it("leaves the scope alone when a second business is added", async () => {
    const user = await createUser(env.DB, `second-${crypto.randomUUID()}@example.com`);
    await businesses.fetch(
      await form(user.id, "/app/businesses/new", { ...VALID, name: "First" }),
      env,
      ctx,
    );
    const [first] = await listBusinessesForUser(env.DB, user.id);

    await businesses.fetch(
      await form(user.id, "/app/businesses/new", { ...VALID, name: "Second" }),
      env,
      ctx,
    );
    const reloaded = await getUserById(env.DB, user.id);
    expect(reloaded?.current_business_id).toBe(first.id);
  });

  it("re-renders with field errors and persists nothing when required fields are blank", async () => {
    const user = await createUser(env.DB, `bad-${crypto.randomUUID()}@example.com`);
    const res = await businesses.fetch(
      await form(user.id, "/app/businesses/new", {
        name: "",
        category: "",
        address: "",
        city: "",
        state: "",
        country: "",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Business name is required.");
    expect(html).toContain("City is required.");
    expect(html).toContain("State is required.");
    expect(await listBusinessesForUser(env.DB, user.id)).toHaveLength(0);
  });

  it("requires a custom category name when the category is 'other'", async () => {
    const user = await createUser(env.DB, `other-${crypto.randomUUID()}@example.com`);
    const res = await businesses.fetch(
      await form(user.id, "/app/businesses/new", {
        ...VALID,
        category: "other",
        custom_category: "",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Enter a category name.");
  });

  it("rejects an unknown category instead of storing it", async () => {
    const user = await createUser(env.DB, `cat-${crypto.randomUUID()}@example.com`);
    const res = await businesses.fetch(
      await form(user.id, "/app/businesses/new", {
        ...VALID,
        category: "not-a-real-category",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    expect(await listBusinessesForUser(env.DB, user.id)).toHaveLength(0);
  });

  it("normalizes a bare domain into an absolute URL", async () => {
    const user = await createUser(env.DB, `url-${crypto.randomUUID()}@example.com`);
    await businesses.fetch(
      await form(user.id, "/app/businesses/new", { ...VALID, website: "abccafe.com" }),
      env,
      ctx,
    );
    const [row] = await listBusinessesForUser(env.DB, user.id);
    // Canonical form: scheme added, bare origin slash dropped. "abccafe.com" and
    // "https://abccafe.com/" must not become two different stored strings.
    expect(row.website).toBe("https://abccafe.com");
  });

  it("rejects a non-http URL scheme rather than storing it", async () => {
    const user = await createUser(env.DB, `js-${crypto.randomUUID()}@example.com`);
    const res = await businesses.fetch(
      await form(user.id, "/app/businesses/new", {
        ...VALID,
        website: "javascript:alert(1)",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    expect(await listBusinessesForUser(env.DB, user.id)).toHaveLength(0);
  });

  it("ignores an uploaded key that belongs to another account", async () => {
    const owner = await createUser(env.DB, `logo-${crypto.randomUUID()}@example.com`);
    const attacker = await createUser(
      env.DB,
      `steal-${crypto.randomUUID()}@example.com`,
    );

    const res = await businesses.fetch(
      await form(attacker.id, "/app/businesses/new", {
        ...VALID,
        logo_key: `logos/${owner.id}/forged.png`,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("That image could not be used");
    expect(await listBusinessesForUser(env.DB, attacker.id)).toHaveLength(0);
  });
});

describe("GET /app/businesses", () => {
  it("redirects to /login without a session", async () => {
    const res = await businesses.fetch(
      new Request("https://q.test/app/businesses"),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("shows an actionable empty state for a new account", async () => {
    const user = await createUser(env.DB, `empt-${crypto.randomUUID()}@example.com`);
    const res = await businesses.fetch(
      await authed(user.id, "/app/businesses"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No businesses yet");
    expect(html).toContain("/app/businesses/new");
  });

  it("lists only the caller's own businesses", async () => {
    const mine = await createUser(env.DB, `mine-${crypto.randomUUID()}@example.com`);
    const theirs = await createUser(env.DB, `theirs-${crypto.randomUUID()}@example.com`);
    await seedBusiness(mine.id, { name: "My Cafe" });
    await seedBusiness(theirs.id, { name: "Secret Diner" });

    const html = await (await businesses.fetch(
      await authed(mine.id, "/app/businesses"),
      env,
      ctx,
    )).text();

    expect(html).toContain("My Cafe");
    expect(html).not.toContain("Secret Diner");
  });
});

describe("GET /app/businesses/:id — authorization", () => {
  it("404s for a business owned by somebody else, without leaking its name", async () => {
    const mine = await createUser(env.DB, `a-${crypto.randomUUID()}@example.com`);
    const theirs = await createUser(env.DB, `b-${crypto.randomUUID()}@example.com`);
    const secret = await seedBusiness(theirs.id, { name: "Secret Diner" });

    const res = await businesses.fetch(
      await authed(mine.id, `/app/businesses/${secret.id}`),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Business not found");
    // A 403 here would confirm the id exists on another account.
    expect(html).not.toContain("Secret Diner");
  });

  it("refuses to edit somebody else's business", async () => {
    const mine = await createUser(env.DB, `c-${crypto.randomUUID()}@example.com`);
    const theirs = await createUser(env.DB, `d-${crypto.randomUUID()}@example.com`);
    const secret = await seedBusiness(theirs.id, { name: "Secret Diner" });

    const res = await businesses.fetch(
      await form(mine.id, `/app/businesses/${secret.id}/edit`, {
        ...VALID,
        name: "Hijacked",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);

    const after = await getBusinessForUser(env.DB, secret.id, theirs.id);
    expect(after?.name).toBe("Secret Diner");
  });
});

describe("POST /app/businesses/:id/edit", () => {
  it("saves changes and flashes a confirmation", async () => {
    const user = await createUser(env.DB, `edit-${crypto.randomUUID()}@example.com`);
    const biz = await seedBusiness(user.id);

    const res = await businesses.fetch(
      await form(user.id, `/app/businesses/${biz.id}/edit`, {
        ...VALID,
        name: "ABC Cafe & Co",
        phone: "",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/app/businesses/${biz.id}?notice=business-updated`,
    );

    const after = await getBusinessForUser(env.DB, biz.id, user.id);
    expect(after?.name).toBe("ABC Cafe & Co");
  });

  it("clears an optional field when it is submitted empty", async () => {
    const user = await createUser(env.DB, `clr-${crypto.randomUUID()}@example.com`);
    const biz = await createBusiness(env.DB, user.id, {
      ...VALID,
      phone: "+91 98100 00000",
    });

    await businesses.fetch(
      await form(user.id, `/app/businesses/${biz.id}/edit`, { ...VALID, phone: "" }),
      env,
      ctx,
    );
    const after = await getBusinessForUser(env.DB, biz.id, user.id);
    expect(after?.phone).toBeNull();
  });

  it("rejects an invalid phone and keeps the old value", async () => {
    const user = await createUser(env.DB, `ph-${crypto.randomUUID()}@example.com`);
    const biz = await createBusiness(env.DB, user.id, {
      ...VALID,
      phone: "+91 98100 00000",
    });

    const res = await businesses.fetch(
      await form(user.id, `/app/businesses/${biz.id}/edit`, {
        ...VALID,
        phone: "abc",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    const after = await getBusinessForUser(env.DB, biz.id, user.id);
    expect(after?.phone).toBe("+91 98100 00000");
  });

  it("round-trips opening hours", async () => {
    const user = await createUser(env.DB, `hrs-${crypto.randomUUID()}@example.com`);
    const biz = await seedBusiness(user.id);

    await businesses.fetch(
      await form(user.id, `/app/businesses/${biz.id}/edit`, {
        ...VALID,
        hours_mon_closed: "1",
        hours_tue_open: "09:00",
        hours_tue_close: "18:30",
      }),
      env,
      ctx,
    );

    const after = await getBusinessForUser(env.DB, biz.id, user.id);
    const hours = JSON.parse(after!.hours_json!);
    expect(hours.mon).toEqual({ open: null, close: null, closed: true });
    expect(hours.tue).toEqual({ open: "09:00", close: "18:30", closed: false });
  });
});

describe("POST /app/businesses/:id/status", () => {
  it("archives without deleting, preserving the record", async () => {
    const user = await createUser(env.DB, `arch-${crypto.randomUUID()}@example.com`);
    const biz = await seedBusiness(user.id);

    const res = await businesses.fetch(
      await form(user.id, `/app/businesses/${biz.id}/status`, { status: "archived" }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("notice=business-archived");

    const after = await getBusinessForUser(env.DB, biz.id, user.id);
    expect(after?.status).toBe("archived");
    expect(after?.name).toBe("ABC Cafe");
  });

  it("clears the active scope when the current business is archived", async () => {
    const user = await createUser(env.DB, `unsc-${crypto.randomUUID()}@example.com`);
    const biz = await seedBusiness(user.id);
    // Scope it explicitly: `seedBusiness` writes straight to D1, so it skips
    // the "first business becomes current" rule the route applies.
    await env.DB.prepare("UPDATE users SET current_business_id = ? WHERE id = ?")
      .bind(biz.id, user.id)
      .run();
    expect((await getUserById(env.DB, user.id))?.current_business_id).toBe(biz.id);

    await businesses.fetch(
      await form(user.id, `/app/businesses/${biz.id}/status`, { status: "archived" }),
      env,
      ctx,
    );
    expect((await getUserById(env.DB, user.id))?.current_business_id).toBeNull();
  });

  it("restores an archived business", async () => {
    const user = await createUser(env.DB, `res-${crypto.randomUUID()}@example.com`);
    const biz = await seedBusiness(user.id);
    await businesses.fetch(
      await form(user.id, `/app/businesses/${biz.id}/status`, { status: "archived" }),
      env,
      ctx,
    );

    const res = await businesses.fetch(
      await form(user.id, `/app/businesses/${biz.id}/status`, { status: "active" }),
      env,
      ctx,
    );
    expect(res.headers.get("location")).toContain("notice=business-restored");
    expect((await getBusinessForUser(env.DB, biz.id, user.id))?.status).toBe("active");
  });

  it("rejects a status outside the enum", async () => {
    const user = await createUser(env.DB, `st-${crypto.randomUUID()}@example.com`);
    const biz = await seedBusiness(user.id);

    const res = await businesses.fetch(
      await form(user.id, `/app/businesses/${biz.id}/status`, { status: "deleted" }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect((await getBusinessForUser(env.DB, biz.id, user.id))?.status).toBe("active");
  });

  it("cannot archive somebody else's business", async () => {
    const mine = await createUser(env.DB, `e-${crypto.randomUUID()}@example.com`);
    const theirs = await createUser(env.DB, `f-${crypto.randomUUID()}@example.com`);
    const secret = await seedBusiness(theirs.id);

    const res = await businesses.fetch(
      await form(mine.id, `/app/businesses/${secret.id}/status`, {
        status: "archived",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect((await getBusinessForUser(env.DB, secret.id, theirs.id))?.status).toBe(
      "active",
    );
  });
});

describe("POST /app/businesses/switch", () => {
  it("sets the active business", async () => {
    const user = await createUser(env.DB, `sw-${crypto.randomUUID()}@example.com`);
    const biz = await seedBusiness(user.id);

    const res = await businesses.fetch(
      await form(user.id, "/app/businesses/switch", { business_id: biz.id }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect((await getUserById(env.DB, user.id))?.current_business_id).toBe(biz.id);
  });

  it("an empty id means 'All businesses'", async () => {
    const user = await createUser(env.DB, `all-${crypto.randomUUID()}@example.com`);
    await seedBusiness(user.id);

    await businesses.fetch(
      await form(user.id, "/app/businesses/switch", { business_id: "" }),
      env,
      ctx,
    );
    expect((await getUserById(env.DB, user.id))?.current_business_id).toBeNull();
  });

  it("refuses to scope to a business the caller does not own", async () => {
    const mine = await createUser(env.DB, `g-${crypto.randomUUID()}@example.com`);
    const theirs = await createUser(env.DB, `h-${crypto.randomUUID()}@example.com`);
    const secret = await seedBusiness(theirs.id);

    await businesses.fetch(
      await form(mine.id, "/app/businesses/switch", { business_id: secret.id }),
      env,
      ctx,
    );
    expect((await getUserById(env.DB, mine.id))?.current_business_id).toBeNull();
  });

  it("rejects an off-site redirect target", async () => {
    const user = await createUser(env.DB, `red-${crypto.randomUUID()}@example.com`);
    const biz = await seedBusiness(user.id);

    const res = await businesses.fetch(
      await form(user.id, "/app/businesses/switch", {
        business_id: biz.id,
        next: "https://evil.test/steal",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/app");
    expect(res.headers.get("location")).not.toContain("evil.test");
  });

  it("rejects a protocol-relative redirect target", async () => {
    const user = await createUser(env.DB, `red2-${crypto.randomUUID()}@example.com`);
    const biz = await seedBusiness(user.id);

    const res = await businesses.fetch(
      await form(user.id, "/app/businesses/switch", {
        business_id: biz.id,
        next: "//evil.test/steal",
      }),
      env,
      ctx,
    );
    expect(res.headers.get("location")).not.toContain("evil.test");
  });
});

describe("dashboard business scoping", () => {
  it("hides another business's QRs when a business is selected", async () => {
    const user = await createUser(env.DB, `scope-${crypto.randomUUID()}@example.com`);
    const cafe = await createBusiness(env.DB, user.id, { ...VALID, name: "Cafe" });
    const diner = await createBusiness(env.DB, user.id, { ...VALID, name: "Diner" });

    await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Cafe QR",
      content_json: "{}",
      design_json: "{}",
      business_id: cafe.id,
    });
    await createQr(env.DB, {
      user_id: user.id,
      type: "url",
      title: "Diner QR",
      content_json: "{}",
      design_json: "{}",
      business_id: diner.id,
    });

    const req = await authed(user.id, "/app");
    await env.DB.prepare("UPDATE users SET current_business_id = ? WHERE id = ?")
      .bind(cafe.id, user.id)
      .run();

    const html = await (await dashboard.fetch(req, env, ctx)).text();
    expect(html).toContain("Cafe QR");
    expect(html).not.toContain("Diner QR");
  });

  it("falls back to the wide view when the stored scope is not the caller's", async () => {
    const mine = await createUser(env.DB, `i-${crypto.randomUUID()}@example.com`);
    const theirs = await createUser(env.DB, `j-${crypto.randomUUID()}@example.com`);
    const secret = await createBusiness(env.DB, theirs.id, {
      ...VALID,
      name: "Secret Diner",
    });
    await createQr(env.DB, {
      user_id: theirs.id,
      type: "url",
      title: "Secret QR",
      content_json: "{}",
      design_json: "{}",
      business_id: secret.id,
    });

    // A stale/hostile scope: the id is real, but not this user's.
    await env.DB.prepare("UPDATE users SET current_business_id = ? WHERE id = ?")
      .bind(secret.id, mine.id)
      .run();

    const html = await (await dashboard.fetch(
      await authed(mine.id, "/app"),
      env,
      ctx,
    )).text();
    expect(html).not.toContain("Secret QR");
  });

  it("shows a business-specific empty state when a scope has no codes", async () => {
    const user = await createUser(env.DB, `emp2-${crypto.randomUUID()}@example.com`);
    const cafe = await createBusiness(env.DB, user.id, { ...VALID, name: "Cafe" });
    await env.DB.prepare("UPDATE users SET current_business_id = ? WHERE id = ?")
      .bind(cafe.id, user.id)
      .run();

    const html = await (await dashboard.fetch(
      await authed(user.id, "/app"),
      env,
      ctx,
    )).text();
    expect(html).toContain("No codes for Cafe yet");
  });
});

describe("POST /api/qr business assignment", () => {
  async function postQr(userId: string, body: Record<string, unknown>) {
    const req = await authed(userId, "/api/qr");
    return qrApi.fetch(
      new Request(req, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: req.headers.get("Cookie")!,
        },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
  }

  const QR = { type: "url", title: "Link", content: { url: "https://example.com" } };

  it("assigns a new code to one of the caller's businesses", async () => {
    const user = await createUser(env.DB, `api-${crypto.randomUUID()}@example.com`);
    const biz = await createBusiness(env.DB, user.id, { ...VALID, name: "Cafe" });

    const res = await postQr(user.id, { ...QR, business_id: biz.id });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; qr: { business_id: string } };
    expect(json.qr.business_id).toBe(biz.id);
  });

  it("refuses to file a code under another tenant's business", async () => {
    const mine = await createUser(env.DB, `k-${crypto.randomUUID()}@example.com`);
    const theirs = await createUser(env.DB, `l-${crypto.randomUUID()}@example.com`);
    const secret = await createBusiness(env.DB, theirs.id, { ...VALID, name: "Cafe" });

    const res = await postQr(mine.id, { ...QR, business_id: secret.id });
    expect(res.status).toBe(400);
  });

  it("creates an unassigned code when business_id is omitted", async () => {
    const user = await createUser(env.DB, `m-${crypto.randomUUID()}@example.com`);
    const res = await postQr(user.id, QR);
    const json = (await res.json()) as { ok: boolean; qr: { business_id: string | null } };
    expect(json.qr.business_id).toBeNull();
  });
});

describe("GET/POST /app/profile", () => {
  it("redirects to /login without a session", async () => {
    const res = await profile.fetch(
      new Request("https://q.test/app/profile"),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("shows the completeness meter and the next prompt", async () => {
    const user = await createUser(env.DB, `p-${crypto.randomUUID()}@example.com`);
    const html = await (await profile.fetch(
      await authed(user.id, "/app/profile"),
      env,
      ctx,
    )).text();

    expect(html).toContain("Profile completeness");
    expect(html).toContain("Add your name");
    expect(html).toContain("Create a business");
    // The single most useful next step is the prompt, not a wall of todos.
    expect(html).toContain('class="btn btn-primary btn-block" href="/app/profile"');
  });

  it("saves name and phone and flashes a confirmation", async () => {
    const user = await createUser(env.DB, `p2-${crypto.randomUUID()}@example.com`);
    const res = await profile.fetch(
      await form(user.id, "/app/profile", {
        name: "Alex Rivera",
        phone: "+1 555 0100",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/profile?notice=profile-updated");

    const after = await getUserById(env.DB, user.id);
    expect(after?.name).toBe("Alex Rivera");
    expect(after?.phone).toBe("+1 555 0100");
  });

  it("keeps the email immutable — it is the login identity", async () => {
    const user = await createUser(env.DB, `p3-${crypto.randomUUID()}@example.com`);
    const original = user.email;

    await profile.fetch(
      await form(user.id, "/app/profile", {
        name: "Alex",
        phone: "",
        email: "attacker@evil.test",
      }),
      env,
      ctx,
    );
    expect((await getUserById(env.DB, user.id))?.email).toBe(original);
  });

  it("re-renders with an error and writes nothing when the name is blank", async () => {
    const user = await createUser(env.DB, `p4-${crypto.randomUUID()}@example.com`);
    const res = await profile.fetch(
      await form(user.id, "/app/profile", { name: "  ", phone: "" }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Name is required.");
    expect((await getUserById(env.DB, user.id))?.name).toBeNull();
  });

  it("clears the phone when the field is emptied", async () => {
    const user = await createUser(env.DB, `p5-${crypto.randomUUID()}@example.com`);
    await updateUserProfile(env.DB, user.id, { phone: "+1 555 0100" });

    await profile.fetch(
      await form(user.id, "/app/profile", { name: "Alex", phone: "" }),
      env,
      ctx,
    );
    expect((await getUserById(env.DB, user.id))?.phone).toBeNull();
  });

  it("rejects an avatar key belonging to another account", async () => {
    const owner = await createUser(env.DB, `n-${crypto.randomUUID()}@example.com`);
    const attacker = await createUser(env.DB, `o-${crypto.randomUUID()}@example.com`);

    const res = await profile.fetch(
      await form(attacker.id, "/app/profile", {
        name: "Mallory",
        phone: "",
        avatar_key: `avatars/${owner.id}/forged.png`,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
    expect((await getUserById(env.DB, attacker.id))?.avatar_key).toBeNull();
  });
});
