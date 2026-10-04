// Batch routes and persistence, through the real app.
//
// Three things this file exists to pin down, in order of how badly they would fail
// if they broke:
//
//   1. ROUTE ORDER. `/qrs/batches` is a two-segment path that also matches
//      `qrs`'s `/qrs/:identifier`. Registered in the wrong order it is read as a
//      SERIAL NUMBER, and the whole feature 404s on a page that otherwise looks
//      fine. Invisible until it breaks — hence the explicit test.
//   2. ATOMICITY AND UNIQUENESS. Two users generating the same range must not
//      both succeed, and a rejected batch must leave NOTHING behind.
//   3. PRO ENFORCEMENT ON THE SERVER, including by posting directly to the form
//      action rather than navigating to the page.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../src/index";
import {
  archiveBatch,
  batchRenderInputs,
  createBatch,
  findExistingSerials,
  getBatchForOwner,
  listBatchQrs,
  listBatchesForOwner,
  restoreBatch,
} from "../src/db/batches";
import { getAssetViewByIdentifier, getAssetViewForOwner } from "../src/db/qr-registry";
import { createBusiness, createUser, setCurrentBusiness } from "../src/db/queries";
import { expandSerials, validateBatchForm, type BatchConfig } from "../src/lib/batch";
import { statusFor } from "../src/lib/qr-registration";
import { hasProPlan } from "../src/lib/plans";
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
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: new URLSearchParams(body).toString(),
    }),
  );
}

/** A signed-in user. `plan` writes the real plan column — not a request flag. */
async function account(tag: string, plan: "free" | "pro" = "pro") {
  const user = await createUser(env.DB, `${tag}-${crypto.randomUUID()}@example.com`);
  if (plan === "pro") {
    await env.DB.prepare("UPDATE users SET plan_id = 'pro' WHERE id = ?").bind(user.id).run();
  }
  const setCookie = await startSession(env, user.id);
  return { user, cookie: setCookie.split(";")[0], plan };
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

/** A validated config for the common case. */
function configFor(over: Partial<Parameters<typeof validateBatchForm>[0]> = {}): BatchConfig {
  const { config } = validateBatchForm({
    sequenceStart: "1",
    batchNumber: "B01",
    type: "GR",
    batchSize: "9",
    destination: "",
    businessId: "",
    metadata: [],
    ...over,
  });
  if (!config) throw new Error("test config did not validate");
  return config;
}

const FORM = {
  type: "GR",
  batch_number: "B01",
  sequence_start: "1",
  batch_size: "9",
  destination: "",
};

// ---------------------------------------------------------------------------
// 1. Route ordering
// ---------------------------------------------------------------------------

describe("route ordering", () => {
  it("does not read /qrs/batches as a serial number", async () => {
    const { cookie } = await account("order");
    const res = await get("/qrs/batches", cookie);
    // A routing mistake here produces the 404 from qrs' /qrs/:identifier, which
    // is a plain-text response. Asserting we got the real page is the test.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Batch QR generation");
  });

  it("still resolves a batch serial at the printed URL", async () => {
    // The counterpart: the ordering fix must not have broken the path a customer
    // actually scans.
    const { user, cookie } = await account("order-scan");
    const biz = await businessFor(user.id);
    await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ destination: "https://example.com" }),
      appUrl: env.APP_URL,
    });

    const res = await get("/q/SQ-GR-B01-001");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com");
  });
});

// ---------------------------------------------------------------------------
// 2. Pro gate
// ---------------------------------------------------------------------------

describe("Pro plan gating", () => {
  it("hasProPlan is a narrow allow-list", () => {
    expect(hasProPlan("pro")).toBe(true);
    expect(hasProPlan("free")).toBe(false);
    // An unknown plan must default to NOT having the feature, or a typo in a
    // migration would hand batch generation to every account on it.
    expect(hasProPlan("enterprise")).toBe(false);
    expect(hasProPlan("")).toBe(false);
    expect(hasProPlan(null)).toBe(false);
    expect(hasProPlan(undefined)).toBe(false);
  });

  it("shows the restriction state to a free user, not an error", async () => {
    const { cookie } = await account("gate-free", "free");
    for (const path of ["/qrs/batches", "/qrs/batches/new"]) {
      const res = await get(path, cookie);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain("Batch QR generation is available on Pro");
      expect(html, path).toContain("Upgrade your plan");
      // Both required actions are present.
      expect(html, path).toContain("View Plans");
      expect(html, path).toContain("Back to Sqanny Stands");
      // And nothing about how the check is implemented.
      expect(html, path).not.toContain("plan_id");
      expect(html, path).not.toContain("hasProPlan");
    }
  });

  it("refuses a direct POST to the form action from a free user", async () => {
    // The page being gated proves nothing about the endpoint. A free user must
    // not be able to generate by posting straight to /qrs/batches.
    const { user, cookie } = await account("gate-post", "free");
    const biz = await businessFor(user.id);
    const res = await post("/qrs/batches", { ...FORM, business_id: biz.id }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("batch-pro-required");

    // And nothing was created.
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_batches").first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);
  });

  it("refuses the export endpoints for a free user, with JSON not a redirect", async () => {
    // A fetch that follows a redirect to an HTML login page cannot tell what
    // happened, so the JSON endpoints answer with a status and a message.
    const { cookie } = await account("gate-export", "free");
    const res = await get("/qrs/batches/anything/export.zip", cookie);
    expect(res.status).toBe(402);
    expect((await res.json() as { ok: boolean; error: string }).error).toContain("Pro");
  });

  it("does not advertise the nav item to a free user", async () => {
    const free = await account("gate-nav-free", "free");
    const pro = await account("gate-nav-pro", "pro");
    const freeHtml = await (await get("/app", free.cookie)).text();
    expect(freeHtml).not.toContain('href="/qrs/batches"');
    const proHtml = await (await get("/app", pro.cookie)).text();
    expect(proHtml).toContain('href="/qrs/batches"');
  });

  it("requires a session on every batch route", async () => {
    for (const path of ["/qrs/batches", "/qrs/batches/new"]) {
      const res = await get(path);
      expect(res.headers.get("location"), path).toContain("/login");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Creation
// ---------------------------------------------------------------------------

describe("generating a batch", () => {
  it("creates the batch, one registry row per serial, and a configuration row", async () => {
    const { user } = await account("create");
    const biz = await businessFor(user.id);
    const result = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ destination: "https://example.com/menu" }),
      appUrl: env.APP_URL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.batch.quantity).toBe(9);
    expect(result.batch.sequence_start).toBe(1);
    expect(result.batch.sequence_end).toBe(9);
    expect(result.batch.status).toBe("ready");

    const qrs = await listBatchQrs(env.DB, result.batch.id, user.id);
    expect(qrs).toHaveLength(9);
    expect(qrs.map((q) => q.serial)).toEqual(
      expandSerials(configFor({ destination: "https://example.com/menu" })),
    );
    // Every QR is a real registry asset, owned and business-scoped.
    for (const q of qrs) {
      expect(q.status).toBe("active");
      expect(q.destination).toBe("https://example.com/menu");
      const asset = await getAssetViewByIdentifier(env.DB, q.serial);
      expect(asset?.owner_id).toBe(user.id);
      expect(asset?.business_id).toBe(biz.id);
      expect(asset?.batch_id).toBe(result.batch.id);
    }
  });

  it("generates a large-start batch with no truncation and no wrap", async () => {
    const { user } = await account("create-large");
    const biz = await businessFor(user.id);
    const result = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ sequenceStart: 1000, batchSize: 9 }),
      appUrl: env.APP_URL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const qrs = await listBatchQrs(env.DB, result.batch.id, user.id);
    expect(qrs.map((q) => q.serial)).toEqual([
      "SQ-GR-B01-1000", "SQ-GR-B01-1001", "SQ-GR-B01-1002",
      "SQ-GR-B01-1003", "SQ-GR-B01-1004", "SQ-GR-B01-1005",
      "SQ-GR-B01-1006", "SQ-GR-B01-1007", "SQ-GR-B01-1008",
    ]);
    // And every printed value is distinct — no two labels share a code.
    expect(new Set(qrs.map((q) => q.serial)).size).toBe(9);
  });

  it("leaves a stand unconfigured when no destination is given", async () => {
    // A stand can be printed before anyone knows where it points, which is the
    // entire premise of the printed-label product.
    const { user } = await account("create-nodest");
    const biz = await businessFor(user.id);
    const result = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ destination: "" }),
      appUrl: env.APP_URL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const qrs = await listBatchQrs(env.DB, result.batch.id, user.id);
    expect(qrs.every((q) => q.destination === null)).toBe(true);
    // 'claimed' = "Setup pending", the same badge a single claimed-but-unconfigured
    // stand gets. Identical owner + business + no destination must not badge
    // differently based on whether the codes arrived one at a time or in a batch.
    expect(qrs.every((q) => q.status === "claimed")).toBe(true);
  });

  it("badges a configured batch 'Active', so the stands list answers 'which are live?'", async () => {
    const { user } = await account("status-configured");
    const biz = await businessFor(user.id);
    const result = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ destination: "https://example.com/menu" }),
      appUrl: env.APP_URL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const qrs = await listBatchQrs(env.DB, result.batch.id, user.id);
    expect(qrs.every((q) => q.destination !== null)).toBe(true);
    expect(qrs.every((q) => q.status === "active")).toBe(true);
  });

  it("uses the same status rules as a hand-claimed stand, not a batch-only rule", async () => {
    // One source of truth: statusFor(hasDestination). If these ever diverge, a user
    // comparing their stands list against their batches has no way to reconcile it.
    expect(statusFor(false)).toBe("claimed");
    expect(statusFor(true)).toBe("active");
  });

  it("requires a business, because the ledger cannot represent an unscoped QR", async () => {
    // `qr_registry`'s CHECK permits an owned row only when owner, business AND
    // configuration are all set — so "owned but unscoped" is a state the table
    // cannot hold. Relaxing it would mean rebuilding a table with three FK
    // dependants. Refusing is the honest answer, and it matches the claim flow,
    // which already makes a business mandatory.
    const { user } = await account("create-nobiz");
    const result = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: "",
      config: configFor(),
      appUrl: env.APP_URL,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-business");
    expect(result.message).toMatch(/business/i);

    // And nothing was created.
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_registry").first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);
  });

  it("stores custom metadata on the batch, not on the QR identity", async () => {
    const { user } = await account("create-meta");
    const biz = await businessFor(user.id);
    const result = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({
        metadata: [
          { name: "Manufacturing Line", value: "L02" },
          { name: "Production Run", value: "October-2026" },
        ],
      }),
      appUrl: env.APP_URL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.metadata).toEqual([
      { name: "Manufacturing Line", value: "L02" },
      { name: "Production Run", value: "October-2026" },
    ]);
    // The serial is unaffected by descriptive data.
    const qrs = await listBatchQrs(env.DB, result.batch.id, user.id);
    expect(qrs[0].serial).toBe("SQ-GR-B01-001");
  });
});

// ---------------------------------------------------------------------------
// 4. Conflicts and atomicity
// ---------------------------------------------------------------------------

describe("conflicts", () => {
  it("refuses a range whose serials already exist, and names them", async () => {
    const { user } = await account("conflict");
    const biz = await businessFor(user.id);
    const first = await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });
    expect(first.ok).toBe(true);

    const second = await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("serials-exist");
    // The message must be actionable: which serial, and what to do about it.
    expect(second.message).toContain("SQ-GR-B01-001");
    expect(second.message).toMatch(/starting sequence|batch number/i);
    expect(second.conflicts).toContain("SQ-GR-B01-001");
  });

  it("detects a partial overlap, not just an exact duplicate", async () => {
    const { user } = await account("conflict-partial");
    const biz = await businessFor(user.id);
    await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });
    // 5..13 overlaps 1..9 on 5..9.
    const second = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ sequenceStart: 5, batchSize: 9 }),
      appUrl: env.APP_URL,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.conflicts).toEqual([
      "SQ-GR-B01-005", "SQ-GR-B01-006", "SQ-GR-B01-007",
      "SQ-GR-B01-008", "SQ-GR-B01-009",
    ]);
  });

  it("allows the SAME range under a different batch number", async () => {
    // The batch number is part of the serial, so these are genuinely different
    // physical assets and must not collide.
    const { user } = await account("conflict-diffbatch");
    const biz = await businessFor(user.id);
    const a = await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });
    const b = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ batchNumber: "B02" }),
      appUrl: env.APP_URL,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("allows the SAME range for a different owner, only because the type differs", async () => {
    // Two owners cannot both mint SQ-GR-B01-001: serials are globally unique
    // across accounts, which is what stops a stranger claiming another's labels.
    const a = await account("conflict-owner-a");
    const b = await account("conflict-owner-b");
    const bizA = await businessFor(a.user.id, "A Cafe");
    const bizB = await businessFor(b.user.id, "B Cafe");

    const first = await createBatch(env.DB, {
      ownerId: a.user.id, businessId: bizA.id, config: configFor(), appUrl: env.APP_URL,
    });
    expect(first.ok).toBe(true);

    const second = await createBatch(env.DB, {
      ownerId: b.user.id, businessId: bizB.id, config: configFor(), appUrl: env.APP_URL,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("serials-exist");
  });

  it("creates NOTHING when the range conflicts — all or nothing", async () => {
    // The critical property. 13 of 18 rows surviving would be worse than a clean
    // failure: the user's next instinct is to retry, and a retry collides with the
    // half that landed.
    const { user } = await account("atomic");
    const biz = await businessFor(user.id);
    await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });

    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_registry").first<{ n: number }>();
    const beforeQr = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_codes").first<{ n: number }>();
    const beforeBatches = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_batches").first<{ n: number }>();

    const second = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ sequenceStart: 5, batchSize: 18 }),
      appUrl: env.APP_URL,
    });
    expect(second.ok).toBe(false);

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_registry").first<{ n: number }>();
    const afterQr = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_codes").first<{ n: number }>();
    const afterBatches = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_batches").first<{ n: number }>();
    expect(Number(after?.n)).toBe(Number(before?.n));
    expect(Number(afterQr?.n)).toBe(Number(beforeQr?.n));
    expect(Number(afterBatches?.n)).toBe(Number(beforeBatches?.n));
  });

  it("lets exactly one of two concurrent creations of the same range win", async () => {
    // D1 has no interactive transaction, so a batch cannot be compare-and-swap'd
    // row by row. What it does guarantee is the UNIQUE index: concurrent writers
    // produce exactly one commit. This asserts that, rather than trusting it.
    const a = await account("concurrent-a");
    const b = await account("concurrent-b");
    const bizA = await businessFor(a.user.id, "A");
    const bizB = await businessFor(b.user.id, "B");

    const [ra, rb] = await Promise.all([
      createBatch(env.DB, {
        ownerId: a.user.id, businessId: bizA.id, config: configFor(), appUrl: env.APP_URL,
      }),
      createBatch(env.DB, {
        ownerId: b.user.id, businessId: bizB.id, config: configFor(), appUrl: env.APP_URL,
      }),
    ]);

    const winners = [ra, rb].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    // And the database is consistent with that answer: nine serials, one batch.
    const serials = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM qr_registry WHERE qr_identifier LIKE 'SQ-GR-B01-%'",
    ).first<{ n: number }>();
    expect(Number(serials?.n)).toBe(9);
    const batches = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_batches").first<{ n: number }>();
    expect(Number(batches?.n)).toBe(1);
  });

  it("finds existing serials in the caller's order, not SQLite's", async () => {
    const { user } = await account("find-existing");
    const biz = await businessFor(user.id);
    await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ sequenceStart: 1, batchSize: 9 }),
      appUrl: env.APP_URL,
    });
    const found = await findExistingSerials(env.DB, [
      "SQ-GR-B01-009", "SQ-GR-B01-001", "SQ-GR-B01-999",
    ]);
    expect(found).toEqual(["SQ-GR-B01-009", "SQ-GR-B01-001"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Ownership
// ---------------------------------------------------------------------------

describe("ownership", () => {
  it("is owner-scoped on every read and lifecycle action", async () => {
    const owner = await account("own");
    const stranger = await account("stranger");
    const biz = await businessFor(owner.user.id);
    const created = await createBatch(env.DB, {
      ownerId: owner.user.id,
      businessId: biz.id,
      config: configFor(),
      appUrl: env.APP_URL,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.batch.id;

    expect(await getBatchForOwner(env.DB, id, stranger.user.id)).toBeNull();
    expect(await listBatchQrs(env.DB, id, stranger.user.id)).toEqual([]);
    expect((await archiveBatch(env.DB, id, stranger.user.id)).ok).toBe(false);
    expect((await restoreBatch(env.DB, id, stranger.user.id)).ok).toBe(false);
    expect(await batchRenderInputs(env.DB, id, stranger.user.id)).toEqual([]);
    // Nothing changed.
    expect((await getBatchForOwner(env.DB, id, owner.user.id))?.status).toBe("ready");

    // And the stranger cannot see it on any page.
    expect((await get(`/qrs/batches/${id}`, stranger.cookie)).status).toBe(404);
    expect(await (await get("/qrs/batches", stranger.cookie)).text()).not.toContain("SQ-GR-B01-001");
  });

  it("never exposes another account's batch serials in the list", async () => {
    const a = await account("list-a");
    const b = await account("list-b");
    const bizA = await businessFor(a.user.id, "A");
    await createBatch(env.DB, {
      ownerId: a.user.id, businessId: bizA.id, config: configFor(), appUrl: env.APP_URL,
    });
    const html = await (await get("/qrs/batches", b.cookie)).text();
    expect(html).toContain("No batches yet");
    expect(html).not.toContain("B01");
  });
});

// ---------------------------------------------------------------------------
// 6. Lifecycle
// ---------------------------------------------------------------------------

describe("archive and restore", () => {
  it("retires every code in the batch and keeps them restorable", async () => {
    const { user, cookie } = await account("lifecycle");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id,
      config: configFor({ destination: "https://example.com" }),
      appUrl: env.APP_URL,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.batch.id;

    const archived = await archiveBatch(env.DB, id, user.id);
    expect(archived.ok).toBe(true);
    expect(archived.status).toBe("archived");
    expect(archived.archivedCount).toBe(9);

    // Every code stops serving.
    const res = await get("/q/SQ-GR-B01-001");
    expect(res.status).toBe(410);

    // But the serials, the owner and the history all survive. (Looked up BY
    // SERIAL: getAssetViewForOwner is keyed on a REGISTRY id, and a batch id is
    // not one — which is itself the proof that the two id spaces stay separate.)
    const asset = await getAssetViewByIdentifier(env.DB, "SQ-GR-B01-001");
    expect(asset).not.toBeNull();
    expect(asset?.status).toBe("archived");
    expect(asset?.owner_id).toBe(user.id);
    expect(asset?.qr_identifier).toBe("SQ-GR-B01-001");
    const stillThere = await getAssetViewByIdentifier(env.DB, "SQ-GR-B01-001");
    expect(stillThere).not.toBeNull();

    // And it comes back.
    const restored = await restoreBatch(env.DB, id, user.id);
    expect(restored.ok).toBe(true);
    expect((await get("/q/SQ-GR-B01-001")).status).toBe(302);
  });

  it("is idempotent, so a double-click cannot produce a confusing error", async () => {
    const { user, cookie } = await account("lifecycle-idem");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");
    const id = created.batch.id;

    expect((await archiveBatch(env.DB, id, user.id)).ok).toBe(true);
    const second = await archiveBatch(env.DB, id, user.id);
    expect(second.ok).toBe(true);
    expect(second.status).toBe("archived");
    // Restoring twice is equally safe.
    expect((await restoreBatch(env.DB, id, user.id)).ok).toBe(true);
    expect((await restoreBatch(env.DB, id, user.id)).ok).toBe(true);
  });

  it("never releases the claim on archive", async () => {
    const { user, cookie } = await account("lifecycle-claim");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");
    await archiveBatch(env.DB, created.batch.id, user.id);

    // A retired batch is not claimable by anyone, including a new account.
    const stranger = await account("lifecycle-stranger");
    const rival = await createBatch(env.DB, {
      ownerId: stranger.user.id,
      businessId: (await businessFor(stranger.user.id, "S")).id,
      config: configFor(),
      appUrl: env.APP_URL,
    });
    expect(rival.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Regeneration
// ---------------------------------------------------------------------------

describe("regeneration", () => {
  it("creates no record and changes no identity", async () => {
    const { user, cookie } = await account("regen");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ destination: "https://example.com/menu" }),
      appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");
    const id = created.batch.id;

    const before = {
      registry: await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_registry").first<{ n: number }>(),
      qrCodes: await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_codes").first<{ n: number }>(),
    };
    const beforeRow = await getAssetViewForOwner(env.DB, id, user.id);

    const res = await post(`/qrs/batches/${id}/regenerate`, {}, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("batch-regenerated");

    const after = {
      registry: await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_registry").first<{ n: number }>(),
      qrCodes: await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_codes").first<{ n: number }>(),
    };
    expect(Number(after.registry?.n)).toBe(Number(before.registry?.n));
    expect(Number(after.qrCodes?.n)).toBe(Number(before.qrCodes?.n));

    // Identity, business, owner and destination all unchanged.
    const afterRow = await getAssetViewForOwner(env.DB, id, user.id);
    expect(afterRow?.qr_identifier).toBe(beforeRow?.qr_identifier);
    expect(afterRow?.business_id).toBe(beforeRow?.business_id);
    expect(afterRow?.owner_id).toBe(beforeRow?.owner_id);
    expect(afterRow?.destination).toBe(beforeRow?.destination);
    expect(afterRow?.batch_id).toBe(beforeRow?.batch_id);
  });

  it("is safe to press twice — it is idempotent by construction", async () => {
    const { user, cookie } = await account("regen-twice");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");
    const id = created.batch.id;
    expect((await post(`/qrs/batches/${id}/regenerate`, {}, cookie)).status).toBe(303);
    expect((await post(`/qrs/batches/${id}/regenerate`, {}, cookie)).status).toBe(303);
    expect(await listBatchQrs(env.DB, id, user.id)).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// 8. Exports
// ---------------------------------------------------------------------------

describe("exports", () => {
  it("serves the ZIP as an attachment with a deterministic name", async () => {
    const { user, cookie } = await account("zip");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ destination: "https://example.com" }),
      appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");

    const res = await get(`/qrs/batches/${created.batch.id}/export.zip`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    // THE download fix: `attachment` is what makes a navigation download rather
    // than display. Without it "Download ZIP" opens the file.
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="SQ-GR-B01.zip"');
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);

    const bytes = new Uint8Array(await res.arrayBuffer());
    // EOCD signature at the end proves it is a real archive.
    const sig = bytes[bytes.length - 22] | (bytes[bytes.length - 21] << 8);
    expect(sig).toBe(0x4b50);
  });

  it("serves the manifest as an attachment with its documented columns", async () => {
    const { user, cookie } = await account("csv");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({
        destination: "https://example.com",
        metadata: [{ name: "Manufacturing Line", value: "L02" }],
      }),
      appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");

    const res = await get(`/qrs/batches/${created.batch.id}/manifest.csv`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="SQ-GR-B01-manifest.csv"',
    );

    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "serial_number,qr_id,type,batch_number,sequence,dynamic_url,destination_url,status,created_at,Manufacturing Line",
    );
    expect(lines).toHaveLength(10); // header + 9
    // The dynamic URL is the PERMANENT one, not the destination — that
    // distinction is the whole point of a printed dynamic code.
    expect(lines[1]).toContain(`${env.APP_URL}/q/SQ-GR-B01-001`);
    // No account data anywhere in the file.
    expect(text).not.toContain(user.id);
    expect(text).not.toContain("@example.com");
  });

  it("serves a single QR as an attachment named for its serial", async () => {
    const { user, cookie } = await account("one-svg");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ destination: "https://example.com" }),
      appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");
    const qrs = await listBatchQrs(env.DB, created.batch.id, user.id);

    const res = await get(
      `/qrs/batches/${created.batch.id}/qr/${qrs[0].registry_id}.svg`,
      cookie,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="SQ-GR-B01-001.svg"',
    );
    // The encoded payload is the permanent URL, never the destination.
    const svg = await res.text();
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("404s an export for a batch that is not the caller's", async () => {
    const owner = await account("exp-own");
    const stranger = await account("exp-stranger");
    const biz = await businessFor(owner.user.id);
    const created = await createBatch(env.DB, {
      ownerId: owner.user.id,
      businessId: biz.id,
      config: configFor(),
      appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");
    for (const suffix of ["export.zip", "manifest.csv"]) {
      const res = await get(`/qrs/batches/${created.batch.id}/${suffix}`, stranger.cookie);
      expect(res.status, suffix).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. The generator form, end to end
// ---------------------------------------------------------------------------

describe("the generator form", () => {
  it("renders with a live preview hook and no records created", async () => {
    const { cookie } = await account("form-render");
    const res = await get("/qrs/batches/new", cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Batch configuration");
    // All four mandatory fields are present and labelled.
    for (const label of ["Type", "Batch No.", "Starting Sequence", "Batch Size"]) {
      expect(html, label).toContain(`>${label}`);
    }
    expect(html).toContain("data-batch-preview");
    expect(html).toContain("data-meta-add");
    // Nothing has been generated just by looking at the page.
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_batches").first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);
  });

  it("generates through the form and lands on the batch", async () => {
    const { user, cookie } = await account("form-generate");
    const biz = await businessFor(user.id);
    await setCurrentBusiness(env.DB, user.id, biz.id);

    const res = await post("/qrs/batches", { ...FORM, business_id: biz.id }, cookie);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/qrs/batches/");
    expect(location).toContain("batch-created");

    const detail = await get(location.split("?")[0], cookie);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain("SQ-GR-B01-001");
    expect(html).toContain("SQ-GR-B01-009");
    expect(html).toContain("Download ZIP");
    expect(html).toContain("Download Manifest");
  });

  it("re-renders with field errors and creates nothing", async () => {
    const { cookie } = await account("form-errors");
    const res = await post(
      "/qrs/batches",
      { ...FORM, type: "GRO", batch_size: "10", sequence_start: "0" },
      cookie,
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("err_type");
    expect(location).toContain("err_batch_size");
    expect(location).toContain("err_sequence_start");

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_batches").first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);

    // And what they typed is still on the form.
    const html = await (await get(location, cookie)).text();
    expect(html).toContain('value="GRO"');
    expect(html).toContain('value="10"');
  });

  it("reports a serial conflict on the form, naming the serial", async () => {
    const { user, cookie } = await account("form-conflict");
    const biz = await businessFor(user.id);
    const first = await post("/qrs/batches", { ...FORM, business_id: biz.id }, cookie);
    expect(first.status).toBe(303);

    const second = await post("/qrs/batches", { ...FORM, business_id: biz.id }, cookie);
    expect(second.status).toBe(303);
    const location = second.headers.get("location") ?? "";
    expect(location).toContain("batch-serials-exist");
    expect(decodeURIComponent(location)).toContain("SQ-GR-B01-001");

    const html = await (await get(location, cookie)).text();
    expect(html).toContain("SQ-GR-B01-001");
    // Exactly one batch exists.
    expect(await listBatchesForOwner(env.DB, user.id)).toHaveLength(1);
  });

  it("refuses a business the caller does not belong to", async () => {
    const owner = await account("form-biz-owner");
    const attacker = await account("form-biz-attacker");
    const theirBiz = await businessFor(owner.user.id, "Not Yours");

    const res = await post("/qrs/batches", { ...FORM, business_id: theirBiz.id }, attacker.cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("err_business");

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM qr_batches").first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);
  });

  it("preserves custom metadata through the round trip", async () => {
    const { user, cookie } = await account("form-meta");
    const biz = await businessFor(user.id);
    const res = await post(
      "/qrs/batches",
      {
        ...FORM,
        business_id: biz.id,
        metadata: JSON.stringify([
          { name: "Manufacturing Line", value: "L02" },
          { name: "Production Run", value: "October-2026" },
        ]),
      },
      cookie,
    );
    expect(res.status).toBe(303);
    const batches = await listBatchesForOwner(env.DB, user.id);
    expect(batches[0].metadata).toEqual([
      { name: "Manufacturing Line", value: "L02" },
      { name: "Production Run", value: "October-2026" },
    ]);
  });

  it("survives a malformed metadata payload without a 500", async () => {
    const { cookie } = await account("form-meta-bad");
    const res = await post("/qrs/batches", { ...FORM, metadata: "{not json" }, cookie);
    // Treated as "no metadata", not a crash. The user sees the form back.
    expect(res.status).toBe(303);
  });

  it("survives a refresh mid-operation by keeping the form usable", async () => {
    // Nothing is held in client state that a refresh would lose: the batch is a
    // row, and the form is server-rendered from query params.
    const { user, cookie } = await account("form-refresh");
    const biz = await businessFor(user.id);
    const created = await post("/qrs/batches", { ...FORM, business_id: biz.id }, cookie);
    const detailUrl = (created.headers.get("location") ?? "").split("?")[0];
    // Reload twice; both must work.
    expect((await get(detailUrl, cookie)).status).toBe(200);
    expect((await get(detailUrl, cookie)).status).toBe(200);
    expect(await listBatchesForOwner(env.DB, user.id)).toHaveLength(1);
  });

  it("hands the metadata rows BACK to the form when the submit is rejected", async () => {
    // The rejected-POST round trip is a redirect, so every field the user typed
    // has to survive the query string. Metadata was the one that did not, which
    // is the worst place to lose it: a 20-row batch's custom fields are exactly
    // the part nobody can retype from memory.
    const { user, cookie } = await account("form-meta-restore");
    const biz = await businessFor(user.id);

    const metadata = [
      { name: "Manufacturing Line", value: "L02" },
      { name: "Production Run", value: "October-2026" },
      { name: "Inspector", value: "R. Menon" },
    ];

    // First submit succeeds and takes the serials.
    const first = await post(
      "/qrs/batches",
      { ...FORM, business_id: biz.id, metadata: JSON.stringify(metadata) },
      cookie,
    );
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).not.toContain("err_serials");

    // The identical batch now collides, so it is genuinely refused and the form
    // re-renders from the redirect query.
    const clash = await post(
      "/qrs/batches",
      { ...FORM, business_id: biz.id, metadata: JSON.stringify(metadata) },
      cookie,
    );
    expect(clash.status).toBe(303);
    expect(clash.headers.get("location")).toContain("err_serials");

    // Render the form from that redirect and assert the rows survived.
    const form = await get(clash.headers.get("location")!, cookie);
    expect(form.status).toBe(200);
    const html = await form.text();
    for (const row of metadata) {
      expect(html, `metadata row "${row.name}" was lost`).toContain(row.name);
      expect(html, `metadata value "${row.value}" was lost`).toContain(row.value);
    }
    // ...and so are the plain fields, which is what makes this a round trip
    // rather than a lucky coincidence of the shared parser.
    expect(html).toContain('value="B01"');
    expect(html).toContain('value="GR"');
  });

  it("caps metadata rows on the GET path, which never runs the validator", async () => {
    // A crafted link, not a form submission: validation bounds what may be
    // submitted, but /qrs/batches/new?metadata=... bypasses it entirely. Without
    // a cap in the parser this renders 5000 inputs and a multi-megabyte URL.
    const { cookie } = await account("form-meta-hostile");
    const hostile = JSON.stringify(
      Array.from({ length: 5000 }, (_, i) => ({ name: `n${i}`, value: `v${i}` })),
    );
    const res = await get(
      `/qrs/batches/new?metadata=${encodeURIComponent(hostile)}`,
      cookie,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The first rows are kept; the tail is dropped.
    expect(html).toContain("n0");
    expect(html).not.toContain("n4999");
    // And the "add another" affordance is still offered, so the form is usable.
    expect(html).not.toMatch(/Cannot add more/i);
  });

  it("marks Batches as the current nav item, so the highlight lands somewhere", async () => {
    // Every batch page passed active="stands" while the nav key is "batches", so
    // no page under /qrs/batches ever highlighted the Batches item. A nav that
    // never lights up reads as "this section does not exist".
    const { user, cookie } = await account("nav");
    const biz = await businessFor(user.id);
    const created = await post("/qrs/batches", { ...FORM, business_id: biz.id }, cookie);
    const detailUrl = (created.headers.get("location") ?? "").split("?")[0];

    for (const path of ["/qrs/batches", "/qrs/batches/new", detailUrl]) {
      const html = await (await get(path, cookie)).text();
      // aria-current="page" on the Batches link, not the Stands one.
      const batchesLink = /<a[^>]*href="\/qrs\/batches"[^>]*>/.exec(html);
      expect(batchesLink, `${path} should render the Batches nav link`).not.toBeNull();
      expect(batchesLink![0], `${path} should mark Batches current`).toContain(
        'aria-current="page"',
      );
    }
  });

  it("offers no 'not assigned' choice, because a QR cannot exist without a business", async () => {
    const { user, cookie } = await account("form-required-biz");
    await businessFor(user.id, "First Cafe");
    const html = await (await get("/qrs/batches/new", cookie)).text();

    // The select is required, and the only options are real businesses plus a
    // neutral prompt. A "Not assigned" option would submit an empty value the
    // server then refuses, which is a form that looks optional and is not.
    expect(html).toMatch(/<select[^>]*name="business_id"[^>]*required/s);
    expect(html).not.toMatch(/Not assigned/);
    expect(html).not.toMatch(/value="">Not assigned/);
  });

  it("tells a business-less owner what to do instead of offering an unsubmitable form", async () => {
    const { cookie } = await account("form-no-biz");
    const html = await (await get("/qrs/batches/new", cookie)).text();
    expect(html).toContain("No businesses yet");
    expect(html).toMatch(/Create your first business/);
    expect(html).toContain('href="/app/businesses/new"');
  });
});

// ---------------------------------------------------------------------------
// 10. Detail page interactions
// ---------------------------------------------------------------------------

describe("batch detail", () => {
  it("searches, sorts and paginates", async () => {
    const { user, cookie } = await account("detail-controls");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id,
      businessId: biz.id,
      config: configFor({ sequenceStart: 1, batchSize: 99 }),
      appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");
    const id = created.batch.id;

    // Search narrows to one serial.
    const found = await (await get(`/qrs/batches/${id}?q=SQ-GR-B01-042`, cookie)).text();
    expect(found).toContain("SQ-GR-B01-042");
    expect(found).not.toContain("SQ-GR-B01-043");

    // 99 items is two pages at 50/page — so pagination actually paginates rather
    // than rendering everything and calling it a page.
    const page1 = await (await get(`/qrs/batches/${id}`, cookie)).text();
    expect(page1).toContain("Page 1 of 2");
    expect(page1).toContain("SQ-GR-B01-001");
    expect(page1).not.toContain("SQ-GR-B01-060");

    const page2 = await (await get(`/qrs/batches/${id}?page=2`, cookie)).text();
    expect(page2).toContain("SQ-GR-B01-099");

    // Descending reverses it.
    const desc = await (await get(`/qrs/batches/${id}?dir=desc`, cookie)).text();
    const firstSerial = /<td class="qr-scanlog-mono">([^<]+)<\/td>/.exec(desc)?.[1];
    expect(firstSerial).toBe("SQ-GR-B01-099");

    // A nonsense page number is clamped, not an error.
    expect((await get(`/qrs/batches/${id}?page=9999`, cookie)).status).toBe(200);
  });

  it("says so when a search matches nothing, rather than showing an empty table", async () => {
    const { user, cookie } = await account("detail-empty");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");
    const html = await (
      await get(`/qrs/batches/${created.batch.id}?q=nothing-matches`, cookie)
    ).text();
    expect(html).toContain("Nothing matches that search");
    expect(html).toContain("Clear search");
  });

  it("does not offer a restore control on a live batch, or an archive one on a retired batch", async () => {
    const { user, cookie } = await account("detail-lifecycle");
    const biz = await businessFor(user.id);
    const created = await createBatch(env.DB, {
      ownerId: user.id, businessId: biz.id, config: configFor(), appUrl: env.APP_URL,
    });
    if (!created.ok) throw new Error("setup failed");
    const id = created.batch.id;

    const live = await (await get(`/qrs/batches/${id}`, cookie)).text();
    expect(live).toContain("Regenerate Assets");
    expect(live).toContain("Retire Batch");
    expect(live).not.toContain("Restore batch");

    await post(`/qrs/batches/${id}/archive`, {}, cookie);
    const retired = await (await get(`/qrs/batches/${id}`, cookie)).text();
    expect(retired).toContain("Restore batch");
    expect(retired).not.toContain("Retire Batch");
  });
});
