# 04 — Admin Panel

## Route Structure

All admin routes are under `/admin` and require `requireAdmin` middleware.

| Route | Page | Purpose |
|-------|------|---------|
| `GET /admin` | Dashboard | Overview stats, recent activity |
| `GET /admin/skus` | SKU List | All product types |
| `GET /admin/skus/new` | New SKU | Create SKU form |
| `GET /admin/skus/:id` | SKU Detail | SKU info + associated batches |
| `GET /admin/skus/:id/edit` | Edit SKU | Edit SKU form |
| `GET /admin/batches` | Batch List | All generation batches |
| `GET /admin/batches/new` | New Batch | Bulk QR generation form |
| `GET /admin/batches/:id` | Batch Detail | Batch info + generated QR codes |
| `GET /admin/qr-codes` | QR Inventory | Search/filter/sort/paginate all product QRs |
| `GET /admin/qr-codes/:id` | QR Detail | Individual QR info, status, customer, destination |
| `GET /admin/customers` | Customer List | All registered customers |
| `GET /admin/customers/:id` | Customer Detail | Customer info + their claimed QR codes |
| `GET /admin/audit-log` | Audit Log | System-wide action history |
| `GET /admin/settings` | Settings | Admin account, system config |

---

## Page Specifications

### `/admin` — Dashboard

**Purpose:** At-a-glance overview of the product QR system.

**Data displayed:**
- Total QR codes (by status: available, claimed, active, disabled, retired)
- Total SKUs (active count)
- Total batches (recent count)
- Total customers (users with at least one claimed QR)
- Recent batches (last 5, with status and progress)
- Recent claims (last 10, with customer and QR info)
- Quick actions: Create SKU, New Batch, View Inventory

**API requirements:**
- `GET /api/admin/dashboard` — aggregated stats

**Database queries:**
- `SELECT status, COUNT(*) FROM product_qr GROUP BY status`
- `SELECT COUNT(*) FROM skus WHERE is_active = 1`
- `SELECT COUNT(*) FROM batches ORDER BY created_at DESC LIMIT 5`
- `SELECT COUNT(DISTINCT customer_id) FROM product_qr WHERE customer_id IS NOT NULL`
- `SELECT pq.*, u.email, s.code FROM product_qr pq JOIN users u ON pq.customer_id = u.id JOIN skus s ON pq.sku_id = s.id WHERE pq.status = 'claimed' OR pq.status = 'active' ORDER BY pq.updated_at DESC LIMIT 10`

**Loading state:** Skeleton cards, spinner on stats.

**Empty state:** "No QR codes generated yet. Create a SKU and generate your first batch."

**Error state:** Error card with retry button.

**Responsive behavior:** 2-column grid on desktop, single column on mobile. Stats cards stack vertically.

---

### `/admin/skus` — SKU List

**Purpose:** Manage product types.

**Data displayed:**
- Table: code, name, description, active status, batch count, total QR count, created date
- Actions: Create New, Edit, Deactivate

**API requirements:**
- `GET /api/admin/skus` — list all SKUs with counts

**Database queries:**
```sql
SELECT s.*, COUNT(b.id) as batch_count, COUNT(pq.id) as qr_count
FROM skus s
LEFT JOIN batches b ON b.sku_id = s.id
LEFT JOIN product_qr pq ON pq.sku_id = s.id
GROUP BY s.id
ORDER BY s.created_at DESC
```

**Loading state:** Table skeleton rows.

**Empty state:** "No SKUs created yet. Create your first product type to start generating QR codes."

**Responsive behavior:** Table scrolls horizontally on mobile. Code/name columns always visible.

---

### `/admin/skus/new` — New SKU

**Purpose:** Create a new product type.

**Form fields:**
- Code (required, text, e.g., "RT-01") — validated for uniqueness
- Name (required, text, e.g., "Google Review Stand")
- Description (optional, textarea)

**Actions:**
- "Create SKU" — POST `/api/admin/skus`
- "Cancel" — back to list

**Validation:**
- Code: required, unique, alphanumeric + hyphens, max 20 chars
- Name: required, max 100 chars

**Success:** Redirect to `/admin/skus/:id` with success toast.

**Error:** Inline error messages on invalid fields.

---

### `/admin/skus/:id` — SKU Detail

**Purpose:** View SKU info and manage associated batches.

**Data displayed:**
- SKU info card (code, name, description, status)
- Stats: total batches, total QR codes, available/claimed/active counts
- Batch list (all batches for this SKU)
- Actions: Edit, Deactivate, Create New Batch

**API requirements:**
- `GET /api/admin/skus/:id` — SKU detail with stats
- `GET /api/admin/skus/:id/batches` — batches for this SKU

**Database queries:**
```sql
-- SKU with stats
SELECT s.*, COUNT(DISTINCT b.id) as batch_count, COUNT(pq.id) as qr_count,
  SUM(CASE WHEN pq.status = 'available' THEN 1 ELSE 0 END) as available_count,
  SUM(CASE WHEN pq.status = 'claimed' THEN 1 ELSE 0 END) as claimed_count,
  SUM(CASE WHEN pq.status = 'active' THEN 1 ELSE 0 END) as active_count
FROM skus s
LEFT JOIN batches b ON b.sku_id = s.id
LEFT JOIN product_qr pq ON pq.sku_id = s.id
WHERE s.id = ?
GROUP BY s.id;
```

**Loading state:** Skeleton card + table.

**Error state:** "SKU not found" with link back to list.

---

### `/admin/skus/:id/edit` — Edit SKU

**Purpose:** Update SKU details.

**Form fields:**
- Code (readonly — cannot change after creation)
- Name (required)
- Description (optional)

**Actions:**
- "Save Changes" — PATCH `/api/admin/skus/:id`
- "Cancel" — back to detail

**Success:** Redirect to detail page with success toast.

---

### `/admin/batches` — Batch List

**Purpose:** View all generation batches.

**Data displayed:**
- Table: batch number, SKU code, quantity, generated count, status, created date
- Status badges: pending (yellow), generating (blue), completed (green), failed (red)
- Actions: Create New Batch, View Detail

**API requirements:**
- `GET /api/admin/batches` — list all batches with pagination

**Database queries:**
```sql
SELECT b.*, s.code as sku_code, s.name as sku_name
FROM batches b
JOIN skus s ON b.sku_id = s.id
ORDER BY b.created_at DESC
LIMIT ? OFFSET ?
```

**Loading state:** Table skeleton rows.

**Empty state:** "No batches yet. Create your first batch to generate QR codes."

---

### `/admin/batches/new` — New Batch (Bulk QR Generation)

**Purpose:** Generate a batch of QR codes for a product.

**Form fields:**
- SKU (required, select dropdown of active SKUs)
- Quantity (required, number input, min 1, max 10,000)

**Preview section:**
- Selected SKU info card
- Estimated batch number (client-side preview)
- Estimated QR count

**Actions:**
- "Generate Batch" — POST `/api/admin/batches`
- "Cancel" — back to list

**Generation flow:**
1. POST `/api/admin/batches` with sku_id + quantity
2. Worker creates batch record (status: `pending`)
3. Worker generates QR codes in background via `ctx.waitUntil` or Queue
4. Each QR: generate serial, generate short_code, insert into `product_qr`
5. Update batch `generated_count` as each QR is created
6. Batch status: `pending` → `generating` → `completed` (or `failed`)
7. Client polls batch status via `GET /api/admin/batches/:id` until complete

**For large batches (1000+):** Use Cloudflare Queue for background processing. Client polls status endpoint.

**Success:** Redirect to batch detail page with progress indicator.

**Error:** Inline validation errors (SKU required, quantity invalid).

---

### `/admin/batches/:id` — Batch Detail

**Purpose:** View batch info and generated QR codes.

**Data displayed:**
- Batch info card (batch number, SKU, quantity, status, progress bar)
- QR code list (paginated table with serial, short code, status)
- Actions: Export (CSV/SVG), Print Labels, View SKU

**API requirements:**
- `GET /api/admin/batches/:id` — batch detail
- `GET /api/admin/batches/:id/qr-codes` — paginated QR list for this batch

**Loading state:** Progress bar with percentage during generation.

**Empty state (during generation):** "Generating QR codes... 234/500 complete."

---

### `/admin/qr-codes` — QR Inventory

**Purpose:** Search, filter, sort, and paginate all product QR codes.

**This is the critical inventory page.**

**Search bar:**
- Text input with debounce
- Searches: serial number, short code, SKU code, customer email

**Filters (sidebar or dropdown):**
- SKU (multi-select)
- Batch (multi-select, filtered by selected SKU)
- Status (available, claimed, active, disabled, retired)
- Customer (text search)
- Claimed/Unclaimed toggle
- Created date range

**Sort options:**
- Newest first (default)
- Oldest first
- Serial ascending
- Serial descending
- Recently updated
- Recently claimed

**Table columns:**
- Serial number (clickable link to detail)
- Short code
- SKU code
- Batch number
- Status (badge)
- Customer email (if claimed)
- Destination (truncated URL)
- Created date

**Pagination:**
- Server-side (LIMIT/OFFSET)
- 25, 50, 100 per page options
- Page navigation

**API requirements:**
- `GET /api/admin/qr-codes?page=1&limit=25&search=...&sku=...&batch=...&status=...&sort=newest`

**Database queries:**
```sql
SELECT pq.*, s.code as sku_code, s.name as sku_name, b.batch_number, u.email as customer_email
FROM product_qr pq
JOIN skus s ON pq.sku_id = s.id
JOIN batches b ON pq.batch_id = b.id
LEFT JOIN users u ON pq.customer_id = u.id
WHERE [dynamic conditions]
ORDER BY [dynamic sort]
LIMIT ? OFFSET ?
```

**Loading state:** Table skeleton rows, spinner on filter/sort changes.

**Empty state (no filters):** "No QR codes in the system yet."

**Empty state (with filters):** "No QR codes match your filters. Try adjusting your search."

**Responsive behavior:** Table scrolls horizontally on mobile. Serial + status columns always visible.

---

### `/admin/qr-codes/:id` — QR Detail

**Purpose:** View and manage individual QR code.

**Data displayed:**
- QR code preview (SVG render)
- Info card: serial number, short code, SKU, batch, status, created date
- Customer info (if claimed): name, email, claim date
- Destination URL (if active)
- Lifecycle timeline (created → claimed → active, with timestamps)
- Actions: Disable, Retire, View Customer, View Batch, Export SVG

**API requirements:**
- `GET /api/admin/qr-codes/:id` — QR detail with related data

**Actions:**
- "Disable" → PATCH `/api/admin/qr-codes/:id` `{ status: "disabled" }`
- "Retire" → PATCH `/api/admin/qr-codes/:id` `{ status: "retired" }`
- "Re-enable" → PATCH `/api/admin/qr-codes/:id` `{ status: "active" }` (from disabled only)
- "Export SVG" → GET `/api/admin/qr-codes/:id/svg`

**Loading state:** Skeleton card + QR preview placeholder.

**Error state:** "QR code not found" with link back to inventory.

---

### `/admin/customers` — Customer List

**Purpose:** View all registered customers.

**Data displayed:**
- Table: email, name, total QR codes, active stands, registered date
- Search: email, name
- Sort: newest, oldest, most stands

**API requirements:**
- `GET /api/admin/customers` — paginated customer list

**Database queries:**
```sql
SELECT u.*, COUNT(pq.id) as total_qr,
  SUM(CASE WHEN pq.status = 'active' THEN 1 ELSE 0 END) as active_count
FROM users u
LEFT JOIN product_qr pq ON pq.customer_id = u.id
WHERE u.role = 'user'
GROUP BY u.id
ORDER BY u.created_at DESC
LIMIT ? OFFSET ?
```

**Loading state:** Table skeleton rows.

**Empty state:** "No customers registered yet."

---

### `/admin/customers/:id` — Customer Detail

**Purpose:** View customer info and their claimed QR codes.

**Data displayed:**
- Customer info card (email, name, registration date, plan)
- QR codes table (all QR codes claimed by this customer)
- Stats: total claimed, active, disabled

**API requirements:**
- `GET /api/admin/customers/:id` — customer detail
- `GET /api/admin/customers/:id/qr-codes` — customer's QR codes

---

### `/admin/audit-log` — Audit Log

**Purpose:** View system-wide action history.

**Data displayed:**
- Table: timestamp, actor (email), action, entity type, entity ID, details
- Filters: actor, action type, entity type, date range
- Sort: newest (default), oldest

**API requirements:**
- `GET /api/admin/audit-log` — paginated audit entries

**Database queries:**
```sql
SELECT al.*, u.email as actor_email
FROM audit_log al
JOIN users u ON al.actor_id = u.id
WHERE [dynamic conditions]
ORDER BY al.created_at DESC
LIMIT ? OFFSET ?
```

**Loading state:** Table skeleton rows.

**Empty state:** "No audit entries yet."

---

### `/admin/settings` — Admin Settings

**Purpose:** Admin account management.

**Data displayed:**
- Account info (email, role, created date)
- Change password (if applicable — magic link only for now)
- System stats (total users, total QR codes, storage usage)

**Actions:**
- Update profile info
- View system health

---

## Shared Admin Components

### Admin Layout
- Sidebar navigation (collapsible on mobile)
- Top bar with user info + logout
- Content area (max 1200px)

### Admin Sidebar Navigation
```
/admin
├── Dashboard
├── SKUs
├── Batches
├── QR Inventory
├── Customers
├── Audit Log
└── Settings
```

### Data Table Component
Reusable table with:
- Column sorting (click headers)
- Row hover state
- Pagination controls
- Loading skeleton
- Empty state message

### Status Badge Component
- Available: green
- Claimed: yellow/amber
- Active: blue
- Disabled: gray
- Retired: red/strikethrough

### Search/Filter Bar
- Text search input with debounce (300ms)
- Filter dropdowns (multi-select)
- Active filter chips with remove button
- Clear all filters button
