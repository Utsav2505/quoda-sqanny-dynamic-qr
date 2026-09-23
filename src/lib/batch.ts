import type { D1Database } from "@cloudflare/workers-types";
import {
  createBatch,
  createProductQr,
  createShortCodeLookup,
  updateBatchStatus,
  incrementBatchGeneratedCount,
} from "../db/queries";
import { ensureUniqueShortCode } from "./shortcode";

function padSerial(n: number): string {
  return `SQ-${String(n).padStart(6, "0")}`;
}

function todayBatchDate(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * Generate the next batch number for today.
 * Format: B-YYYYMMDD-NNN
 */
export async function generateBatchNumber(db: D1Database): Promise<string> {
  const datePart = todayBatchDate();
  const key = `batch:seq:${datePart}`;

  // Try to increment the KV counter, fall back to D1 query
  let seq = 1;

  // Query D1 for the max sequence today
  const prefix = `B-${datePart}-`;
  const { results } = await db
    .prepare("SELECT batch_number FROM batches WHERE batch_number LIKE ? ORDER BY batch_number DESC LIMIT 1")
    .bind(`${prefix}%`)
    .all<{ batch_number: string }>();

  if (results && results.length > 0) {
    const lastNum = parseInt(results[0].batch_number.split("-")[2], 10);
    seq = lastNum + 1;
  }

  return `B-${datePart}-${String(seq).padStart(3, "0")}`;
}

/**
 * Generate the next serial number.
 * Format: SQ-NNNNNN (global sequential)
 */
export async function generateSerialNumber(db: D1Database): Promise<string> {
  const { results } = await db
    .prepare("SELECT serial_number FROM product_qr ORDER BY serial_number DESC LIMIT 1")
    .all<{ serial_number: string }>();

  let nextNum = 1;
  if (results && results.length > 0) {
    const lastSerial = results[0].serial_number;
    const lastNum = parseInt(lastSerial.replace("SQ-", ""), 10);
    nextNum = lastNum + 1;
  }

  return padSerial(nextNum);
}

export interface GenerateBatchResult {
  batchId: string;
  batchNumber: string;
  quantity: number;
  generatedCount: number;
  status: "completed" | "failed";
  error?: string;
}

/**
 * Generate all QR codes for a batch.
 * Runs inline via ctx.waitUntil for MVP (batches ≤ 500).
 */
export async function generateBatch(
  db: D1Database,
  batchId: string,
  skuId: string,
  quantity: number,
): Promise<GenerateBatchResult> {
  try {
    await updateBatchStatus(db, batchId, "generating");

    let generatedCount = 0;

    for (let i = 0; i < quantity; i++) {
      const serialNumber = await generateSerialNumber(db);
      const shortCode = await ensureUniqueShortCode(db);

      await createProductQr(db, {
        serial_number: serialNumber,
        short_code: shortCode,
        sku_id: skuId,
        batch_id: batchId,
        status: "available",
      });

      // Create short code lookup entry
      await createShortCodeLookup(db, {
        short_code: shortCode,
        source: "product_qr",
        source_id: "", // Will be updated after we get the ID
      });

      generatedCount = await incrementBatchGeneratedCount(db, batchId);
    }

    await updateBatchStatus(db, batchId, "completed", generatedCount);

    return {
      batchId,
      batchNumber: "",
      quantity,
      generatedCount,
      status: "completed",
    };
  } catch (err) {
    console.error(`[batch] generation failed for batch ${batchId}:`, err);
    await updateBatchStatus(db, batchId, "failed");
    return {
      batchId,
      batchNumber: "",
      quantity,
      generatedCount: 0,
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
