# 02 — Target Architecture

## Overview

The Product QR Management System extends the existing Sqanny monolith. It adds admin and customer panels under new route prefixes (`/admin` and `/customer`) while preserving all existing functionality.

## Architecture Principle: Extend, Don't Replace

```
Cloudflare Worker (Hono + hono/jsx SSR)
├── /                           # Marketing (existing)
├── /login, /auth/*             # Auth (existing)
├── /app/*                      # Generic QR dashboard (existing)
├── /r/:code                    # Dynamic QR redirect (existing, enhanced)
├── /p/:slug                    # Hosted landing pages (existing)
├── /api/*                      # APIs (existing + new)
│
├── /admin/*                    # NEW: Admin panel
│   ├── /admin                  # Admin dashboard
│   ├── /admin/skus             # SKU management
│   ├── /admin/batches          # Batch management
│   ├── /admin/qr-codes         # QR inventory
│   ├── /admin/customers        # Customer management
│   ├── /admin/audit-log        # Audit log
│   └── /admin/settings         # Admin settings
│
├── /customer/*                 # NEW: Customer panel
│   ├── /customer               # Customer dashboard
│   ├── /customer/stands        # Customer's QR stands
│   ├── /customer/add-stand     # Claim a new stand
│   ├── /customer/stands/:id    # Stand detail + destination config
│   ├── /customer/profile       # Customer profile
│   └── /customer/settings      # Customer settings
│
└── /api/admin/*                # NEW: Admin API endpoints
    └── /api/customer/*         # NEW: Customer API endpoints
```

## Route Separation Strategy

### Existing Routes (unchanged)
- `/app/*` — generic QR dashboard (any authenticated user)
- `/api/qr/*` — generic QR CRUD

### New Admin Routes
- `/admin/*` — admin-only pages
- `/api/admin/*` — admin-only API endpoints
- Guarded by `requireAdmin` middleware (extends `requireAuth` with role check)

### New Customer Routes
- `/customer/*` — customer-only pages
- `/api/customer/*` — customer-only API endpoints
- Guarded by `requireCustomer` middleware (extends `requireAuth`)

### Shared Routes
- `/r/:code` — enhanced redirect with lifecycle-aware behavior
- `/login`, `/auth/*` — shared authentication
- `/api/upload` — shared asset upload

## Middleware Extensions

### Existing Middleware (unchanged)
```typescript
loadUser    // populates c.set("user", ...) or null
requireAuth // redirects to /login if no user
```

### New Middleware
```typescript
requireAdmin   // requireAuth + checks user is admin
requireCustomer // requireAuth + checks user has customer profile
```

**Admin detection strategy:** Add `role` column to `users` table. Values: `user` (default), `admin`. The `requireAdmin` middleware checks `user.role === "admin"`.

**Why not a separate admin_users table?** The existing `users` table already has email, plan, and session infrastructure. Adding a `role` column is minimal and avoids duplicating auth logic.

## Data Flow: Admin Creates QR Batch

```
Admin selects SKU + quantity
  ↓
POST /api/admin/batches
  ↓
Worker generates:
  - Batch record (B-20260922-001)
  - N QR records (SQ-000001..SQ-000N)
  - Each with unique short_code
  - All status = AVAILABLE
  ↓
Response: batch summary + QR codes
  ↓
Admin views batch detail page
  ↓
Admin can export/print QR labels
```

## Data Flow: Customer Claims QR

```
Customer scans physical QR
  ↓
GET /r/:code → lifecycle check
  ↓
AVAILABLE → redirect to /customer/claim?code=A7kP92x
  ↓
Customer logs in / signs up
  ↓
POST /api/customer/claims
  ↓
Worker:
  - Validates QR exists and is AVAILABLE
  - Sets customer_id on QR
  - Sets status = CLAIMED
  - Creates audit log entry
  ↓
Customer configures destination
  ↓
PUT /api/customer/stands/:id/destination
  ↓
Worker:
  - Validates ownership
  - Sets destination URL
  - Sets status = ACTIVE
  ↓
GET /r/:code → ACTIVE → log scan + 302 redirect
```

## Data Flow: Dynamic Redirect (Enhanced)

```
GET /r/:code
  ↓
Look up QR by short_code
  ↓
Not found → 404
  ↓
Status = AVAILABLE → redirect to /customer/claim?code=...
  ↓
Status = CLAIMED (no destination) → redirect to /customer/stands/:id/setup
  ↓
Status = ACTIVE → log scan + 302 to destination
  ↓
Status = DISABLED → render disabled page
  ↓
Status = RETIRED → render retired page
```

## File Structure Additions

```
src/
├── routes/
│   ├── admin/
│   │   ├── dashboard.tsx      # /admin
│   │   ├── skus.tsx           # /admin/skus, /admin/skus/new, /admin/skus/:id
│   │   ├── batches.tsx        # /admin/batches, /admin/batches/new, /admin/batches/:id
│   │   ├── qr-codes.tsx       # /admin/qr-codes, /admin/qr-codes/:id
│   │   ├── customers.tsx      # /admin/customers, /admin/customers/:id
│   │   ├── audit-log.tsx      # /admin/audit-log
│   │   └── settings.tsx       # /admin/settings
│   ├── customer/
│   │   ├── dashboard.tsx      # /customer
│   │   ├── stands.tsx         # /customer/stands
│   │   ├── add-stand.tsx      # /customer/add-stand
│   │   ├── stand-detail.tsx   # /customer/stands/:id
│   │   ├── profile.tsx        # /customer/profile
│   │   └── settings.tsx       # /customer/settings
│   └── api/
│       ├── admin/
│       │   ├── skus.ts        # CRUD /api/admin/skus
│       │   ├── batches.ts     # CRUD /api/admin/batches
│       │   ├── qr-codes.ts    # /api/admin/qr-codes (list, detail, bulk)
│       │   ├── customers.ts   # /api/admin/customers
│       │   └── audit-log.ts   # /api/admin/audit-log
│       └── customer/
│           ├── claims.ts      # POST /api/customer/claims
│           ├── stands.ts      # CRUD /api/customer/stands
│           └── profile.ts     # /api/customer/profile
├── middleware/
│   └── auth.ts                # Add requireAdmin, requireCustomer
├── db/
│   └── queries.ts             # Add new query functions
└── lib/
    └── batch.ts               # Batch generation logic
```

## Shared Infrastructure

### Reused Components
All existing UI components are reused:
- `button`, `card`, `input`, `select`, `textarea`, `modal`, `badge`, `stat`, `toast`, `nav`, `footer`, `qr-preview`

### Reused Libraries
- `src/lib/qr/` — QR generation engine (unchanged)
- `src/lib/shortcode.ts` — short code generation (unchanged)
- `src/lib/auth/` — authentication system (unchanged)
- `src/lib/analytics.ts` — scan logging (unchanged)
- `src/lib/plans.ts` — plan limits (unchanged)

### New Shared Components
- `src/ui/components/table.tsx` — reusable data table with sort/filter
- `src/ui/components/pagination.tsx` — server-side pagination
- `src/ui/components/search-input.tsx` — search input with debounce

### New Admin-Specific Components
- `src/ui/components/admin-nav.tsx` — admin sidebar navigation
- `src/ui/components/status-badge.tsx` — QR lifecycle status display
- `src/ui/components/batch-progress.tsx` — batch generation progress

## Compatibility Constraints

1. **Cloudflare Workers** — no Node.js APIs, no filesystem
2. **D1 only** — no external databases
3. **No new frameworks** — remain on Hono + hono/jsx
4. **No React** — server JSX + vanilla TS islands
5. **Existing routes untouched** — `/app/*`, `/api/qr/*` remain as-is
6. **Design system reuse** — same tokens, components, patterns
