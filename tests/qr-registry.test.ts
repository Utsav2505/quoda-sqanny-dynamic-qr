// Foundation tests for the physical-asset registry and the single claim service.
//
// These cover the data model and the ownership guarantees BEFORE any UI exists,
// because the UI is only a presentation of what these assertions pin down. The
// scenarios the spec numbers 4, 5, 6, 14, 15, 20, 21 and 22 all reduce to a
// statement about the service or the SQL.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  archiveAsset,
  claimAsset,
  countAssetsForOwner,
  getAssetViewByIdentifier,
  getAssetViewForOwner,
  insertRegistrationQr,
  listAssetsForOwner,
  registerAsset,
  registerAssets,
  restoreAsset,
  updateAssetConfig,
} from "../src/db/qr-registry";
import {
  claimQr,
  resolveAsset,
  resolveQrPayload,
  validateClaimInput,
} from "../src/lib/claim";
import {
  generateIdentifier,
  isIdentifier,
  normalizeIdentifier,
  resolveCategory,
  serialFromPayload,
  validateDestination,
} from "../src/lib/qr-registration";
import { createBusiness, createUser } from "../src/db/queries";
import { ensureUniqueShortCode } from "../src/lib/shortcode";

const BUSINESS = {
  name: "Analytical Engines",
  category: "cafe",
  address: "12 Connaught Place",
  city: "New Delhi",
  state: "Delhi",
  country: "India",
} as const;

async function seedUser(tag: string) {
  return createUser(env.DB, `${tag}-${crypto.randomUUID()}@example.com`);
}

async function seedBusiness(userId: string, over: Record<string, unknown> = {}) {
  return createBusiness(env.DB, userId, { ...BUSINESS, ...over } as never);
}

/** Register a fresh, unclaimed stand and return its serial. */
async function freshStand(): Promise<string> {
  const serial = generateIdentifier();
  await registerAsset(env.DB, serial);
  return serial;
}

const CLAIM = {
  name: "Counter",
  category: "reviews",
  placement: "Cash Desk",
  destination: "https://maps.google.com?cid=1",
};

describe("printed serial format", () => {
  it("generates identifiers that all pass validation", () => {
    for (let i = 0; i < 200; i++) {
      const serial = generateIdentifier();
      expect(serial).toMatch(/^SQ-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
      expect(isIdentifier(serial)).toBe(true);
    }
  });

  it("excludes glyphs that are ambiguous when read aloud or retyped", () => {
    // 0/O, 1/I/L and U are the ones people get wrong off a sticker.
    for (let i = 0; i < 500; i++) {
      const serial = generateIdentifier();
      expect(serial).not.toMatch(/[01ILOU]/);
    }
  });

  it("canonicalises case and rejects malformed serials", () => {
    expect(normalizeIdentifier("sq-8f2k9a")).toBe("SQ-8F2K9A");
    expect(normalizeIdentifier("  sq-8f2k9a  ")).toBe("SQ-8F2K9A");
    // Right shape, but 0 and I are not in the alphabet, so this is not a serial
    // we ever manufacture - reject rather than guess.
    expect(normalizeIdentifier("SQ-000000")).toBeNull();
    expect(normalizeIdentifier("SQ-23456")).toBeNull();
    expect(normalizeIdentifier("XX-8F2K9A")).toBeNull();
    expect(normalizeIdentifier(null)).toBeNull();
    expect(normalizeIdentifier(12345)).toBeNull();
  });
});

describe("resolveQrPayload", () => {
  it("accepts a bare serial in any case", () => {
    expect(resolveQrPayload("SQ-8F2K9A")).toBe("SQ-8F2K9A");
    expect(resolveQrPayload("sq-8f2k9a")).toBe("SQ-8F2K9A");
  });

  it("accepts the stand's own URL as a camera returns it", () => {
    expect(resolveQrPayload("https://sqanny.chetnaverse.com/q/SQ-8F2K9A")).toBe("SQ-8F2K9A");
    expect(resolveQrPayload("https://sqanny.chetnaverse.com/q/?qr=SQ-8F2K9A")).toBe("SQ-8F2K9A");
    expect(resolveQrPayload("/q/SQ-8F2K9A")).toBe("SQ-8F2K9A");
  });

  it("refuses anything that is not a Sqanny serial", () => {
    // Some other product's QR, a URL that happens to contain text, junk.
    expect(resolveQrPayload("https://example.com/menu")).toBeNull();
    expect(resolveQrPayload("WIFI:T:WPA;S:x;;")).toBeNull();
    expect(resolveQrPayload("hello world")).toBeNull();
    expect(resolveQrPayload("")).toBeNull();
    expect(resolveQrPayload(undefined)).toBeNull();
  });

  it("is the same function the camera island uses, so the two cannot drift", async () => {
    // The camera pre-filters decoded frames with this to avoid a pointless
    // submit, and the server re-validates with it before any lookup. If those
    // were separate copies they would eventually disagree, and the scanner
    // would either submit junk or silently drop a valid stand. Importing the
    // island is safe because it guards its own document access.
    const scanner = await import("../src/client/scanner");
    expect(scanner.serialFrom).toBe(serialFromPayload);
  });

  it("keeps the server's entry point in step with the shared decoder", () => {
    // resolveQrPayload is a thin wrapper, so it is a different function object
    // by design. What must hold is that it never disagrees with the decoder the
    // camera runs — this is the assertion that catches a wrapper quietly
    // growing its own special cases.
    const payloads = [
      "SQ-8F2K9A",
      "sq-8f2k9a",
      "  SQ-8F2K9A  ",
      "https://sqanny.chetnaverse.com/q/SQ-8F2K9A",
      "https://sqanny.chetnaverse.com/q/?qr=SQ-8F2K9A",
      "/q/SQ-8F2K9A",
      "https://example.com/menu",
      "WIFI:T:WPA;S:x;;",
      "SQ-8F2K9I",
      "",
    ];
    for (const p of payloads) {
      expect(resolveQrPayload(p)).toBe(serialFromPayload(p));
    }
  });

  it("behaves identically for a decoded frame and for a typed serial", () => {
    // A stand may be printed with the bare serial or with its own URL. Both
    // paths must land on the same canonical serial.
    expect(serialFromPayload("SQ-8F2K9A")).toBe("SQ-8F2K9A");
    expect(serialFromPayload("  sq-8f2k9a  ")).toBe("SQ-8F2K9A");
    expect(serialFromPayload("https://sqanny.chetnaverse.com/q/SQ-8F2K9A")).toBe("SQ-8F2K9A");
    expect(serialFromPayload("sqanny.chetnaverse.com/q/SQ-8F2K9A")).toBeNull();
  });

  it("rejects a serial containing a glyph we never print", () => {
    // I, O, 0 and 1 are excluded from generated serials as unreadable, so a
    // code carrying one is either mistyped or from another system.
    for (const bad of ["SQ-8F2K9I", "SQ-8F2K9O", "SQ-8F2K90", "SQ-8F2K91"]) {
      expect(serialFromPayload(bad)).toBeNull();
    }
  });

  it("rejects an overlong payload instead of parsing it", () => {
    expect(serialFromPayload("https://example.com/" + "a".repeat(600))).toBeNull();
  });
});

describe("asset resolution (section 6, 7, 8)", () => {
  it("reports a registered, unowned stand as claimable", async () => {
    const serial = await freshStand();
    const res = await resolveAsset(env.DB, serial, null);
    expect(res.state).toBe("claimable");
  });

  it("reports an unregistered serial without leaking that fact beyond 'unknown'", async () => {
    const res = await resolveAsset(env.DB, "SQ-234567", null);
    expect(res.state).toBe("unregistered");
  });

  it("reports a non-Sqanny payload as not-a-sqanny-qr", async () => {
    const res = await resolveAsset(env.DB, "not-a-serial", null);
    expect(res.state).toBe("not-a-sqanny-qr");
  });

  it("never discloses who owns a claimed stand - to anyone but the owner", async () => {
    const owner = await seedUser("own");
    const stranger = await seedUser("str");
    const biz = await seedBusiness(owner.id);
    const serial = await freshStand();
    const claimed = await claimQr(env.DB, {
      identifier: serial,
      viewerId: owner.id,
      businessId: biz.id,
      ...CLAIM,
    });
    expect(claimed.ok).toBe(true);

    // Another signed-in user learns only that it is taken.
    const asStranger = await resolveAsset(env.DB, serial, stranger.id);
    expect(asStranger.state).toBe("taken");
    expect(JSON.stringify(asStranger)).not.toContain(owner.email);
    expect(JSON.stringify(asStranger)).not.toContain(owner.id);

    // An anonymous visitor gets the identical answer, so the public cannot use
    // the response to probe which serials are registered at all.
    const asAnon = await resolveAsset(env.DB, serial, null);
    expect(asAnon.state).toBe("taken");
    expect(asAnon).toEqual({ state: "taken", identifier: serial });
  });

  it("tells the owner it is theirs, and whether it still needs configuring", async () => {
    const owner = await seedUser("own");
    const biz = await seedBusiness(owner.id);
    const serial = await freshStand();
    await claimQr(env.DB, { identifier: serial, viewerId: owner.id, businessId: biz.id, ...CLAIM });

    const res = await resolveAsset(env.DB, serial, owner.id);
    expect(res.state).toBe("yours");
    if (res.state !== "yours") throw new Error("unreachable");
    expect(res.configured).toBe(true);
    expect(res.asset.business_name).toBe("Analytical Engines");
    expect(res.asset.name).toBe("Counter");
    expect(res.asset.status).toBe("active");
  });
});

describe("claiming (sections 9, 14, 15, 18)", () => {
  it("claims an unclaimed stand and activates it", async () => {
    const user = await seedUser("claim");
    const biz = await seedBusiness(user.id);
    const serial = await freshStand();

    const res = await claimQr(env.DB, {
      identifier: serial,
      viewerId: user.id,
      businessId: biz.id,
      ...CLAIM,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    expect(res.asset.qr_identifier).toBe(serial);
    expect(res.asset.owner_id).toBe(user.id);
    expect(res.asset.business_id).toBe(biz.id);
    expect(res.asset.status).toBe("active");
    expect(res.asset.claimed_at).toBeTypeOf("number");
    expect(res.asset.destination).toBe(CLAIM.destination);
    // The serial is the identity; the destination is only configuration.
    expect(res.asset.qr_identifier).not.toBe(res.asset.destination);
  });

  it("refuses a stand owned by another account, and leaves no trace", async () => {
    const owner = await seedUser("first");
    const rival = await seedUser("second");
    const ownerBiz = await seedBusiness(owner.id);
    const serial = await freshStand();

    await claimQr(env.DB, { identifier: serial, viewerId: owner.id, businessId: ownerBiz.id, ...CLAIM });

    const qrCountBefore = await countAssetsForOwner(env.DB, rival.id);
    const res = await claimQr(env.DB, {
      identifier: serial,
      viewerId: rival.id,
      businessId: ownerBiz.id,
      ...CLAIM,
    });
    expect(res).toEqual({ ok: false, reason: "already-claimed" });
    // The loser created no business, no QR, and gained no asset.
    expect(await countAssetsForOwner(env.DB, rival.id)).toEqual(qrCountBefore);
  });

  it("keeps identity stable when the destination changes (section 15)", async () => {
    const user = await seedUser("stable");
    const biz = await seedBusiness(user.id);
    const serial = await freshStand();
    const first = await claimQr(env.DB, { identifier: serial, viewerId: user.id, businessId: biz.id, ...CLAIM });
    if (!first.ok) throw new Error("unreachable");

    const updated = await updateAssetConfig(env.DB, {
      registryId: first.asset.id,
      ownerId: user.id,
      name: "Counter",
      category: "reviews",
      customCategory: null,
      placement: "Cash Desk",
      destination: "https://example.com/new-menu",
      businessId: biz.id,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("unreachable");

    // Same stand, same serial, new destination.
    expect(updated.asset.id).toBe(first.asset.id);
    expect(updated.asset.qr_identifier).toBe(serial);
    expect(updated.asset.destination).toBe("https://example.com/new-menu");
  });

  it("rejects a business the caller does not belong to (section 28)", async () => {
    const victim = await seedUser("victim");
    const attacker = await seedUser("atk");
    const victimBiz = await seedBusiness(victim.id);
    const serial = await freshStand();

    const res = await claimQr(env.DB, {
      identifier: serial,
      viewerId: attacker.id,
      businessId: victimBiz.id,
      ...CLAIM,
    });
    expect(res).toEqual({ ok: false, reason: "business-forbidden" });

    // And the stand is still free, i.e. the attempt changed nothing.
    const after = await resolveAsset(env.DB, serial, attacker.id);
    expect(after.state).toBe("claimable");
  });
});

describe("concurrency (section 18: two users, one stand)", () => {
  it("lets exactly one of two simultaneous claims win", async () => {
    const a = await seedUser("race-a");
    const b = await seedUser("race-b");
    const bizA = await seedBusiness(a.id);
    const bizB = await seedBusiness(b.id);
    const serial = await freshStand();

    // Both race the same compare-and-swap. Fired together, not awaited in
    // sequence, so the loser is decided by the database and not by scheduling.
    const [ra, rb] = await Promise.all([
      claimQr(env.DB, { identifier: serial, viewerId: a.id, businessId: bizA.id, ...CLAIM }),
      claimQr(env.DB, { identifier: serial, viewerId: b.id, businessId: bizB.id, ...CLAIM }),
    ]);

    const winners = [ra, rb].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const loser = [ra, rb].find((r) => !r.ok)!;
    expect(loser).toEqual({ ok: false, reason: "already-claimed" });

    // The loser left no orphan configuration row behind.
    const orphans = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM qr_codes WHERE source = 'registration' AND business_id = ?",
    )
      .bind(loser.ok ? "" : bizB.id)
      .first<{ n: number }>();
    expect(orphans?.n).toBe(0);

    // The winner is the sole owner, and there is exactly one asset for the serial.
    const all = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM qr_registry WHERE qr_identifier = ?",
    )
      .bind(serial)
      .first<{ n: number }>();
    expect(all?.n).toBe(1);
  });
});

describe("archive (sections 20, 27)", () => {
  it("keeps the record, owner and business, and blocks re-claiming", async () => {
    const owner = await seedUser("arch");
    const rival = await seedUser("rival");
    const rivalBiz = await seedBusiness(rival.id);
    const biz = await seedBusiness(owner.id);
    const serial = await freshStand();
    const claimed = await claimQr(env.DB, { identifier: serial, viewerId: owner.id, businessId: biz.id, ...CLAIM });
    if (!claimed.ok) throw new Error("unreachable");

    const res = await archiveAsset(env.DB, claimed.asset.id, owner.id);
    expect(res).toEqual({ ok: true, status: "archived" });

    // The row and its history survive.
    const still = await getAssetViewForOwner(env.DB, claimed.asset.id, owner.id);
    expect(still?.status).toBe("archived");
    expect(still?.owner_id).toBe(owner.id);
    expect(still?.business_id).toBe(biz.id);
    expect(still?.destination).toBe(CLAIM.destination);
    expect(still?.scan_count).toBe(0);

    // Neither the original owner nor anyone else can re-claim it.
    const forRival = await resolveAsset(env.DB, serial, rival.id);
    expect(forRival.state).toBe("archived");
    const reClaim = await claimQr(env.DB, {
      identifier: serial,
      viewerId: rival.id,
      businessId: rivalBiz.id,
      ...CLAIM,
    });
    expect(reClaim).toEqual({ ok: false, reason: "archived" });
  });

  it("restores an archived stand to active, keeping the same identity", async () => {
    const owner = await seedUser("restore");
    const biz = await seedBusiness(owner.id);
    const serial = await freshStand();
    const claimed = await claimQr(env.DB, { identifier: serial, viewerId: owner.id, businessId: biz.id, ...CLAIM });
    if (!claimed.ok) throw new Error("unreachable");
    await archiveAsset(env.DB, claimed.asset.id, owner.id);

    const res = await restoreAsset(env.DB, claimed.asset.id, owner.id);
    expect(res.ok).toBe(true);

    const after = await resolveAsset(env.DB, serial, owner.id);
    if (after.state !== "yours") throw new Error("unreachable");
    expect(after.asset.qr_identifier).toBe(serial);
    expect(after.asset.status).toBe("active");
  });

  it("cannot archive somebody else's stand", async () => {
    const owner = await seedUser("o2");
    const attacker = await seedUser("a2");
    const biz = await seedBusiness(owner.id);
    const serial = await freshStand();
    const claimed = await claimQr(env.DB, { identifier: serial, viewerId: owner.id, businessId: biz.id, ...CLAIM });
    if (!claimed.ok) throw new Error("unreachable");

    const res = await archiveAsset(env.DB, claimed.asset.id, attacker.id);
    expect(res.ok).toBe(false);
    const still = await getAssetViewForOwner(env.DB, claimed.asset.id, owner.id);
    expect(still?.status).toBe("active");
  });
});

describe("cross-tenant access (scenario 15, 16)", () => {
  it("returns nothing when a stranger reads the asset by id", async () => {
    const owner = await seedUser("v");
    const stranger = await seedUser("s");
    const biz = await seedBusiness(owner.id);
    const serial = await freshStand();
    const claimed = await claimQr(env.DB, { identifier: serial, viewerId: owner.id, businessId: biz.id, ...CLAIM });
    if (!claimed.ok) throw new Error("unreachable");

    // null, not 403: the response must not confirm the row exists.
    expect(await getAssetViewForOwner(env.DB, claimed.asset.id, stranger.id)).toBeNull();
    expect(await getAssetViewForOwner(env.DB, claimed.asset.id, owner.id)).not.toBeNull();
  });

  it("ignores a stranger's attempt to edit the configuration", async () => {
    const owner = await seedUser("v2");
    const stranger = await seedUser("s2");
    const biz = await seedBusiness(owner.id);
    const serial = await freshStand();
    const claimed = await claimQr(env.DB, { identifier: serial, viewerId: owner.id, businessId: biz.id, ...CLAIM });
    if (!claimed.ok) throw new Error("unreachable");

    const res = await updateAssetConfig(env.DB, {
      registryId: claimed.asset.id,
      ownerId: stranger.id,
      name: "Hijacked",
      category: "menu",
      customCategory: null,
      placement: null,
      destination: "https://evil.example.com",
      businessId: biz.id,
    });
    expect(res).toEqual({ ok: false, reason: "not-found" });

    const still = await getAssetViewByIdentifier(env.DB, serial);
    expect(still?.name).toBe("Counter");
    expect(still?.destination).toBe(CLAIM.destination);
  });
});

describe("validation (section 14)", () => {
  it("normalises a bare domain to https and rejects junk", () => {
    expect(validateDestination("google.com")).toEqual({
      url: "https://google.com",
      error: null,
    });
    expect(validateDestination("")).toEqual({ url: null, error: "Enter a destination URL." });
    expect(validateDestination("not a url").error).toBe("Enter a valid URL.");
    // javascript: would turn a redirect into script injection on our own origin.
    expect(validateDestination("javascript:alert(1)").error).toBe("Enter a valid URL.");
    expect(validateDestination("data:text/html,<h1>x").error).toBe("Enter a valid URL.");
  });

  it("requires a name, a category and a destination", () => {
    const { clean, errors } = validateClaimInput({
      identifier: "SQ-8F2K9A",
      businessId: "b",
      name: "",
      category: "",
      destination: "",
    });
    expect(clean).toBeNull();
    expect(errors.name).toBeTruthy();
    expect(errors.category).toBeTruthy();
    expect(errors.destination).toBeTruthy();
  });

  it("requires free text for the custom category and ignores it otherwise", () => {
    expect(resolveCategory("custom", "").error).toBeTruthy();
    expect(resolveCategory("custom", "Wayfinding").customCategory).toBe("Wayfinding");
    // A tampered hidden field must not attach text to a controlled key.
    expect(resolveCategory("reviews", "Wayfinding")).toEqual({
      category: "reviews",
      customCategory: null,
      error: null,
    });
    expect(resolveCategory("nonsense", "x").error).toBeTruthy();
  });
});

describe("management listing (section 24)", () => {
  it("filters by status, business and search, and only ever the caller's own", async () => {
    const user = await seedUser("list");
    const other = await seedUser("other");
    const bizA = await seedBusiness(user.id, { name: "Cafe One" });
    const bizB = await seedBusiness(user.id, { name: "Cafe Two" });
    const otherBiz = await seedBusiness(other.id);

    const s1 = await freshStand();
    const s2 = await freshStand();
    const s3 = await freshStand();
    const s4 = await freshStand();
    await claimQr(env.DB, { identifier: s1, viewerId: user.id, businessId: bizA.id, ...CLAIM });
    const c2 = await claimQr(env.DB, {
      identifier: s2, viewerId: user.id, businessId: bizB.id,
      ...CLAIM, name: "Table 01", category: "menu", placement: "Table 01",
    });
    const c3 = await claimQr(env.DB, { identifier: s3, viewerId: user.id, businessId: bizA.id, ...CLAIM });
    await claimQr(env.DB, { identifier: s4, viewerId: other.id, businessId: otherBiz.id, ...CLAIM });
    if (!c2.ok || !c3.ok) throw new Error("unreachable");
    await archiveAsset(env.DB, c3.asset.id, user.id);

    const all = await listAssetsForOwner(env.DB, user.id);
    expect(all.map((a) => a.qr_identifier).sort()).toEqual([s1, s2, s3].sort());

    expect((await listAssetsForOwner(env.DB, user.id, { status: "active" })).map((a) => a.qr_identifier).sort()).toEqual([s1, s2].sort());
    expect((await listAssetsForOwner(env.DB, user.id, { status: "archived" })).map((a) => a.qr_identifier)).toEqual([s3]);
    expect((await listAssetsForOwner(env.DB, user.id, { businessId: bizB.id })).map((a) => a.qr_identifier)).toEqual([s2]);

    // Search matches the human name or the serial.
    expect((await listAssetsForOwner(env.DB, user.id, { search: "table 01" })).map((a) => a.qr_identifier)).toEqual([s2]);
    expect((await listAssetsForOwner(env.DB, user.id, { search: s1.toLowerCase() })).map((a) => a.qr_identifier)).toEqual([s1]);
  });
});

describe("registration invariants", () => {
  it("refuses to store a half-claimed asset", async () => {
    // The CHECK constraint is the last line of defence: even a buggy caller
    // that skipped the CAS cannot leave an owner with no business.
    await expect(
      env.DB.prepare(
        `INSERT INTO qr_registry (id, qr_identifier, status, owner_id, claimed_at, created_at, updated_at)
         VALUES (?, ?, 'claimed', ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), generateIdentifier(), "some-user", Date.now(), Date.now(), Date.now())
        .run(),
    ).rejects.toThrow();
  });

  it("keeps qr_identifier unique, so a serial cannot be registered twice", async () => {
    const serial = await freshStand();
    await expect(registerAsset(env.DB, serial)).rejects.toThrow();
  });

  it("seeds a batch of stands in one go", async () => {
    const serials = [generateIdentifier(), generateIdentifier(), generateIdentifier()];
    expect(await registerAssets(env.DB, serials)).toBe(3);
    for (const s of serials) {
      expect((await resolveAsset(env.DB, s, null)).state).toBe("claimable");
    }
  });
});
