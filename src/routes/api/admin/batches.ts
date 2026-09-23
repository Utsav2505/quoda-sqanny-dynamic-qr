import { Hono } from "hono";
import { requireAdmin } from "../../../middleware/auth";
import type { AppEnv } from "../../../middleware/auth";
import {
  createBatch,
  getBatchById,
  listBatches,
  getSkuById,
  listProductQrByBatch,
  countProductQrByStatus,
  countCustomers,
  listSkus,
  createAuditLog,
} from "../../../db/queries";
import { generateBatchNumber, generateBatch } from "../../../lib/batch";

export const batchApi = new Hono<AppEnv>();

// List all batches
batchApi.get("/api/admin/batches", requireAdmin, async (c) => {
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "25", 10), 100);
  const offset = (page - 1) * limit;

  const batches = await listBatches(c.env.DB, limit, offset);

  // Get SKU info for each batch
  const batchesWithSku = await Promise.all(
    batches.map(async (batch) => {
      const sku = await getSkuById(c.env.DB, batch.sku_id);
      return { ...batch, sku: sku ? { id: sku.id, code: sku.code, name: sku.name } : null };
    })
  );

  return c.json({ ok: true, data: batchesWithSku });
});

// Create batch (start generation)
batchApi.post("/api/admin/batches", requireAdmin, async (c) => {
  const body = await c.req.json<{ sku_id?: string; quantity?: number }>();
  const { sku_id, quantity } = body;

  const errors: Record<string, string> = {};
  if (!sku_id) errors.sku_id = "Required";
  if (!quantity || quantity < 1) errors.quantity = "Minimum 1";
  if (quantity && quantity > 10000) errors.quantity = "Maximum 10,000";

  if (Object.keys(errors).length > 0) {
    return c.json({ ok: false, errors }, 400);
  }

  // Verify SKU exists and is active
  const sku = await getSkuById(c.env.DB, sku_id!);
  if (!sku) return c.json({ ok: false, errors: { sku_id: "SKU not found" } }, 404);
  if (!sku.is_active) return c.json({ ok: false, errors: { sku_id: "SKU is inactive" } }, 400);

  // Generate batch number
  const batchNumber = await generateBatchNumber(c.env.DB);

  // Create batch record
  const batch = await createBatch(c.env.DB, {
    batch_number: batchNumber,
    sku_id: sku_id!,
    quantity: quantity!,
    status: "pending",
  });

  await createAuditLog(c.env.DB, {
    actor_id: c.get("user")!.id,
    action: "batch.create",
    entity_type: "batch",
    entity_id: batch.id,
    details_json: JSON.stringify({ batch_number: batchNumber, sku_id, quantity }),
    ip_address: c.req.header("cf-connecting-ip"),
  });

  // Start generation in background via waitUntil
  c.executionCtx.waitUntil(
    generateBatch(c.env.DB, batch.id, sku_id!, quantity!).catch((err) =>
      console.error("[batch] background generation error:", err)
    )
  );

  return c.json({ ok: true, data: batch }, 201);
});

// Get batch detail
batchApi.get("/api/admin/batches/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const batch = await getBatchById(c.env.DB, id);
  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);

  const sku = await getSkuById(c.env.DB, batch.sku_id);
  return c.json({
    ok: true,
    data: {
      ...batch,
      sku: sku ? { id: sku.id, code: sku.code, name: sku.name } : null,
    },
  });
});

// Get QR codes for a batch
batchApi.get("/api/admin/batches/:id/qr-codes", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const batch = await getBatchById(c.env.DB, id);
  if (!batch) return c.json({ ok: false, error: "Batch not found" }, 404);

  const page = parseInt(c.req.query("page") ?? "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "25", 10), 100);
  const offset = (page - 1) * limit;

  const qrCodes = await listProductQrByBatch(c.env.DB, id, limit, offset);

  return c.json({ ok: true, data: qrCodes });
});

// Dashboard stats
batchApi.get("/api/admin/dashboard", requireAdmin, async (c) => {
  const statusCounts = await countProductQrByStatus(c.env.DB);
  const totalCustomers = await countCustomers(c.env.DB);
  const recentBatches = await listBatches(c.env.DB, 5, 0);

  // Get SKU info for recent batches
  const batchesWithSku = await Promise.all(
    recentBatches.map(async (batch) => {
      const sku = await getSkuById(c.env.DB, batch.sku_id);
      return { ...batch, sku: sku ? { id: sku.id, code: sku.code, name: sku.name } : null };
    })
  );

  const totalQr = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const skus = await listSkus(c.env.DB);

  return c.json({
    ok: true,
    data: {
      totalQr,
      byStatus: statusCounts,
      totalSkus: skus.length,
      totalBatches: recentBatches.length,
      totalCustomers,
      recentBatches: batchesWithSku,
    },
  });
});
