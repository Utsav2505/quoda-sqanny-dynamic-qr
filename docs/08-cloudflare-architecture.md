# 08 — Cloudflare Architecture

## Overview

The Product QR Management System remains on the existing Cloudflare Workers infrastructure. No new services are introduced for the MVP. Cloudflare Queues are investigated for large batch generation but may not be needed for initial implementation.

## Current Bindings (unchanged)

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | All persistent data |
| `SCAN_COUNTERS` | KV | Hot-path scan counters |
| `RATE_LIMIT` | KV | IP-based rate limiting |
| `SESSION_CACHE` | KV | Session cache (10-min TTL) |
| `ASSETS_BUCKET` | R2 | Logo/image uploads |
| `AI` | Workers AI | Vision + text + image models |

## New/Modified Bindings

### D1 (`DB`) — Primary Data Store

All new tables live in the same D1 database:
- `skus` — product types
- `batches` — generation batches
- `product_qr` — product QR records
- `audit_log` — action audit trail
- `short_code_lookup` — global short code → source mapping (if adopted)
- `users` — existing table, +1 column (`role`)

**Why D1 is sufficient:**
- Product QR data is relational (SKUs → batches → QR codes → customers)
- D1 supports JOINs, indexes, transactions
- Query patterns are standard CRUD + aggregation
- Scale: D1 handles thousands of queries per second per database

### KV — Caching Layer

#### Existing KV Usage
| Namespace | Purpose |
|-----------|---------|
| `SCAN_COUNTERS` | Scan daily counters (`scan:daily:{qr_id}:{date}`) |
| `RATE_LIMIT` | Rate limit counters (`rl:{key}:{window}`) |
| `SESSION_CACHE` | Session cache (`sess:{id}`) |

#### New KV Usage

**Batch sequence counters:**
- Key: `batch:seq:{YYYYMMDD}`
- Value: incrementing integer
- Purpose: generate unique batch numbers (`B-20260922-NNN`)
- TTL: 48 hours (2 days safety margin)

**Serial number counter:**
- Key: `serial:seq`
- Value: incrementing integer
- Purpose: generate unique serial numbers (`SQ-NNNNNN`)
- TTL: none (persists forever)

**Short code lookup cache (optional optimization):**
- Key: `scl:{short_code}`
- Value: `{ source: "product_qr", source_id: "..." }`
- TTL: 24 hours
- Purpose: cache hot redirect lookups
- Fallback: D1 query

### R2 (`ASSETS_BUCKET`)

No new R2 usage. Existing asset storage for logos and exports continues as-is. Product QR exports (SVG, PNG) can use the same R2 bucket if needed.

### Workers AI

No new AI usage. Existing Brand Match and Wallpaper features continue. Product QR system does not require AI.

## Cloudflare Queues (Investigation)

### Potential Use: Batch Generation

For large batches (1000+ QR codes), inline generation via `ctx.waitUntil` may approach Worker CPU/memory limits.

**Queue approach:**
```
POST /api/admin/batches
  ↓
Create batch record (status: pending)
  ↓
Publish message to Queue: { batch_id, sku_id, quantity, remaining: quantity }
  ↓
Queue consumer generates QR codes in batches of 50
  ↓
Each batch: insert 50 QR codes, update batch.generated_count
  ↓
When remaining = 0: batch status → completed
```

**Cloudflare Queue configuration:**
```jsonc
// wrangler.jsonc addition
"queues": {
  "producers": [
    { "binding": "BATCH_QUEUE", "queue": "batch-generation" }
  ],
  "consumers": [
    { "queue": "batch-generation", "max_retries": 3, "max_batch_size": 1 }
  ]
}
```

### MVP Decision: Inline Generation

For the initial implementation, batch generation runs inline via `ctx.waitUntil`:

**Pros:**
- No additional infrastructure
- Simpler code
- Works for batches up to ~500 QR codes

**Cons:**
- Worker CPU limit (30 seconds) may be approached for large batches
- No retry on failure

**Mitigation:**
- Cap inline generation at 500 QR codes per batch
- For larger batches, split into multiple requests (client-side loop)
- Queue support added later if needed

### Future: Queue for Large Batches

If batch sizes exceed 500, implement Queue-based generation:
1. Batch creation endpoint enqueues a message
2. Queue consumer processes in batches of 50
3. Each sub-batch runs in a separate Worker invocation
4. Client polls batch status until complete

## Background Jobs

### Scan Logging (existing)
- Uses `ctx.waitUntil()` to log scans without blocking redirects
- Never fails the redirect
- Writes to D1 `scans` table + KV counter

### Batch Generation (new, inline for MVP)
- Uses `ctx.waitUntil()` for batches ≤500
- Updates batch `generated_count` progressively
- Client polls batch status for progress

### Audit Logging (new)
- Synchronous write to D1 `audit_log` table
- Runs in the same Worker invocation as the action
- No background processing needed (fast D1 write)

## Caching Strategy

### What to Cache

| Data | Cache Location | TTL | Invalidation |
|------|---------------|-----|--------------|
| Session | KV (`SESSION_CACHE`) | 10 min | On logout |
| Scan counters | KV (`SCAN_COUNTERS`) | No expiry | Incremental update |
| Batch sequence | KV | 48 hours | Auto-expire |
| Serial sequence | KV | No expiry | Incremental update |
| Short code lookup | KV (optional) | 24 hours | On QR update |

### What NOT to Cache

| Data | Reason |
|------|--------|
| QR status | Must be real-time for redirect logic |
| Customer ownership | Security-critical, must be accurate |
| SKU active status | Must be real-time for admin operations |

## Edge Considerations

### D1 Read Replicas
- D1 automatically replicates to Cloudflare edge
- Read queries hit nearest replica
- Write queries go to primary
- Consistency: eventual (writes visible within milliseconds)

### Worker Execution Limits
- CPU time: 30 seconds (paid plan)
- Memory: 128 MB
- Subrequests: 50 per invocation
- KV reads: 1000 per invocation
- D1 queries: no hard limit, but keep under 50 per invocation for performance

### Request Size Limits
- POST body: 100 MB (Workers standard)
- KV value: 25 MB
- R2 object: 5 GB

## Deployment

### Migration Strategy
1. Create new migration file: `0002_product_qr.sql`
2. Apply to local D1: `npm run migrate:local`
3. Test locally with `wrangler dev`
4. Apply to production: `npm run migrate:remote`
5. Deploy: `npm run deploy`

### Environment Variables
No new environment variables needed. Existing secrets (`RESEND_API_KEY`, `FAL_KEY`, `APP_URL`) continue to work.

### Custom Domain
Existing custom domain: `quoda.codebyte.dev`
Admin panel: `quoda.codebyte.dev/admin`
Customer panel: `quoda.codebyte.dev/customer`

## Monitoring

### Cloudflare Dashboard
- Worker invocations and duration
- D1 query count and latency
- KV read/write count
- R2 storage and requests

### Application-Level Monitoring
- Audit log for admin actions
- Batch generation status tracking
- Error logging via `console.error` (visible in Workers logs)

### Future: Cloudflare Analytics
- Enable Workers Analytics for request metrics
- D1 query analytics for performance monitoring
