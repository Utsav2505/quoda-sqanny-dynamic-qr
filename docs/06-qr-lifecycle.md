# 06 — QR Lifecycle

## Overview

Product QR codes follow a strict lifecycle from creation through retirement. The lifecycle is tracked via the `status` field on `product_qr` and is enforced by both API validation and the redirect handler.

## Lifecycle States

```
                    ┌─────────────┐
                    │  GENERATED  │
                    │ (transient) │
                    └──────┬──────┘
                           │ batch complete
                           ▼
                    ┌─────────────┐
         ┌─────────│  AVAILABLE  │─────────┐
         │         └──────┬──────┘         │
         │                │ claim           │ disable
         │                ▼                 ▼
         │         ┌─────────────┐   ┌─────────────┐
         │         │   CLAIMED   │   │  DISABLED   │
         │         └──────┬──────┘   └──────┬──────┘
         │                │                 │
         │                │ set destination │ re-enable
         │                ▼                 │
         │         ┌─────────────┐          │
         │         │    ACTIVE   │◄─────────┘
         │         └──────┬──────┘
         │                │
         │                │ disable
         │                ▼
         │         ┌─────────────┐
         │         │  DISABLED   │
         │         └──────┬──────┘
         │                │
         │                │ retire
         │                ▼
         │         ┌─────────────┐
         └────────►│   RETIRED   │
                   └─────────────┘
```

## State Definitions

### GENERATED (transient)
- **When:** Batch generation is in progress
- **Not stored:** This is a conceptual state during batch processing. Records are created with status `available` directly.
- **Duration:** Milliseconds (during batch generation)

### AVAILABLE
- **When:** QR code has been generated but not yet claimed by a customer
- **Redirect behavior:** Redirects to claim/registration experience
- **Customer can:** Claim this QR
- **Admin can:** Disable, retire, view, export
- **QR code is:** Fully functional, scannable, leads to claim flow

### CLAIMED
- **When:** Customer has claimed the QR but not yet set a destination
- **Redirect behavior:** Redirects to setup/configure experience
- **Customer can:** Set destination URL
- **Admin can:** View, disable, retire, reassign (future)
- **QR code is:** Claimed but not yet redirecting to final destination

### ACTIVE
- **When:** Customer has set a destination URL
- **Redirect behavior:** Logs scan + 302 redirect to destination
- **Customer can:** Change destination, disable
- **Admin can:** View, disable, retire
- **QR code is:** Fully operational

### DISABLED
- **When:** Admin or customer has disabled the QR
- **Redirect behavior:** Shows disabled page
- **Customer can:** Re-enable (if they disabled it)
- **Admin can:** Re-enable, retire
- **QR code is:** Scannable but shows "this code is disabled" message

### RETIRED
- **When:** Admin has retired the QR (permanent deactivation)
- **Redirect behavior:** Shows retired page
- **Customer can:** View only
- **Admin can:** View only (no re-enable)
- **QR code is:** Permanently offline, never redirects again

## State Transitions

### VALID Transitions

| From | To | Trigger | Actor |
|------|-----|---------|-------|
| AVAILABLE | CLAIMED | Customer claims QR | Customer |
| AVAILABLE | DISABLED | Admin disables | Admin |
| AVAILABLE | RETIRED | Admin retires | Admin |
| CLAIMED | ACTIVE | Customer sets destination | Customer |
| CLAIMED | DISABLED | Admin disables | Admin |
| CLAIMED | RETIRED | Admin retires | Admin |
| ACTIVE | DISABLED | Admin disables, customer disables | Admin, Customer |
| ACTIVE | RETIRED | Admin retires | Admin |
| DISABLED | ACTIVE | Admin re-enables, customer re-enables | Admin, Customer |
| DISABLED | RETIRED | Admin retires | Admin |

### INVALID Transitions (rejected with error)

| From | To | Reason |
|------|-----|--------|
| RETIRED | * | Cannot revive a retired QR |
| ACTIVE | CLAIMED | Cannot un-claim |
| CLAIMED | AVAILABLE | Cannot un-claim |
| * | GENERATED | Transient state, not settable |

## Redirect Behavior by State

### `GET /r/:code`

```
1. Look up short_code in product_qr table
2. If not found → 404 "Not Found"
3. Check status:
   a. AVAILABLE → redirect to /customer/claim?code={code}
   b. CLAIMED + no destination → redirect to /customer/stands/{id}/setup
   c. ACTIVE → log scan + 302 to destination
   d. DISABLED → render "this code is disabled" page
   e. RETIRED → render "this code is no longer active" page
```

### Scan Logging

- Only logs scans for ACTIVE QR codes
- AVAILABLE/CLAIMED redirects do NOT count as scans
- DISABLED/RETIRED pages do NOT count as scans
- Uses existing `logScan()` function via `ctx.waitUntil`

### Destination Resolution

- ACTIVE QR: `qr.destination` is the redirect target
- If destination is NULL but status is ACTIVE: treat as CLAIMED (edge case protection)
- If destination is invalid/empty: show error page, don't redirect

## Batch Lifecycle

### Batch States

| State | Meaning |
|-------|---------|
| `pending` | Batch created, generation not started |
| `generating` | QR codes being generated |
| `completed` | All QR codes generated successfully |
| `failed` | Generation failed (partial or complete) |

### Batch Generation Process

1. Admin creates batch (POST `/api/admin/batches`)
2. Batch record created with status `pending`
3. Generation starts (immediately or via Queue):
   a. For each quantity:
      - Generate serial number (`SQ-NNNNNN`)
      - Generate short code (base62, 7 chars)
      - Create `product_qr` record with status `available`
      - Update batch `generated_count`
   b. Batch status: `pending` → `generating`
4. Generation completes:
   a. Batch status: `generating` → `completed`
   b. Batch `generated_count` = `quantity`
5. On failure:
   a. Batch status: `generating` → `failed`
   b. Already-generated QR codes remain (status: `available`)
   c. Admin can retry generation for remaining count

### Batch Number Uniqueness

- Format: `B-YYYYMMDD-NNN`
- Date component: UTC date at batch creation time
- Sequence: daily counter (KV-backed, resets daily)
- Collision check: verify unique before insert

## Serial Number Uniqueness

- Format: `SQ-NNNNNN`
- Global sequential counter (KV-backed)
- Never reused, even if QR is retired
- Collision check: verify unique before insert

## Short Code Uniqueness

- Reuses existing `ensureUniqueShortCode()` from `src/lib/shortcode.ts`
- Checks against BOTH `qr_codes.short_code` and `product_qr.short_code`
- Collision check: query both tables

## Soft Delete Behavior

- No hard deletes for product QR codes
- `DISABLED` = temporarily offline
- `RETIRED` = permanently offline but record preserved
- SKUs: `is_active = 0` for soft-deleted SKUs
- Batches: always preserved (never deleted)

## Audit Trail

Every state transition creates an audit log entry:

| Transition | Action | Details |
|------------|--------|---------|
| → AVAILABLE | `qr.generate` | batch_id, sku_id, serial_number |
| AVAILABLE → CLAIMED | `qr.claim` | customer_id, short_code |
| CLAIMED → ACTIVE | `qr.activate` | destination_url |
| → DISABLED | `qr.disable` | reason (optional) |
| DISABLED → ACTIVE | `qr.re-enable` | — |
| → RETIRED | `qr.retire` | reason (optional) |

## Edge Cases

### Customer Claims, Then Account Deleted
- QR remains CLAIMED
- Admin can reassign to another customer or reset to AVAILABLE (future feature)

### Batch Generation Partial Failure
- Already-generated QR codes remain AVAILABLE
- Admin can retry generation for remaining count
- Batch tracks `generated_count` vs `quantity`

### Short Code Collision
- `ensureUniqueShortCode()` retries up to 1000 times
- If exhausted: error thrown, batch generation fails
- Probability: astronomically low (62^7 ≈ 3.5 trillion combinations)

### Multiple Customers Scan Same AVAILABLE QR
- First customer to complete claim wins
- Atomic claim: conditional UPDATE ensures single winner
- Other customers see "this code has already been registered"
