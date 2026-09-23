# 07 — API Plan

## Overview

New API endpoints for the Product QR Management System. All endpoints follow existing patterns: Hono routes, JSON responses, D1 queries, KV caching where appropriate.

## Authentication

- All admin endpoints require `requireAdmin` middleware
- All customer endpoints require `requireAuth` middleware
- Public endpoints have rate limiting via `RATE_LIMIT` KV

## Response Format

Consistent JSON response format:

```json
// Success
{ "ok": true, "data": { ... } }

// Success with pagination
{ "ok": true, "data": [...], "total": 100, "page": 1, "limit": 25 }

// Error
{ "ok": false, "error": "message" }

// Validation error
{ "ok": false, "errors": { "field": "message" } }
```

---

## Admin API Endpoints

### Dashboard

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/admin/dashboard` | Aggregated stats |

**Response:**
```json
{
  "ok": true,
  "data": {
    "totalQr": 5000,
    "byStatus": { "available": 3000, "claimed": 1000, "active": 800, "disabled": 150, "retired": 50 },
    "totalSkus": 5,
    "totalBatches": 12,
    "totalCustomers": 450,
    "recentBatches": [...],
    "recentClaims": [...]
  }
}
```

---

### SKU Management

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/admin/skus` | List all SKUs | Admin |
| `POST` | `/api/admin/skus` | Create SKU | Admin |
| `GET` | `/api/admin/skus/:id` | SKU detail | Admin |
| `PATCH` | `/api/admin/skus/:id` | Update SKU | Admin |
| `DELETE` | `/api/admin/skus/:id` | Deactivate SKU | Admin |

**POST /api/admin/skus**
```json
// Request
{ "code": "RT-01", "name": "Google Review Stand", "description": "..." }

// Response
{ "ok": true, "data": { "id": "...", "code": "RT-01", "name": "...", ... } }
```

**Validation:**
- code: required, unique, alphanumeric + hyphens, max 20 chars
- name: required, max 100 chars

**PATCH /api/admin/skus/:id**
```json
// Request (partial)
{ "name": "Updated Name", "description": "Updated description" }

// Note: code is NOT patchable
```

**DELETE /api/admin/skus/:id**
- Soft delete: sets `is_active = 0`
- Rejects if SKU has any batches with generated QR codes

---

### Batch Management

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/admin/batches` | List all batches | Admin |
| `POST` | `/api/admin/batches` | Create batch (start generation) | Admin |
| `GET` | `/api/admin/batches/:id` | Batch detail | Admin |
| `GET` | `/api/admin/batches/:id/qr-codes` | Paginated QR list for batch | Admin |

**POST /api/admin/batches**
```json
// Request
{ "sku_id": "...", "quantity": 500 }

// Response (immediate — generation runs in background)
{
  "ok": true,
  "data": {
    "id": "...",
    "batch_number": "B-20260922-001",
    "sku_id": "...",
    "quantity": 500,
    "status": "generating",
    "generated_count": 0
  }
}
```

**Validation:**
- sku_id: required, must exist and be active
- quantity: required, integer, 1-10000

**Generation mechanism:**
- For small batches (≤100): inline via `ctx.waitUntil`
- For large batches (>100): Cloudflare Queue (investigated, may use inline for MVP)

**GET /api/admin/batches/:id**
```json
{
  "ok": true,
  "data": {
    "id": "...",
    "batch_number": "B-20260922-001",
    "sku": { "id": "...", "code": "RT-01", "name": "..." },
    "quantity": 500,
    "generated_count": 500,
    "status": "completed",
    "created_at": 1695369600000
  }
}
```

---

### QR Inventory

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/admin/qr-codes` | List/search/filter/sort/paginate | Admin |
| `GET` | `/api/admin/qr-codes/:id` | QR detail | Admin |
| `PATCH` | `/api/admin/qr-codes/:id` | Update status (disable/retire/re-enable) | Admin |
| `GET` | `/api/admin/qr-codes/:id/svg` | Export QR as SVG | Admin |

**GET /api/admin/qr-codes**
```
Query params:
  page=1         (default: 1)
  limit=25       (default: 25, max: 100)
  search=...     (searches serial_number, short_code, sku code, customer email)
  sku=...        (filter by SKU ID)
  batch=...      (filter by batch ID)
  status=...     (filter by status: available|claimed|active|disabled|retired)
  claimed=true   (filter: true = claimed only, false = unclaimed only)
  sort=newest    (newest|oldest|serial_asc|serial_desc|updated|claimed)
  from=...       (created after timestamp)
  to=...         (created before timestamp)
```

**Response:**
```json
{
  "ok": true,
  "data": [
    {
      "id": "...",
      "serial_number": "SQ-000001",
      "short_code": "A7kP92x",
      "sku": { "id": "...", "code": "RT-01", "name": "..." },
      "batch": { "id": "...", "batch_number": "B-20260922-001" },
      "status": "active",
      "customer": { "id": "...", "email": "user@example.com" },
      "destination": "https://google.com/maps/...",
      "created_at": 1695369600000,
      "claimed_at": 1695456000000,
      "activated_at": 1695456100000
    }
  ],
  "total": 5000,
  "page": 1,
  "limit": 25
}
```

**PATCH /api/admin/qr-codes/:id**
```json
// Disable
{ "status": "disabled" }

// Retire
{ "status": "retired" }

// Re-enable (from disabled)
{ "status": "active" }
```

**Validation:**
- Only valid transitions allowed (see 06-qr-lifecycle.md)
- RETIRED cannot be changed to any other state

---

### Customer Management

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/admin/customers` | List all customers | Admin |
| `GET` | `/api/admin/customers/:id` | Customer detail | Admin |
| `GET` | `/api/admin/customers/:id/qr-codes` | Customer's QR codes | Admin |

---

### Audit Log

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/admin/audit-log` | List audit entries | Admin |

```
Query params:
  page=1
  limit=25
  actor=...      (filter by actor user ID)
  action=...     (filter by action type)
  entity=...     (filter by entity type)
  from=...       (created after)
  to=...         (created before)
```

---

## Customer API Endpoints

### Stand Lookup

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/customer/stands/lookup?code=...` | Look up QR by short code | Public (rate-limited) |

**Response (AVAILABLE):**
```json
{
  "ok": true,
  "data": {
    "short_code": "A7kP92x",
    "sku": { "code": "RT-01", "name": "Google Review Stand" },
    "status": "available",
    "can_claim": true
  }
}
```

**Response (already claimed by someone else):**
```json
{
  "ok": true,
  "data": {
    "short_code": "A7kP92x",
    "status": "claimed",
    "can_claim": false,
    "message": "This code has already been registered."
  }
}
```

---

### Claims

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `POST` | `/api/customer/claims` | Claim a QR code | Customer |

**Request:**
```json
{ "short_code": "A7kP92x" }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "id": "...",
    "serial_number": "SQ-000001",
    "short_code": "A7kP92x",
    "status": "claimed",
    "sku": { "code": "RT-01", "name": "..." }
  }
}
```

**Validation:**
- Short code must exist in `product_qr`
- Status must be `AVAILABLE`
- Customer must not already own this QR
- Atomic claim: conditional UPDATE prevents race conditions

---

### Stand Management

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/customer/stands` | List my stands | Customer |
| `GET` | `/api/customer/stands/:id` | Stand detail | Customer (ownership check) |
| `PUT` | `/api/customer/stands/:id/destination` | Set/update destination | Customer (ownership check) |
| `PATCH` | `/api/customer/stands/:id` | Disable/enable my stand | Customer (ownership check) |

**PUT /api/customer/stands/:id/destination**
```json
// Request
{ "destination": "https://google.com/maps/place/..." }

// Response
{
  "ok": true,
  "data": {
    "id": "...",
    "status": "active",
    "destination": "https://google.com/maps/place/...",
    "activated_at": 1695456100000
  }
}
```

**Validation:**
- Must own the stand (customer_id matches)
- Destination must be valid URL
- Destination must not be empty
- Stand must be CLAIMED or ACTIVE

---

### Profile

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/customer/profile` | Get profile | Customer |
| `PATCH` | `/api/customer/profile` | Update profile | Customer |

---

## Shared Endpoints

### Redirect

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/r/:code` | Dynamic QR redirect | Public |

**Enhanced behavior:**
1. Look up `product_qr` by `short_code`
2. If found:
   - AVAILABLE → redirect to `/customer/claim?code={code}`
   - CLAIMED + no destination → redirect to `/customer/stands/{id}/setup`
   - ACTIVE → log scan + 302 to destination
   - DISABLED → render disabled page
   - RETIRED → render retired page
3. If not found in `product_qr`:
   - Look up `qr_codes` by `short_code` (existing behavior)
   - If found → existing redirect logic
4. If not found anywhere → 404

### Upload

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `POST` | `/api/upload` | Upload logo to R2 | Customer, Admin |
| `GET` | `/assets/:key` | Stream asset from R2 | Public |

---

## Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/customer/stands/lookup` | 30 | per minute per IP |
| `/api/customer/claims` | 10 | per minute per user |
| `/api/admin/batches` | 5 | per minute per admin |
| All other admin endpoints | 120 | per minute per admin |

Rate limiting uses existing `RATE_LIMIT` KV infrastructure.

## Error Handling

All endpoints return consistent error responses:

```json
{ "ok": false, "error": "QR code not found" }
{ "ok": false, "error": "Invalid status transition" }
{ "ok": false, "errors": { "code": "Required", "quantity": "Must be between 1 and 10000" } }
```

HTTP status codes:
- 200: Success
- 201: Created
- 400: Bad request / validation error
- 401: Not authenticated
- 403: Not authorized (not admin, not owner)
- 404: Not found
- 409: Conflict (duplicate code, already claimed)
- 429: Rate limited
- 500: Internal error
