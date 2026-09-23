# 10 — Testing Plan

## Testing Strategy

Three layers of testing, consistent with existing Sqanny approach:

1. **Unit Tests** (Vitest) — isolated function testing
2. **Integration Tests** (Vitest + miniflare D1) — API endpoint testing
3. **E2E Tests** (Playwright) — full browser workflow testing

## Test Environment

- **Vitest** with `@cloudflare/vitest-pool-workers` for Workers-compatible testing
- **miniflare** for local D1/KV emulation
- **Playwright** with Chromium for E2E tests
- **jsQR** for QR code verification in E2E tests

## New Test Files

```
tests/
├── batch.test.ts              # Batch generation logic
├── product-qr-api.test.ts     # Product QR API endpoints
├── admin-api.test.ts          # Admin API endpoints
├── customer-api.test.ts       # Customer API endpoints
├── lifecycle.test.ts          # QR lifecycle state transitions
├── claim.test.ts              # Claim flow logic
├── audit.test.ts              # Audit logging
├── redirect-product.test.ts   # Enhanced redirect behavior
├── admin-routes.test.ts       # Admin page rendering
├── customer-routes.test.ts    # Customer page rendering
└── e2e/
    ├── admin-flow.spec.ts     # Admin: create SKU → batch → view inventory
    ├── customer-flow.spec.ts  # Customer: scan → claim → setup
    └── claim-race.spec.ts     # Race condition testing
```

---

## Unit Tests

### `tests/batch.test.ts` — Batch Generation Logic

| Test | Description |
|------|-------------|
| `generates correct batch number` | B-YYYYMMDD-NNN format |
| `generates correct serial numbers` | SQ-NNNNNN format, sequential |
| `generates unique short codes` | No collisions |
| `respects quantity parameter` | Generates exact count |
| `handles empty batch` | Quantity = 0 |
| `handles max quantity` | Quantity = 10000 |

### `tests/lifecycle.test.ts` — State Transitions

| Test | Description |
|------|-------------|
| `AVAILABLE → CLAIMED` | Valid transition |
| `CLAIMED → ACTIVE` | Valid transition |
| `ACTIVE → DISABLED` | Valid transition |
| `DISABLED → ACTIVE` | Valid re-enable |
| `AVAILABLE → RETIRED` | Valid transition |
| `ACTIVE → RETIRED` | Valid transition |
| `RETIRED → *` | All transitions rejected |
| `CLAIMED → AVAILABLE` | Rejected (cannot un-claim) |
| `ACTIVE → CLAIMED` | Rejected (cannot un-activate) |

### `tests/claim.test.ts` — Claim Logic

| Test | Description |
|------|-------------|
| `claims AVAILABLE QR` | Successful claim |
| `rejects claim on CLAIMED QR` | Already claimed |
| `rejects claim on ACTIVE QR` | Already active |
| `rejects claim on DISABLED QR` | Disabled |
| `rejects claim on RETIRED QR` | Retired |
| `atomic claim prevents race` | Two concurrent claims, one succeeds |
| `customer cannot claim same QR twice` | Duplicate claim rejected |

### `tests/audit.test.ts` — Audit Logging

| Test | Description |
|------|-------------|
| `logs SKU creation` | action = sku.create |
| `logs batch creation` | action = batch.create |
| `logs QR claim` | action = qr.claim |
| `logs QR activation` | action = qr.activate |
| `logs QR disable` | action = qr.disable |
| `logs QR retire` | action = qr.retire |
| `includes actor_id` | Correct user logged |
| `includes entity details` | Correct entity logged |
| `includes IP address` | Request IP captured |

---

## Integration Tests

### `tests/product-qr-api.test.ts` — Product QR API

| Test | Description |
|------|-------------|
| `GET /api/admin/qr-codes` | Lists QR codes with pagination |
| `GET /api/admin/qr-codes?search=...` | Filters by serial/short code |
| `GET /api/admin/qr-codes?sku=...` | Filters by SKU |
| `GET /api/admin/qr-codes?status=...` | Filters by status |
| `GET /api/admin/qr-codes/:id` | Returns QR detail |
| `PATCH /api/admin/qr-codes/:id` | Disables QR |
| `PATCH /api/admin/qr-codes/:id` | Retires QR |
| `rejects invalid transition` | Returns 400 |
| `GET /api/admin/qr-codes/:id/svg` | Returns SVG file |

### `tests/admin-api.test.ts` — Admin API

| Test | Description |
|------|-------------|
| `GET /api/admin/dashboard` | Returns aggregated stats |
| `GET /api/admin/skus` | Lists SKUs |
| `POST /api/admin/skus` | Creates SKU |
| `POST /api/admin/skus` validates | Rejects duplicate code |
| `PATCH /api/admin/skus/:id` | Updates SKU |
| `DELETE /api/admin/skus/:id` | Soft-deletes SKU |
| `GET /api/admin/batches` | Lists batches |
| `POST /api/admin/batches` | Creates batch, starts generation |
| `GET /api/admin/batches/:id` | Returns batch detail |
| `GET /api/admin/customers` | Lists customers |
| `GET /api/admin/audit-log` | Lists audit entries |
| `rejects non-admin` | Returns 403 for regular users |

### `tests/customer-api.test.ts` — Customer API

| Test | Description |
|------|-------------|
| `GET /api/customer/stands` | Lists customer's stands |
| `GET /api/customer/stands/:id` | Returns stand detail |
| `PUT /api/customer/stands/:id/destination` | Sets destination |
| `rejects ownership` | 404 for other customer's QR |
| `POST /api/customer/claims` | Claims QR |
| `rejects claim on taken QR` | Returns error |
| `GET /api/customer/stands/lookup` | Looks up QR by code |
| `GET /api/customer/profile` | Returns profile |

### `tests/redirect-product.test.ts` — Enhanced Redirect

| Test | Description |
|------|-------------|
| `AVAILABLE QR → claim page` | Redirects to /customer/claim |
| `CLAIMED QR → setup page` | Redirects to /customer/stands/:id/setup |
| `ACTIVE QR → destination` | 302 redirect + scan log |
| `DISABLED QR → disabled page` | Shows disabled message |
| `RETIRED QR → retired page` | Shows retired message |
| `unknown code → 404` | Not found |
| `falls through to qr_codes` | Existing behavior preserved |
| `logs scan for ACTIVE only` | No scan log for other states |

### `tests/admin-routes.test.ts` — Admin Page Rendering

| Test | Description |
|------|-------------|
| `GET /admin renders` | Dashboard page renders |
| `GET /admin/skus renders` | SKU list page renders |
| `GET /admin/skus/new renders` | New SKU form renders |
| `GET /admin/batches renders` | Batch list page renders |
| `GET /admin/qr-codes renders` | QR inventory page renders |
| `GET /admin/customers renders` | Customer list page renders |
| `redirects non-admin` | Redirects to /login or /app |

### `tests/customer-routes.test.ts` — Customer Page Rendering

| Test | Description |
|------|-------------|
| `GET /customer renders` | Dashboard page renders |
| `GET /customer/stands renders` | Stands list page renders |
| `GET /customer/add-stand renders` | Add stand page renders |
| `GET /customer/profile renders` | Profile page renders |
| `redirects unauthenticated` | Redirects to /login |

---

## E2E Tests

### `tests/e2e/admin-flow.spec.ts` — Admin Workflow

```
1. Login as admin
2. Navigate to /admin
3. Verify dashboard stats
4. Navigate to /admin/skus/new
5. Create SKU (RT-01, "Google Review Stand")
6. Verify SKU appears in list
7. Navigate to /admin/batches/new
8. Select SKU, enter quantity (10)
9. Generate batch
10. Verify batch completes
11. Navigate to /admin/qr-codes
12. Verify 10 QR codes appear
13. Search for specific serial number
14. Filter by SKU
15. Filter by status
16. Click QR detail
17. Verify QR preview renders
18. Disable QR
19. Verify status changes
```

### `tests/e2e/customer-flow.spec.ts` — Customer Workflow

```
1. Navigate to /r/{available_code}
2. Verify redirect to claim page
3. Login/signup
4. Verify claim confirmation page
5. Claim QR
6. Verify redirect to setup page
7. Enter destination URL
8. Activate stand
9. Verify redirect to stand detail
10. Navigate to /customer/stands
11. Verify stand appears in list
12. Navigate to /r/{active_code}
13. Verify redirect to destination
14. Verify scan logged
```

### `tests/e2e/claim-race.spec.ts` — Race Condition

```
1. Create 2 browser contexts (2 users)
2. Both navigate to claim page for same QR
3. Both attempt to claim simultaneously
4. Verify exactly one succeeds
5. Verify other gets "already registered" error
6. Verify QR status is CLAIMED (not double-claimed)
```

---

## Test Data Setup

### `tests/apply-migrations.ts` (existing, enhanced)

```typescript
// Apply all migrations including 0002_product_qr.sql
// Seed test data:
// - Admin user (role: 'admin')
// - Customer user (role: 'user')
// - Test SKU (RT-01)
// - Test batch (B-20260922-001)
// - Test QR codes (SQ-000001..SQ-000010)
```

### Test Helpers

```typescript
// tests/helpers.ts
export async function createTestAdmin(db: D1Database): Promise<UserRow>
export async function createTestCustomer(db: D1Database): Promise<UserRow>
export async function createTestSku(db: D1Database, code: string): Promise<SkuRow>
export async function createTestBatch(db: D1Database, skuId: string, quantity: number): Promise<BatchRow>
export async function createTestProductQr(db: D1Database, batchId: string, skuId: string, status: string): Promise<ProductQrRow>
export async function claimQr(db: D1Database, qrId: string, customerId: string): Promise<void>
```

---

## Coverage Targets

| Area | Target |
|------|--------|
| Batch generation | 100% |
| Lifecycle transitions | 100% |
| Claim logic | 100% |
| API endpoints | 90% |
| Redirect behavior | 100% |
| Security checks | 100% |
| UI rendering | 80% |

## Performance Testing

### Batch Generation Performance

- Test with 100, 500, 1000, 5000 QR codes
- Measure generation time
- Identify Worker CPU/memory limits
- Determine inline vs Queue threshold

### Redirect Performance

- Test redirect latency (target: <50ms)
- Test scan logging overhead (should be <10ms added)
- Test with concurrent redirects

### Query Performance

- Test inventory search with 1000, 10000, 100000 QR codes
- Measure query time with various filters
- Identify need for additional indexes

---

## Running Tests

```bash
# Unit + integration tests
npm test

# E2E tests
npm run test:e2e

# Specific test file
npx vitest run tests/batch.test.ts

# Watch mode
npm run test:watch

# Type checking
npm run typecheck
```
