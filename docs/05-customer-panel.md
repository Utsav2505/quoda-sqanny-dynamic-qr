# 05 — Customer Panel

## Route Structure

All customer routes are under `/customer` and require `requireCustomer` middleware (or `requireAuth` for registration).

| Route | Page | Purpose |
|-------|------|---------|
| `GET /customer` | Dashboard | Overview of customer's stands |
| `GET /customer/stands` | My Stands | All claimed QR codes |
| `GET /customer/add-stand` | Add Stand | Claim a new QR code |
| `GET /customer/stands/:id` | Stand Detail | QR info, destination config |
| `GET /customer/stands/:id/setup` | Stand Setup | Configure destination (first-time) |
| `GET /customer/profile` | Profile | Account info |
| `GET /customer/settings` | Settings | Account settings |

---

## Page Specifications

### `/customer` — Dashboard

**Purpose:** At-a-glance overview of customer's claimed stands.

**Data displayed:**
- Welcome message with customer name
- Stats: total stands, active stands, pending setup
- Recent stands (last 5, with status and destination)
- Quick actions: Add New Stand, View All Stands

**API requirements:**
- `GET /api/customer/dashboard` — aggregated stats

**Database queries:**
```sql
SELECT pq.*, s.code as sku_code, s.name as sku_name
FROM product_qr pq
JOIN skus s ON pq.sku_id = s.id
WHERE pq.customer_id = ?
ORDER BY pq.updated_at DESC
LIMIT 5
```

**Loading state:** Skeleton cards.

**Empty state:** "You haven't claimed any stands yet. Scan a QR code on your product to get started."

**Responsive behavior:** Stats cards stack on mobile. Stands list becomes card layout.

---

### `/customer/stands` — My Stands

**Purpose:** View all claimed QR codes.

**Data displayed:**
- Table/card list: SKU name, serial number, short code, status, destination (truncated), claimed date
- Filters: status (all, active, pending setup)
- Sort: newest, oldest, recently updated

**API requirements:**
- `GET /api/customer/stands` — list customer's stands

**Database queries:**
```sql
SELECT pq.*, s.code as sku_code, s.name as sku_name
FROM product_qr pq
JOIN skus s ON pq.sku_id = s.id
WHERE pq.customer_id = ?
ORDER BY pq.claimed_at DESC
```

**Loading state:** Card skeleton rows.

**Empty state:** "No stands yet. Add your first stand by scanning the QR code on your product."

**Responsive behavior:** Table becomes card layout on mobile.

---

### `/customer/add-stand` — Add Stand (Claim Flow)

**Purpose:** Register and claim a new QR code.

**Flow (multi-step):**

#### Step 1: Scan or Enter Code
- Camera button to scan QR code (uses device camera via `<input type="file" accept="image/*" capture="environment">`)
- Manual entry text field for short code
- "How to find your code" help text

**Technical approach for QR scanning:**
- Client island uses `jsqr` library (already in devDependencies) to decode camera feed
- Alternatively, customer can manually type the short code from the QR

#### Step 2: Verify Code
- System looks up the short code
- If not found: "Code not found. Please check and try again."
- If found but already claimed by another customer: "This code has already been registered."
- If AVAILABLE: show SKU info, confirm registration
- If already claimed by THIS customer: "You already own this stand."

**API requirements:**
- `GET /api/customer/stands/lookup?code=...` — verify and get QR info

**Database queries:**
```sql
SELECT pq.*, s.code as sku_code, s.name as sku_name
FROM product_qr pq
JOIN skus s ON pq.sku_id = s.id
WHERE pq.short_code = ?
```

#### Step 3: Confirm Registration
- Display: SKU name, serial number (internal only), QR preview
- "Claim This Stand" button
- Creates claim record

**API requirements:**
- `POST /api/customer/claims` — claim a QR code

**Database operations (transaction):**
1. Verify QR is AVAILABLE
2. Set `customer_id` on `product_qr`
3. Set `status = 'claimed'`
4. Set `claimed_at = Date.now()`
5. Create audit log entry

**Success:** Redirect to `/customer/stands/:id/setup` to configure destination.

---

### `/customer/stands/:id` — Stand Detail

**Purpose:** View stand info and configure destination.

**Data displayed:**
- QR code preview (SVG render, forced light theme)
- Info card: SKU name, serial number, short code, status
- Destination URL (if set, clickable)
- Lifecycle info: claimed date, activated date
- Actions: Edit Destination, Disable, View QR Code

**API requirements:**
- `GET /api/customer/stands/:id` — stand detail

**Actions:**
- "Edit Destination" → inline edit or modal
- "Disable" → PATCH `/api/customer/stands/:id` `{ status: "disabled" }`

**Loading state:** Skeleton card + QR preview placeholder.

**Error state:** "Stand not found or you don't have access."

---

### `/customer/stands/:id/setup` — Stand Setup

**Purpose:** Configure destination URL (first-time setup after claiming).

**Form fields:**
- Destination URL (required, text input with validation)
- Title (optional, for reference)

**Preview section:**
- QR code preview (updates as URL is typed)

**Actions:**
- "Activate Stand" — PUT `/api/customer/stands/:id/destination`
- "Skip for now" — redirect to stand detail (QR stays CLAIMED)

**Validation:**
- URL must be valid (prepend https:// if missing)
- Must be a real URL (not empty, not localhost in production)

**API requirements:**
- `PUT /api/customer/stands/:id/destination` — set destination

**Database operations:**
1. Verify ownership (customer_id matches current user)
2. Set `destination` on `product_qr`
3. Set `status = 'active'`
4. Set `activated_at = Date.now()`
5. Create audit log entry

**Success:** Redirect to stand detail with success toast.

---

### `/customer/profile` — Profile

**Purpose:** View and edit account information.

**Data displayed:**
- Email address
- Registration date
- Total stands count
- Account plan (for future use)

**Actions:**
- Update name/email
- Change password (future)

**API requirements:**
- `GET /api/customer/profile` — profile data
- `PATCH /api/customer/profile` — update profile

---

### `/customer/settings` — Settings

**Purpose:** Account settings and preferences.

**Data displayed:**
- Account info
- Notification preferences (future)
- Danger zone: delete account

**Actions:**
- Update preferences
- Delete account (soft delete, future)

---

## Customer Authentication

### Registration Flow
1. Customer scans QR code → arrives at `/customer/add-stand`
2. System detects no session → redirects to `/login`
3. Customer enters email → magic link sent
4. Customer verifies → session created
5. If first login (no customer profile): redirect to `/customer/add-stand` with code
6. If existing customer: redirect to `/customer/stands` or `/customer/add-stand`

### Session Management
- Same as existing: 30-day cookie, KV cache + D1
- Customer and admin use the same auth system
- Role-based routing: after login, redirect based on `user.role`
  - `admin` → `/admin`
  - `user` → `/customer`

### Profile Creation
- Customer profile is implicit — the first time a user claims a QR, they become a customer
- No separate registration form needed
- Profile data: email (from auth), name (optional, set in profile)

---

## Customer Navigation

```
/customer
├── Dashboard (overview)
├── My Stands (list)
├── Add Stand (claim flow)
├── Profile
└── Settings
```

**Navigation component:** Reuses existing `nav` component with customer-specific links.

---

## Shared Components with Admin

- `qr-preview` — QR code display (reused)
- `badge` — status badges (reused)
- `button` — all variants (reused)
- `card` — info cards (reused)
- `input`, `textarea`, `select` — form fields (reused)
- `modal` — confirmation dialogs (reused)
- `toast` — notifications (reused)

## Customer-Specific Components

### Claim Flow Component
Multi-step form:
1. Camera/manual code entry
2. Code verification (loading → success/error)
3. Confirmation with QR preview

### Stand Card Component
Card displaying:
- SKU name
- Status badge
- Truncated destination URL
- QR preview thumbnail
- Last updated timestamp

### Destination Editor Component
Inline edit or modal:
- URL input with validation
- Live QR preview update
- Save/cancel buttons
