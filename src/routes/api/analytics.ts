import { Hono } from "hono";
import type { AppEnv } from "../../middleware/auth";
import { requireApiAuth } from "../../middleware/auth";
import { getQrById } from "../../db/queries";
import {
  countScansForQrs,
  getDaily,
  getBreakdown,
  getUniques,
  getScans,
} from "../../lib/analytics";

export const analyticsApi = new Hono<AppEnv>();
analyticsApi.use("/api/qr/*", requireApiAuth);

// GET /api/qr/:id/analytics -> { ok, total, daily, breakdown, uniques }
// (ownership enforced).
analyticsApi.get("/api/qr/:id/analytics", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const qr = await getQrById(c.env.DB, id);
  if (!qr || qr.user_id !== user.id) {
    return c.json({ ok: false, error: "Not found." }, 404);
  }

  const daysParam = Number(c.req.query("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 365) : 30;

  try {
    const [total, daily, breakdown, uniques] = await Promise.all([
      // D1, not the KV counter. The charts island renders this into the same
      // "Total scans" tile the server-rendered page shows, so the two must come
      // from one system of record or the tile changes value when the island
      // hydrates.
      countScansForQrs(c.env.DB, [id]).then((m) => m.get(id) ?? 0),
      getDaily(c.env, id, days),
      getBreakdown(c.env, id),
      getUniques(c.env, id, days),
    ]);

    return c.json({ ok: true, total, daily, breakdown, uniques });
  } catch (err) {
    console.error(err);
    return c.json({ ok: false, error: "Could not load analytics." }, 500);
  }
});

/**
 * GET /api/qr/:id/scans?limit=&offset= -> individual scan rows, newest first.
 *
 * Separate from the aggregate endpoint because it is a different shape and a
 * different access pattern: this one grows with traffic and is paginated.
 * `getScans` clamps the limit, so the query string cannot request the table.
 */
analyticsApi.get("/api/qr/:id/scans", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const qr = await getQrById(c.env.DB, id);
  if (!qr || qr.user_id !== user.id) {
    return c.json({ ok: false, error: "Not found." }, 404);
  }

  const limit = Number(c.req.query("limit"));
  const offset = Number(c.req.query("offset"));

  try {
    const scans = await getScans(
      c.env,
      id,
      Number.isFinite(limit) && limit > 0 ? limit : 50,
      Number.isFinite(offset) && offset > 0 ? offset : 0,
    );
    return c.json({ ok: true, scans });
  } catch (err) {
    console.error(err);
    return c.json({ ok: false, error: "Could not load scans." }, 500);
  }
});
