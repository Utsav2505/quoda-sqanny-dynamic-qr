import { Hono } from "hono";
import { requireAdmin } from "../../middleware/auth";
import type { AppEnv } from "../../middleware/auth";
import { AdminShell } from "../../ui/admin-shell";
import {
  listBatches,
  getBatchById,
  listProductQrByBatch,
  getSkuById,
  listActiveSkus,
} from "../../db/queries";

export const adminBatches = new Hono<AppEnv>();

// Batch List
adminBatches.get("/admin/batches", requireAdmin, async (c) => {
  const user = c.get("user")!;
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const limit = 25;
  const offset = (page - 1) * limit;

  const batches = await listBatches(c.env.DB, limit, offset);

  const batchesWithSku = await Promise.all(
    batches.map(async (batch) => {
      const sku = await getSkuById(c.env.DB, batch.sku_id);
      return { ...batch, sku: sku ? { id: sku.id, code: sku.code, name: sku.name } : null };
    })
  );

  return c.html(
    <AdminShell user={user} active="batches">
      <div class="admin-page-header">
        <div>
          <h1 class="admin-page-title">Batches</h1>
          <p class="admin-page-subtitle">QR code generation batches</p>
        </div>
        <a href="/admin/batches/new" class="button button--primary">New Batch</a>
      </div>

      {batchesWithSku.length === 0 ? (
        <div class="admin-card">
          <div class="admin-empty">
            <div class="admin-empty-title">No batches yet</div>
            <div class="admin-empty-desc">Create your first batch to generate QR codes.</div>
            <a href="/admin/batches/new" class="button button--primary">Create Batch</a>
          </div>
        </div>
      ) : (
        <div class="admin-card">
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Batch Number</th>
                  <th>SKU</th>
                  <th>Quantity</th>
                  <th>Generated</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {batchesWithSku.map((batch) => (
                  <tr>
                    <td><a href={`/admin/batches/${batch.id}`}>{batch.batch_number}</a></td>
                    <td>{batch.sku ? `${batch.sku.code} — ${batch.sku.name}` : "—"}</td>
                    <td>{batch.quantity.toLocaleString()}</td>
                    <td>{batch.generated_count.toLocaleString()}</td>
                    <td><span class={`status-badge status-badge--${batch.status}`}>{batch.status}</span></td>
                    <td>{new Date(batch.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AdminShell>
  );
});

// New Batch Form
adminBatches.get("/admin/batches/new", requireAdmin, async (c) => {
  const user = c.get("user")!;
  const skus = await listActiveSkus(c.env.DB);
  const preselectedSku = c.req.query("sku");

  return c.html(
    <AdminShell user={user} active="batches">
      <div class="admin-page-header">
        <div>
          <h1 class="admin-page-title">New Batch</h1>
          <p class="admin-page-subtitle">Generate QR codes for a product</p>
        </div>
        <a href="/admin/batches" class="button button--ghost">Back to Batches</a>
      </div>

      <div class="admin-card">
        {skus.length === 0 ? (
          <div class="admin-empty">
            <div class="admin-empty-title">No active SKUs</div>
            <div class="admin-empty-desc">Create a SKU first before generating batches.</div>
            <a href="/admin/skus/new" class="button button--primary">Create SKU</a>
          </div>
        ) : (
          <form class="admin-form" id="batch-form">
            <div class="admin-form-group">
              <label class="input-label" for="batch-sku">Product SKU</label>
              <select class="input" id="batch-sku" name="sku_id" required>
                <option value="">Select a SKU...</option>
                {skus.map((sku) => (
                  <option value={sku.id} selected={preselectedSku === sku.id}>
                    {sku.code} — {sku.name}
                  </option>
                ))}
              </select>
            </div>
            <div class="admin-form-group">
              <label class="input-label" for="batch-quantity">Quantity</label>
              <input class="input" type="number" id="batch-quantity" name="quantity" min="1" max="10000" value="100" required />
              <p class="input-hint">Number of QR codes to generate (1–10,000)</p>
            </div>
            <div class="admin-form-actions">
              <button type="submit" class="button button--primary">Generate Batch</button>
              <a href="/admin/batches" class="button button--ghost">Cancel</a>
            </div>
          </form>
        )}
      </div>

      <script dangerouslySetInnerHTML={{ __html: `
        document.getElementById("batch-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const form = e.target;
          const data = {
            sku_id: form.sku_id.value,
            quantity: parseInt(form.quantity.value, 10),
          };
          if (!data.sku_id) { alert("Select a SKU"); return; }
          if (data.quantity < 1 || data.quantity > 10000) { alert("Quantity must be 1–10,000"); return; }
          try {
            const res = await fetch("/api/admin/batches", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            });
            const json = await res.json();
            if (json.ok) {
              window.location.href = "/admin/batches/" + json.data.id;
            } else {
              alert(json.errors ? Object.values(json.errors).join(", ") : json.error);
            }
          } catch (err) {
            alert("Failed to create batch");
          }
        });
      ` }} />
    </AdminShell>
  );
});

// Batch Detail
adminBatches.get("/admin/batches/:id", requireAdmin, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const batch = await getBatchById(c.env.DB, id);

  if (!batch) {
    return c.html(
      <AdminShell user={user} active="batches">
        <div class="admin-page-header">
          <h1 class="admin-page-title">Batch Not Found</h1>
        </div>
        <div class="admin-card">
          <a href="/admin/batches" class="button button--primary">Back to Batches</a>
        </div>
      </AdminShell>
    );
  }

  const sku = await getSkuById(c.env.DB, batch.sku_id);
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const limit = 25;
  const offset = (page - 1) * limit;
  const qrCodes = await listProductQrByBatch(c.env.DB, id, limit, offset);

  const progress = batch.quantity > 0 ? Math.round((batch.generated_count / batch.quantity) * 100) : 0;

  return c.html(
    <AdminShell user={user} active="batches">
      <div class="admin-page-header">
        <div>
          <h1 class="admin-page-title">{batch.batch_number}</h1>
          <p class="admin-page-subtitle">
            {sku ? `${sku.code} — ${sku.name}` : "Unknown SKU"}
          </p>
        </div>
        <a href="/admin/batches" class="button button--ghost">Back to Batches</a>
      </div>

      <div class="admin-stats">
        <div class="admin-stat-card">
          <div class="admin-stat-label">Status</div>
          <div class="admin-stat-value">
            <span class={`status-badge status-badge--${batch.status}`}>{batch.status}</span>
          </div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Quantity</div>
          <div class="admin-stat-value">{batch.quantity.toLocaleString()}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Generated</div>
          <div class="admin-stat-value">{batch.generated_count.toLocaleString()}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Progress</div>
          <div class="admin-stat-value">{progress}%</div>
          <div class="admin-progress">
            <div class="admin-progress-fill" style={`width:${progress}%`}></div>
          </div>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-header">
          <h2 class="admin-card-title">QR Codes</h2>
        </div>
        {qrCodes.length === 0 ? (
          <div class="admin-empty">
            <div class="admin-empty-title">
              {batch.status === "generating" ? "Generating..." : "No QR codes generated"}
            </div>
            {batch.status === "generating" && (
              <div class="admin-empty-desc">QR codes are being generated. Refresh to see progress.</div>
            )}
          </div>
        ) : (
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>Short Code</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {qrCodes.map((qr) => (
                  <tr>
                    <td>{qr.serial_number}</td>
                    <td><code>{qr.short_code}</code></td>
                    <td><span class={`status-badge status-badge--${qr.status}`}>{qr.status}</span></td>
                    <td>{new Date(qr.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminShell>
  );
});
