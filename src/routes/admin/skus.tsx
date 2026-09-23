import { Hono } from "hono";
import { requireAdmin } from "../../middleware/auth";
import type { AppEnv } from "../../middleware/auth";
import { AdminShell } from "../../ui/admin-shell";
import {
  listSkus,
  getSkuById,
  createSku,
  updateSku,
  deactivateSku,
  createAuditLog,
} from "../../db/queries";

export const adminSkus = new Hono<AppEnv>();

// SKU List
adminSkus.get("/admin/skus", requireAdmin, async (c) => {
  const user = c.get("user")!;
  const skus = await listSkus(c.env.DB);

  return c.html(
    <AdminShell user={user} active="skus">
      <div class="admin-page-header">
        <div>
          <h1 class="admin-page-title">SKUs</h1>
          <p class="admin-page-subtitle">Product types for QR code generation</p>
        </div>
        <a href="/admin/skus/new" class="button button--primary">Create SKU</a>
      </div>

      {skus.length === 0 ? (
        <div class="admin-card">
          <div class="admin-empty">
            <div class="admin-empty-title">No SKUs yet</div>
            <div class="admin-empty-desc">Create your first product type to start generating QR codes.</div>
            <a href="/admin/skus/new" class="button button--primary">Create SKU</a>
          </div>
        </div>
      ) : (
        <div class="admin-card">
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {skus.map((sku) => (
                  <tr>
                    <td><a href={`/admin/skus/${sku.id}`}>{sku.code}</a></td>
                    <td>{sku.name}</td>
                    <td>{sku.description || "—"}</td>
                    <td>
                      <span class={`status-badge ${sku.is_active ? "status-badge--active" : "status-badge--disabled"}`}>
                        {sku.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>{new Date(sku.created_at).toLocaleDateString()}</td>
                    <td>
                      <a href={`/admin/skus/${sku.id}/edit`} class="button button--ghost button--sm">Edit</a>
                    </td>
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

// New SKU Form
adminSkus.get("/admin/skus/new", requireAdmin, async (c) => {
  const user = c.get("user")!;

  return c.html(
    <AdminShell user={user} active="skus">
      <div class="admin-page-header">
        <div>
          <h1 class="admin-page-title">Create SKU</h1>
          <p class="admin-page-subtitle">Define a new product type</p>
        </div>
        <a href="/admin/skus" class="button button--ghost">Back to SKUs</a>
      </div>

      <div class="admin-card">
        <form class="admin-form" id="sku-form">
          <div class="admin-form-group">
            <label class="input-label" for="sku-code">Code</label>
            <input class="input" type="text" id="sku-code" name="code" placeholder="RT-01" maxlength="20" required />
            <p class="input-hint">Alphanumeric and hyphens only, max 20 characters</p>
          </div>
          <div class="admin-form-group">
            <label class="input-label" for="sku-name">Name</label>
            <input class="input" type="text" id="sku-name" name="name" placeholder="Google Review Stand" maxlength="100" required />
          </div>
          <div class="admin-form-group">
            <label class="input-label" for="sku-desc">Description</label>
            <textarea class="textarea" id="sku-desc" name="description" rows="3" placeholder="Optional description"></textarea>
          </div>
          <div class="admin-form-actions">
            <button type="submit" class="button button--primary">Create SKU</button>
            <a href="/admin/skus" class="button button--ghost">Cancel</a>
          </div>
        </form>
      </div>

      <script dangerouslySetInnerHTML={{ __html: `
        document.getElementById("sku-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const form = e.target;
          const data = {
            code: form.code.value.trim(),
            name: form.name.value.trim(),
            description: form.description.value.trim() || undefined,
          };
          try {
            const res = await fetch("/api/admin/skus", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            });
            const json = await res.json();
            if (json.ok) {
              window.location.href = "/admin/skus/" + json.data.id;
            } else {
              alert(json.errors ? Object.values(json.errors).join(", ") : json.error);
            }
          } catch (err) {
            alert("Failed to create SKU");
          }
        });
      ` }} />
    </AdminShell>
  );
});

// SKU Detail
adminSkus.get("/admin/skus/:id", requireAdmin, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const sku = await getSkuById(c.env.DB, id);

  if (!sku) {
    return c.html(
      <AdminShell user={user} active="skus">
        <div class="admin-page-header">
          <h1 class="admin-page-title">SKU Not Found</h1>
        </div>
        <div class="admin-card">
          <a href="/admin/skus" class="button button--primary">Back to SKUs</a>
        </div>
      </AdminShell>
    );
  }

  return c.html(
    <AdminShell user={user} active="skus">
      <div class="admin-page-header">
        <div>
          <h1 class="admin-page-title">{sku.code} — {sku.name}</h1>
          <p class="admin-page-subtitle">{sku.description || "No description"}</p>
        </div>
        <div style="display:flex;gap:var(--space-8)">
          <a href={`/admin/skus/${sku.id}/edit`} class="button button--secondary">Edit</a>
          <a href="/admin/skus" class="button button--ghost">Back to SKUs</a>
        </div>
      </div>

      <div class="admin-stats">
        <div class="admin-stat-card">
          <div class="admin-stat-label">Status</div>
          <div class="admin-stat-value">
            <span class={`status-badge ${sku.is_active ? "status-badge--active" : "status-badge--disabled"}`}>
              {sku.is_active ? "Active" : "Inactive"}
            </span>
          </div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Created</div>
          <div class="admin-stat-value">{new Date(sku.created_at).toLocaleDateString()}</div>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-header">
          <h2 class="admin-card-title">Quick Actions</h2>
        </div>
        <div style="display:flex;gap:var(--space-8)">
          <a href={`/admin/batches/new?sku=${sku.id}`} class="button button--primary">Generate Batch</a>
        </div>
      </div>
    </AdminShell>
  );
});

// Edit SKU Form
adminSkus.get("/admin/skus/:id/edit", requireAdmin, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const sku = await getSkuById(c.env.DB, id);

  if (!sku) {
    return c.redirect("/admin/skus", 302);
  }

  return c.html(
    <AdminShell user={user} active="skus">
      <div class="admin-page-header">
        <div>
          <h1 class="admin-page-title">Edit SKU</h1>
          <p class="admin-page-subtitle">{sku.code}</p>
        </div>
        <a href={`/admin/skus/${sku.id}`} class="button button--ghost">Back to SKU</a>
      </div>

      <div class="admin-card">
        <form class="admin-form" id="sku-edit-form">
          <div class="admin-form-group">
            <label class="input-label">Code</label>
            <input class="input" type="text" value={sku.code} disabled />
            <p class="input-hint">Code cannot be changed after creation</p>
          </div>
          <div class="admin-form-group">
            <label class="input-label" for="sku-name">Name</label>
            <input class="input" type="text" id="sku-name" name="name" value={sku.name} maxlength="100" required />
          </div>
          <div class="admin-form-group">
            <label class="input-label" for="sku-desc">Description</label>
            <textarea class="textarea" id="sku-desc" name="description" rows="3">{sku.description || ""}</textarea>
          </div>
          <div class="admin-form-actions">
            <button type="submit" class="button button--primary">Save Changes</button>
            <a href={`/admin/skus/${sku.id}`} class="button button--ghost">Cancel</a>
          </div>
        </form>
      </div>

      <script dangerouslySetInnerHTML={{ __html: `
        document.getElementById("sku-edit-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const form = e.target;
          const data = {
            name: form.name.value.trim(),
            description: form.description.value.trim() || undefined,
          };
          try {
            const res = await fetch("/api/admin/skus/${sku.id}", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            });
            const json = await res.json();
            if (json.ok) {
              window.location.href = "/admin/skus/${sku.id}";
            } else {
              alert(json.errors ? Object.values(json.errors).join(", ") : json.error);
            }
          } catch (err) {
            alert("Failed to update SKU");
          }
        });
      ` }} />
    </AdminShell>
  );
});
