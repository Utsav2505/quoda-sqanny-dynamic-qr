import { Hono } from "hono";
import { requireAdmin } from "../../../middleware/auth";
import type { AppEnv } from "../../../middleware/auth";
import {
  createSku,
  getSkuById,
  getSkuByCode,
  listSkus,
  updateSku,
  deactivateSku,
  createAuditLog,
} from "../../../db/queries";

export const skuApi = new Hono<AppEnv>();

// List all SKUs
skuApi.get("/api/admin/skus", requireAdmin, async (c) => {
  const skus = await listSkus(c.env.DB);
  return c.json({ ok: true, data: skus });
});

// Create SKU
skuApi.post("/api/admin/skus", requireAdmin, async (c) => {
  const body = await c.req.json<{ code?: string; name?: string; description?: string }>();
  const { code, name, description } = body;

  const errors: Record<string, string> = {};
  if (!code || code.trim().length === 0) errors.code = "Required";
  if (code && code.length > 20) errors.code = "Max 20 characters";
  if (code && !/^[A-Za-z0-9\-]+$/.test(code)) errors.code = "Alphanumeric and hyphens only";
  if (!name || name.trim().length === 0) errors.name = "Required";
  if (name && name.length > 100) errors.name = "Max 100 characters";

  if (Object.keys(errors).length > 0) {
    return c.json({ ok: false, errors }, 400);
  }

  const existing = await getSkuByCode(c.env.DB, code!);
  if (existing) {
    return c.json({ ok: false, errors: { code: "Code already exists" } }, 409);
  }

  const sku = await createSku(c.env.DB, {
    code: code!.trim(),
    name: name!.trim(),
    description: description?.trim() || null,
  });

  await createAuditLog(c.env.DB, {
    actor_id: c.get("user")!.id,
    action: "sku.create",
    entity_type: "sku",
    entity_id: sku.id,
    details_json: JSON.stringify({ code: sku.code, name: sku.name }),
    ip_address: c.req.header("cf-connecting-ip"),
  });

  return c.json({ ok: true, data: sku }, 201);
});

// Get SKU by ID
skuApi.get("/api/admin/skus/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const sku = await getSkuById(c.env.DB, id);
  if (!sku) return c.json({ ok: false, error: "SKU not found" }, 404);
  return c.json({ ok: true, data: sku });
});

// Update SKU
skuApi.patch("/api/admin/skus/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const existing = await getSkuById(c.env.DB, id);
  if (!existing) return c.json({ ok: false, error: "SKU not found" }, 404);

  const body = await c.req.json<{ name?: string; description?: string }>();
  const patch: { name?: string; description?: string } = {};

  if (body.name !== undefined) {
    if (body.name.trim().length === 0) return c.json({ ok: false, errors: { name: "Required" } }, 400);
    if (body.name.length > 100) return c.json({ ok: false, errors: { name: "Max 100 characters" } }, 400);
    patch.name = body.name.trim();
  }
  if (body.description !== undefined) {
    patch.description = body.description?.trim() || null;
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ ok: false, error: "No fields to update" }, 400);
  }

  await updateSku(c.env.DB, id, patch);

  await createAuditLog(c.env.DB, {
    actor_id: c.get("user")!.id,
    action: "sku.update",
    entity_type: "sku",
    entity_id: id,
    details_json: JSON.stringify(patch),
    ip_address: c.req.header("cf-connecting-ip"),
  });

  const updated = await getSkuById(c.env.DB, id);
  return c.json({ ok: true, data: updated });
});

// Deactivate SKU (soft delete)
skuApi.delete("/api/admin/skus/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const existing = await getSkuById(c.env.DB, id);
  if (!existing) return c.json({ ok: false, error: "SKU not found" }, 404);

  await deactivateSku(c.env.DB, id);

  await createAuditLog(c.env.DB, {
    actor_id: c.get("user")!.id,
    action: "sku.deactivate",
    entity_type: "sku",
    entity_id: id,
    details_json: JSON.stringify({ code: existing.code }),
    ip_address: c.req.header("cf-connecting-ip"),
  });

  return c.json({ ok: true });
});
