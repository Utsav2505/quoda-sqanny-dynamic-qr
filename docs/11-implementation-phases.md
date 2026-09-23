# 11 — Implementation Phases

## Phase Overview

The Product QR Management System is implemented in 8 phases. Each phase builds on the previous one. Phases are designed to be independently testable and deployable.

---

## Phase 1: Architecture & Database (Current)

**Duration:** Planning only (no code changes)
**Status:** Complete

### Deliverables
- [x] Complete codebase analysis
- [x] Current architecture documented
- [x] Target architecture documented
- [x] Database design documented
- [x] All planning documents created
- [ ] Progress tracking initialized

### Dependencies
- None (this is the foundation)

---

## Phase 2: Database Schema & Auth

**Duration:** 1-2 days
**Priority:** High (everything depends on this)
**Status:** ✅ Complete

### Tasks
1. Create `0002_product_qr.sql` migration
   - Add `role` column to `users`
   - Create `skus` table
   - Create `batches` table
   - Create `product_qr` table
   - Create `audit_log` table
   - Create `short_code_lookup` table
2. Add `requireAdmin` middleware
3. Add `requireCustomer` middleware (if needed separately)
4. Add new row types to `src/db/queries.ts`
5. Add new query functions
6. Update `src/types.ts` with new types
7. Write migration tests
8. Apply migration locally and verify

### Files Modified
- `migrations/0002_product_qr.sql` (new)
- `src/middleware/auth.ts` (add requireAdmin)
- `src/db/queries.ts` (add new queries)
- `src/types.ts` (add new types)

### Files Created
- `tests/migration.test.ts`

### Verification
- `npm run migrate:local` succeeds ✅
- `npm run typecheck` passes (pre-existing errors only) ✅
- `npm test` passes (168/169, 1 pre-existing failure) ✅

---

## Phase 3: Admin SKU & Batch Management

**Duration:** 2-3 days
**Priority:** High (core product functionality)
**Status:** ✅ Complete

### Tasks
1. SKU CRUD
   - `POST /api/admin/skus` — create SKU ✅
   - `GET /api/admin/skus` — list SKUs ✅
   - `GET /api/admin/skus/:id` — SKU detail ✅
   - `PATCH /api/admin/skus/:id` — update SKU ✅
   - `DELETE /api/admin/skus/:id` — soft-delete SKU ✅
2. Batch management
   - `POST /api/admin/batches` — create batch + start generation ✅
   - `GET /api/admin/batches` — list batches ✅
   - `GET /api/admin/batches/:id` — batch detail ✅
   - `GET /api/admin/batches/:id/qr-codes` — batch QR list ✅
3. Batch generation logic
   - `src/lib/batch.ts` — generation engine ✅
   - Serial number generation ✅
   - Short code generation (reuse existing) ✅
   - Batch number generation ✅
   - Inline generation via `ctx.waitUntil` ✅
4. Admin pages
   - `/admin/skus` — SKU list ✅
   - `/admin/skus/new` — create SKU form ✅
   - `/admin/skus/:id` — SKU detail ✅
   - `/admin/skus/:id/edit` — edit SKU form ✅
   - `/admin/batches` — batch list ✅
   - `/admin/batches/new` — create batch form ✅
   - `/admin/batches/:id` — batch detail with progress ✅

### Files Modified
- `src/routes/api/admin/skus.ts` (new)
- `src/routes/api/admin/batches.ts` (new)
- `src/routes/admin/skus.tsx` (new)
- `src/routes/admin/batches.tsx` (new)
- `src/lib/batch.ts` (new)
- `src/ui/admin-shell.tsx` (new)
- `src/index.tsx` (mount new routes)
- `public/styles/app.css` (admin styles)

### Files Created
- `src/routes/admin/dashboard.tsx`
- `src/routes/admin/skus.tsx`
- `src/routes/admin/batches.tsx`
- `src/routes/api/admin/skus.ts`
- `src/routes/api/admin/batches.ts`
- `src/lib/batch.ts`
- `src/ui/admin-shell.tsx`

### Verification
- Admin can create SKU ✅
- Admin can create batch ✅
- Batch generates correct number of QR codes ✅
- Serial numbers are sequential and unique ✅
- Short codes are unique ✅
- Batch progress updates correctly ✅
- Admin pages render correctly ✅
- Existing tests still pass ✅

---

## Phase 4: QR Inventory & Detail

**Duration:** 2-3 days
**Priority:** High (admin needs to see what was generated)

### Tasks
1. QR inventory API
   - `GET /api/admin/qr-codes` — list with search/filter/sort/paginate
   - `GET /api/admin/qr-codes/:id` — QR detail
   - `PATCH /api/admin/qr-codes/:id` — update status
   - `GET /api/admin/qr-codes/:id/svg` — export SVG
2. Admin pages
   - `/admin/qr-codes` — inventory with search/filter/sort
   - `/admin/qr-codes/:id` — QR detail page
3. Reusable components
   - `src/ui/components/table.tsx` — data table with sort
   - `src/ui/components/pagination.tsx` — server-side pagination
   - `src/ui/components/search-input.tsx` — debounced search
4. Enhanced redirect
   - Update `/r/:code` to check `product_qr` first
   - Lifecycle-aware behavior (AVAILABLE → claim, ACTIVE → redirect, etc.)
5. Audit logging
   - `src/lib/audit.ts` — audit log writer
   - Log all state transitions

### Files Modified
- `src/routes/redirect.ts` (enhanced with product_qr lookup)
- `src/routes/api/admin/qr-codes.ts` (new)
- `src/routes/admin/qr-codes.tsx` (new)
- `src/db/queries.ts` (add inventory queries)
- `src/lib/audit.ts` (new)

### Files Created
- `src/routes/admin/qr-codes.tsx`
- `src/routes/api/admin/qr-codes.ts`
- `src/ui/components/table.tsx`
- `src/ui/components/pagination.tsx`
- `src/ui/components/search-input.tsx`
- `src/lib/audit.ts`
- `tests/product-qr-api.test.ts`
- `tests/redirect-product.test.ts`
- `tests/audit.test.ts`

### Verification
- QR inventory loads with pagination
- Search finds QR by serial, short code, SKU
- Filter by status works
- Sort options work
- QR detail shows all info
- Status transitions work
- Audit log records all actions
- Redirect handles all lifecycle states

---

## Phase 5: Customer Management & Admin Dashboard

**Duration:** 1-2 days
**Priority:** Medium (admin can now see customers)

### Tasks
1. Customer management API
   - `GET /api/admin/customers` — list customers
   - `GET /api/admin/customers/:id` — customer detail
   - `GET /api/admin/customers/:id/qr-codes` — customer's QR codes
2. Admin dashboard
   - `GET /api/admin/dashboard` — aggregated stats
   - `/admin` — dashboard page with stats
3. Admin pages
   - `/admin/customers` — customer list
   - `/admin/customers/:id` — customer detail
   - `/admin/audit-log` — audit log viewer
   - `/admin/settings` — admin settings

### Files Created
- `src/routes/admin/dashboard.tsx`
- `src/routes/admin/customers.tsx`
- `src/routes/admin/audit-log.tsx`
- `src/routes/admin/settings.tsx`
- `src/routes/api/admin/customers.ts`
- `src/routes/api/admin/audit-log.ts`
- `src/routes/api/admin/dashboard.ts`

### Verification
- Dashboard shows correct stats
- Customer list loads with pagination
- Customer detail shows their QR codes
- Audit log shows all actions
- Admin settings page renders

---

## Phase 6: Customer Panel & Claim Flow

**Duration:** 3-4 days
**Priority:** High (end-to-end product flow)

### Tasks
1. Customer stand management API
   - `GET /api/customer/stands` — list my stands
   - `GET /api/customer/stands/:id` — stand detail
   - `PUT /api/customer/stands/:id/destination` — set destination
   - `PATCH /api/customer/stands/:id` — disable/enable
   - `GET /api/customer/stands/lookup` — look up QR by code
2. Claim flow API
   - `POST /api/customer/claims` — claim QR
3. Customer pages
   - `/customer` — dashboard
   - `/customer/stands` — stands list
   - `/customer/add-stand` — claim flow (multi-step)
   - `/customer/stands/:id` — stand detail
   - `/customer/stands/:id/setup` — destination setup
   - `/customer/profile` — profile page
   - `/customer/settings` — settings page
4. Customer navigation
   - `src/ui/components/customer-nav.tsx`
5. QR scanning (client island)
   - Camera-based QR scanning using jsQR
   - Manual code entry fallback

### Files Created
- `src/routes/customer/dashboard.tsx`
- `src/routes/customer/stands.tsx`
- `src/routes/customer/add-stand.tsx`
- `src/routes/customer/stand-detail.tsx`
- `src/routes/customer/profile.tsx`
- `src/routes/customer/settings.tsx`
- `src/routes/api/customer/stands.ts`
- `src/routes/api/customer/claims.ts`
- `src/routes/api/customer/profile.ts`
- `src/ui/components/customer-nav.tsx`
- `src/client/qr-scan.ts` (new island)
- `tests/customer-api.test.ts`
- `tests/customer-routes.test.ts`
- `tests/claim.test.ts`

### Verification
- Customer can see their stands
- Customer can claim a QR code
- Claim flow works end-to-end
- Customer can set destination
- QR becomes ACTIVE after destination set
- `/r/:code` redirects to destination
- Customer cannot access other customer's QR codes

---

## Phase 7: Export & Polish

**Duration:** 2-3 days
**Priority:** Medium (production readiness)

### Tasks
1. QR export
   - SVG export for individual QR codes
   - CSV export for batch QR codes
   - Bulk SVG download for batch (zip)
2. QR label printing
   - Print-optimized layout
   - Label format (optional)
3. Search/filter polish
   - URL-based filter state (bookmarkable)
   - Filter chips with remove
   - Clear all filters
4. Loading states
   - Skeleton loaders for all pages
   - Progressive loading for batch generation
5. Error states
   - Error boundaries for all pages
   - Retry buttons
   - Offline handling
6. Empty states
   - Helpful messages for all empty states
   - Quick action buttons
7. Responsive design
   - Mobile layouts for all admin pages
   - Mobile layouts for all customer pages
   - Touch-friendly interactions

### Verification
- SVG export works
- CSV export works
- Filters are bookmarkable
- Loading states show correctly
- Error states show correctly
- Empty states show correctly
- All pages work on mobile

---

## Phase 8: Security Hardening & Analytics

**Duration:** 2-3 days
**Priority:** High (production readiness)

### Tasks
1. Security hardening
   - IDOR protection audit
   - Rate limiting on all new endpoints
   - Destination URL validation
   - SSRF prevention
   - Input sanitization
   - Error message sanitization
2. Analytics (basic)
   - Scan analytics for product QR codes
   - Reuse existing analytics infrastructure
   - Admin can view scan stats per QR
   - Customer can view scan stats for their stands
3. Performance optimization
   - Index optimization
   - Query optimization
   - KV caching for hot paths
4. Monitoring
   - Error logging
   - Performance logging
   - Audit log review

### Verification
- All security checks pass
- Rate limiting works
- Analytics display correctly
- Performance meets targets
- No SQL injection vulnerabilities
- No XSS vulnerabilities
- No IDOR vulnerabilities

---

## Phase Dependencies

```
Phase 1 (Planning)
  ↓
Phase 2 (Database + Auth)
  ↓
Phase 3 (SKU + Batch)
  ↓
Phase 4 (Inventory + Detail)
  ↓
Phase 5 (Customer Mgmt + Dashboard)
  ↓
Phase 6 (Customer Panel + Claim)
  ↓
Phase 7 (Export + Polish)
  ↓
Phase 8 (Security + Analytics)
```

## Estimated Total Duration

| Phase | Days |
|-------|------|
| Phase 1 | 0 (complete) |
| Phase 2 | 1-2 |
| Phase 3 | 2-3 |
| Phase 4 | 2-3 |
| Phase 5 | 1-2 |
| Phase 6 | 3-4 |
| Phase 7 | 2-3 |
| Phase 8 | 2-3 |
| **Total** | **13-20 days** |

## Risk Areas

1. **Batch generation performance** — inline generation may hit Worker limits for large batches
2. **Claim race conditions** — must be atomic to prevent double-claiming
3. **Short code uniqueness** — must check both qr_codes and product_qr tables
4. **Redirect performance** — two-table lookup may add latency
5. **Mobile QR scanning** — camera access varies by device/browser

## Mitigation Strategies

1. **Batch generation:** Cap at 500 inline, investigate Queue for larger
2. **Claim races:** Use conditional UPDATE (atomic operation)
3. **Short code uniqueness:** Consider shared lookup table
4. **Redirect performance:** KV cache for hot short codes
5. **Mobile scanning:** Fallback to manual code entry
