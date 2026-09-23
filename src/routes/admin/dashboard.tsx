import { Hono } from "hono";
import { requireAdmin } from "../../middleware/auth";
import type { AppEnv } from "../../middleware/auth";
import { AdminShell } from "../../ui/admin-shell";
import {
  countProductQrByStatus,
  countCustomers,
  listBatches,
  listSkus,
  getSkuById,
} from "../../db/queries";

export const adminDashboard = new Hono<AppEnv>();

adminDashboard.get("/admin", requireAdmin, async (c) => {
  const user = c.get("user")!;

  const statusCounts = await countProductQrByStatus(c.env.DB);
  const totalCustomers = await countCustomers(c.env.DB);
  const recentBatches = await listBatches(c.env.DB, 5, 0);
  const skus = await listSkus(c.env.DB);

  const batchesWithSku = await Promise.all(
    recentBatches.map(async (batch) => {
      const sku = await getSkuById(c.env.DB, batch.sku_id);
      return { ...batch, sku: sku ? { id: sku.id, code: sku.code, name: sku.name } : null };
    })
  );

  const totalQr = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  return c.html(
    <AdminShell user={user} active="dashboard">
      <div class="admin-page-header">
        <div>
          <h1 class="admin-page-title">Dashboard</h1>
          <p class="admin-page-subtitle">Product QR management overview</p>
        </div>
        <div style="display:flex;gap:var(--space-8)">
          <a href="/admin/skus/new" class="button button--primary">Create SKU</a>
          <a href="/admin/batches/new" class="button button--secondary">New Batch</a>
        </div>
      </div>

      <div class="admin-stats">
        <div class="admin-stat-card">
          <div class="admin-stat-label">Total QR Codes</div>
          <div class="admin-stat-value">{totalQr.toLocaleString()}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Available</div>
          <div class="admin-stat-value" style="color:var(--color-accent)">{statusCounts.available.toLocaleString()}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Claimed</div>
          <div class="admin-stat-value" style="color:#b37700">{statusCounts.claimed.toLocaleString()}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Active</div>
          <div class="admin-stat-value" style="color:#00a854">{statusCounts.active.toLocaleString()}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">SKUs</div>
          <div class="admin-stat-value">{skus.length}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Customers</div>
          <div class="admin-stat-value">{totalCustomers}</div>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-header">
          <h2 class="admin-card-title">Recent Batches</h2>
          <a href="/admin/batches" class="button button--ghost button--sm">View All</a>
        </div>
        {batchesWithSku.length === 0 ? (
          <div class="admin-empty">
            <div class="admin-empty-title">No batches yet</div>
            <div class="admin-empty-desc">Create your first batch to generate QR codes.</div>
            <a href="/admin/batches/new" class="button button--primary">Create Batch</a>
          </div>
        ) : (
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Batch</th>
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
        )}
      </div>
    </AdminShell>
  );
});
