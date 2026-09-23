# 09 — Security Plan

## Authentication

### Admin Authentication
- Uses existing magic-link authentication system
- No separate admin login — same `/login` flow
- Admin role detected via `users.role` column
- After login, admin users redirected to `/admin` (not `/app`)

### Customer Authentication
- Uses existing magic-link authentication system
- No separate customer login — same `/login` flow
- After login, customer users redirected to `/customer` (not `/app`)
- Customer profile is implicit (created on first QR claim)

### Session Management
- 30-day cookie (`sqanny_session`), HttpOnly, SameSite=Lax
- Dual-stored in D1 + KV cache (10-min TTL)
- Session validation on every request (server-side)
- No client-side JWT — prevents tampering

---

## Authorization

### Role-Based Access Control

| Role | Access |
|------|--------|
| `admin` | `/admin/*`, `/api/admin/*`, `/app/*`, `/customer/*` |
| `user` | `/customer/*`, `/api/customer/*`, `/app/*` |

**Admin can access everything.** Customer can only access their own data.

### Middleware Chain

```typescript
// Admin routes
requireAdmin = requireAuth + roleCheck("admin")

// Customer routes  
requireAuth = loadUser + redirectIfNoUser
requireCustomer = requireAuth (implicit — any authenticated user can be a customer)

// Public routes
loadUser = optional user loading (no redirect)
```

### Implementation

```typescript
// src/middleware/auth.ts additions
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = await getUserFromRequest(c.env, c.req.raw);
  if (!user) return c.redirect("/login", 302);
  if (user.role !== "admin") return c.text("Forbidden", 403);
  c.set("user", user);
  await next();
});
```

---

## Ownership Checks

### Customer QR Ownership

Every customer endpoint that accesses a QR code must verify ownership:

```typescript
// Verify customer owns this QR
const qr = await getQrById(db, id);
if (!qr || qr.customer_id !== user.id) {
  return c.json({ ok: false, error: "Not found" }, 404);
}
```

**Never expose QR codes belonging to other customers.** Use 404 (not 403) to avoid information leakage.

### Admin Access

Admin users can access all QR codes. No ownership check needed for admin endpoints.

---

## IDOR Protection

### Insecure Direct Object Reference Prevention

1. **Always use server-side user ID** — never trust client-provided user IDs
2. **Verify ownership on every request** — don't cache ownership checks
3. **Use UUIDs** — not sequential integers (already implemented)
4. **Return 404 for unauthorized access** — not 403 (prevents enumeration)

### Example: Customer Updates Destination

```typescript
// BAD: trusting client-provided user_id
const qr = await getQrById(db, id);
if (qr.customer_id !== req.body.user_id) { ... }

// GOOD: using server-side user from session
const user = c.get("user");
const qr = await getQrById(db, id);
if (!qr || qr.customer_id !== user.id) {
  return c.json({ ok: false, error: "Not found" }, 404);
}
```

---

## Claim Security

### Atomic Claiming

Prevent race conditions where two customers claim the same QR simultaneously:

```sql
-- Atomic claim: only succeeds if QR is still AVAILABLE
UPDATE product_qr
SET status = 'claimed', customer_id = ?, claimed_at = ?
WHERE short_code = ? AND status = 'available'
```

**Check `changes === 1`** to confirm the claim succeeded. If 0, another customer claimed it first.

### Claim Validation

1. QR must exist
2. QR must be in `AVAILABLE` status
3. Customer must not already own this QR
4. Short code must be valid format

### Post-Claim

After successful claim:
- Set `customer_id` to current user
- Set `status = 'claimed'`
- Set `claimed_at` timestamp
- Create audit log entry

---

## Redirect Validation

### Destination URL Validation

When customer sets destination URL:

1. **URL format validation** — must be a valid URL
2. **Protocol check** — only `http://` and `https://` allowed
3. **No local addresses** — block `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`
4. **No internal networks** — block `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`
5. **Maximum length** — 2048 characters

```typescript
function validateDestination(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(parsed.hostname)) return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(parsed.hostname)) return false;
    if (url.length > 2048) return false;
    return true;
  } catch {
    return false;
  }
}
```

### Redirect Safety

- 302 redirect (not 301) — prevents browser caching of destination
- Log scan before redirect — ensures scan is recorded even if redirect fails
- `waitUntil` — scan logging never blocks the redirect
- No user-controlled data in redirect headers — prevents header injection

---

## Rate Limiting

### Existing Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /api/preview` | 60 | per minute per IP |
| `POST /api/brand` | 20 | per minute per IP |
| `POST /api/wallpaper` | 8 | per minute per IP |

### New Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `GET /api/customer/stands/lookup` | 30 | per minute per IP |
| `POST /api/customer/claims` | 10 | per minute per user |
| `POST /api/admin/batches` | 5 | per minute per admin |
| `GET /api/admin/qr-codes` | 120 | per minute per admin |
| All other admin endpoints | 120 | per minute per admin |

### Rate Limit Key Format

```
rl:{endpoint}:{identifier}:{window}
```

Examples:
- `rl:lookup:192.168.1.1:1695369600` (IP-based)
- `rl:claim:user123:1695369600` (user-based)
- `rl:admin:admin456:1695369600` (admin-based)

---

## Audit Logging

### What Gets Logged

| Action | Entity | Details |
|--------|--------|---------|
| `sku.create` | SKU | code, name |
| `sku.update` | SKU | changed fields |
| `sku.deactivate` | SKU | — |
| `batch.create` | Batch | sku_id, quantity |
| `batch.generate` | Batch | generated_count |
| `qr.claim` | Product QR | customer_id, short_code |
| `qr.activate` | Product QR | destination_url |
| `qr.disable` | Product QR | reason (optional) |
| `qr.retire` | Product QR | reason (optional) |
| `qr.destination.update` | Product QR | old_url, new_url |

### Audit Log Entry Structure

```json
{
  "id": "uuid",
  "actor_id": "user-uuid",
  "action": "qr.claim",
  "entity_type": "product_qr",
  "entity_id": "qr-uuid",
  "details_json": "{\"customer_id\": \"...\", \"short_code\": \"A7kP92x\"}",
  "ip_address": "192.168.1.1",
  "created_at": 1695369600000
}
```

### Audit Log Protection

- Only admins can read audit logs
- Audit logs cannot be modified or deleted
- Audit log writes are append-only
- IP address captured for traceability

---

## Data Protection

### Sensitive Data

| Data | Protection |
|------|-----------|
| User emails | Never exposed in QR details to other users |
| Session tokens | HttpOnly cookie, never in URL or response body |
| Magic link tokens | SHA-256 hashed, single-use, 15-min TTL |
| Customer ownership | Verified server-side, never trusted from client |

### SQL Injection Prevention

- All queries use parameterized statements (`db.prepare().bind()`)
- No string concatenation in SQL
- D1 automatically escapes parameters

### XSS Prevention

- Server-side JSX (hono/jsx) auto-escapes output
- Client islands use `textContent` (not `innerHTML`) for user data
- CSP headers set via Cloudflare Workers

### CSRF Prevention

- SameSite=Lax on session cookie
- State-changing operations use POST/PATCH/DELETE (not GET)
- Origin/Referer header validation (optional, for extra protection)

---

## Short Code Security

### Generation

- 7-character base62 (62^7 ≈ 3.5 trillion combinations)
- Cryptographically secure RNG (`crypto.getRandomValues`)
- Rejection sampling for uniform distribution
- Collision check against both `qr_codes` and `product_qr`

### Immutability

- Short codes never change after generation
- Cannot be reassigned or recycled
- Retired QR codes keep their short codes forever

### Enumeration Prevention

- Short codes are not predictable
- Rate limiting on lookup endpoint
- 404 for unknown codes (not "not found in product_qr")

---

## Infrastructure Security

### Cloudflare Workers

- Runs in V8 isolates (sandboxed)
- No filesystem access
- No network access beyond fetch
- Automatic HTTPS on all routes

### D1 Database

- Encrypted at rest
- Automatic backups
- Access via binding only (no external access)

### KV Namespaces

- Encrypted at rest
- eventual consistency (acceptable for cache)

### R2 Storage

- Encrypted at rest
- Access via binding only

---

## Security Checklist

### Pre-Launch

- [ ] All admin endpoints behind `requireAdmin` middleware
- [ ] All customer endpoints verify ownership
- [ ] IDOR protection on all QR access
- [ ] Atomic claim operation (no race conditions)
- [ ] Destination URL validation (no SSRF)
- [ ] Rate limiting on all public endpoints
- [ ] Audit logging for all state changes
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (auto-escaping JSX)
- [ ] Session security (HttpOnly, SameSite)
- [ ] Short code uniqueness and immutability
- [ ] Error messages don't leak sensitive info

### Ongoing

- [ ] Monitor audit logs for suspicious activity
- [ ] Review rate limiting thresholds
- [ ] Check for new D1/KV security features
- [ ] Rotate secrets periodically
