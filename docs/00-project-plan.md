# 00 — Project Plan: Product QR Management System

## Current Sqanny

Sqanny is an open-source, self-hostable dynamic QR code platform built on Cloudflare Workers. Users create QR codes whose destination URL can be changed after printing. The core promise: "The QR code that never breaks."

**Current capabilities:**
- 12 QR types (URL, text, Wi-Fi, email, phone, SMS, vCard, PDF, menu, business card, app store, social)
- Static and dynamic QR codes with short-code redirects
- QR customization (colors, module shapes, eye styles, logo, frame labels)
- AI Brand Match (extract brand palette/logo from destination URL)
- AI QR Wallpaper generation
- Scan analytics (country, device, referrer)
- Hosted landing pages (menu, business, social, app store, PDF)
- Passwordless magic-link authentication
- Free/Pro plan system

## New Product QR Management System

Sqanny now needs a **product-focused QR management system** for physical product manufacturers, distributors, and retailers. Each physical product ships with a QR code that the end customer claims and configures.

**Primary use case:** A company manufactures products (e.g., Google Review Stands). Each unit has a unique QR code printed on it. When the customer purchases and receives the product, they scan the QR, create an account, claim the QR, and set a destination URL (e.g., their Google Review page). The QR then redirects to that URL permanently.

## Goals

1. **Admin-first implementation** — build the admin/product-management system before the customer side
2. **Preserve existing functionality** — generic dynamic QR codes, marketing pages, and all current features remain unchanged
3. **Scalable batch operations** — support bulk generation of thousands of QR codes per batch
4. **Clean lifecycle management** — AVAILABLE → CLAIMED → ACTIVE with DISABLED/RETIRED states
5. **Security-first** — ownership checks, IDOR protection, audit logging, no unauthorized access
6. **Cloudflare-compatible** — remain on Workers/D1/KV/R2 with no external dependencies

## Non-Goals

1. Payment processing for Pro plans (stubbed, not implemented)
2. Hardware/firmware integration with physical QR labels
3. Multi-tenant white-label admin (single admin role for now)
4. Real-time WebSocket updates (polling is acceptable)
5. Analytics as a priority (added last, after core product is working)

## Users / Roles

| Role | Description |
|------|-------------|
| **Admin** | Platform operator. Manages SKUs, batches, bulk QR generation, QR inventory, customers. Has full system access. |
| **Customer** | End-user who purchased a physical product. Claims QR codes, configures destinations, manages their stands. |

## Major Workflows

### Admin Workflow
1. Admin creates a SKU (product type, e.g., "RT-01 = Google Review Stand")
2. Admin initiates bulk generation: selects SKU, enters quantity
3. System generates a batch with unique batch number, serial numbers, and short codes
4. Admin views/manages QR inventory with search, filter, and sort
5. Admin can view individual QR details, customer info, and status
6. Admin can disable/retire QR codes

### Customer Workflow
1. Customer receives physical product with QR code
2. Customer scans QR → identifies the code
3. Customer creates account or logs in
4. Customer claims/registers the QR
5. Customer configures destination URL
6. QR becomes ACTIVE → `/r/:code` redirects to customer's destination

### Redirect Lifecycle
- UNKNOWN QR → 404
- AVAILABLE QR → registration/claim experience
- CLAIMED (no destination) → setup experience
- ACTIVE → log scan + redirect
- DISABLED → disabled page
- RETIRED → retired page

## Implementation Priorities

| Priority | Area | Description |
|----------|------|-------------|
| 1 | Architecture/Database | Schema design, migrations, new tables |
| 2 | Admin Auth/AuthZ | Admin role, admin-only middleware |
| 3 | Admin Dashboard | Overview, stats, quick actions |
| 4 | SKU Management | CRUD for product types |
| 5 | Batch Management | Create batches, view history |
| 6 | Bulk QR Generation | Generate codes at scale |
| 7 | QR Inventory | Search, filter, sort, paginate |
| 8 | Search/Filter/Sort | Server-side query engine |
| 9 | QR Detail | Individual QR management |
| 10 | Customer Management | View customers, their QR codes |
| 11 | Customer Auth/Profile | Customer registration, profile |
| 12 | Customer QR Registration | Claim flow |
| 13 | Customer QR Management | Customer's stand dashboard |
| 14 | Destination Management | Edit destination URLs |
| 15 | Dynamic Redirect Lifecycle | State-aware `/r/:code` behavior |
| 16 | Export/Printing | QR label export |
| 17 | Security Hardening | IDOR, rate limiting, audit |
| 18 | Analytics | Scan analytics (last) |

## Key Architectural Decisions (Phase 1)

1. **Extend, don't replace** — add new tables alongside existing schema, reuse existing QR infrastructure
2. **Admin panel under `/admin`** — separate route prefix from existing `/app` dashboard
3. **Customer panel under `/customer`** — separate from admin and generic user dashboard
4. **Shared QR engine** — reuse existing `src/lib/qr/` for generation, rendering, scannability
5. **Reuse existing components** — buttons, cards, inputs, modals, tables from `src/ui/components/`
6. **Cloudflare Queues** — investigate for bulk generation background jobs
7. **No new frameworks** — remain on Hono + hono/jsx + vanilla TS islands
