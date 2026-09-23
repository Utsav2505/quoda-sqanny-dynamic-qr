# 01 — Current Architecture

## Overview

Sqanny is a **single Cloudflare Worker monolith** using the Hono framework with server-side JSX rendering and vanilla TypeScript client islands. There is no separate frontend/backend — everything runs in one Worker.

## Runtime Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (V8 isolates) |
| HTTP Framework | Hono v4 |
| SSR | hono/jsx (server-side JSX, no React runtime) |
| Client Islands | Vanilla TypeScript (bundled via esbuild as IIFE) |
| Database | Cloudflare D1 (SQLite at edge) |
| Cache | Cloudflare KV (3 namespaces) |
| Storage | Cloudflare R2 |
| AI | Cloudflare Workers AI |
| Build | esbuild (client islands), custom scripts (tokens) |

## Directory Structure

```
quoda-sqanny-dynamic-qr/
├── src/
│   ├── index.tsx              # App entry, route wiring
│   ├── types.ts               # Bindings, QrType, Ecc types
│   ├── client/                # Client-side vanilla TS islands
│   │   ├── generator.ts       # Marketing live QR preview
│   │   ├── studio.ts          # Full QR editor
│   │   ├── charts.ts          # Analytics charts
│   │   ├── theme.ts           # Dark/light toggle
│   │   └── wallpaper.ts       # AI wallpaper canvas
│   ├── db/
│   │   └── queries.ts         # All D1 typed queries
│   ├── lib/
│   │   ├── shortcode.ts       # Base62 short code generator
│   │   ├── plans.ts           # Plan limits + gate logic
│   │   ├── analytics.ts       # Scan logging (KV + D1)
│   │   ├── qr/                # QR engine
│   │   │   ├── types.ts       # QrDesign, QrFields
│   │   │   ├── encoder.ts     # qrcode-generator → matrix
│   │   │   ├── content.ts     # buildPayload per type
│   │   │   ├── scannability.ts # WCAG contrast + safe palette
│   │   │   └── render-svg.ts  # Matrix → SVG
│   │   ├── auth/
│   │   │   ├── session.ts     # Cookie sessions (KV + D1)
│   │   │   ├── magic-link.ts  # Token issue/verify
│   │   │   └── email.ts       # Resend sender
│   │   └── ai/
│   │       ├── brand.ts       # Brand Match pipeline
│   │       └── wallpaper.ts   # AI wallpaper generation
│   ├── middleware/
│   │   └── auth.ts            # loadUser + requireAuth
│   ├── routes/
│   │   ├── marketing.tsx      # /, /features, /pricing, etc.
│   │   ├── auth.tsx           # /login, /auth/verify, /auth/logout
│   │   ├── dashboard.tsx      # /app (QR list)
│   │   ├── studio.tsx         # /app/new, /app/:id/edit
│   │   ├── qr-detail.tsx     # /app/:id (QR info + analytics)
│   │   ├── settings.tsx       # /app/settings
│   │   ├── onboarding.tsx     # /onboarding (3-step first QR)
│   │   ├── pages.tsx          # /p/:slug (hosted landing pages)
│   │   ├── redirect.ts        # /r/:code (dynamic QR redirect)
│   │   ├── wallpaper.tsx      # /wallpaper
│   │   ├── styleguide.tsx     # /styleguide
│   │   └── api/
│   │       ├── preview.ts     # POST /api/preview
│   │       ├── brand.ts       # POST /api/brand
│   │       ├── wallpaper.ts   # POST /api/wallpaper
│   │       ├── qr.ts          # CRUD /api/qr
│   │       ├── analytics.ts   # GET /api/qr/:id/analytics
│   │       └── upload.ts      # POST /api/upload, GET /assets/:key
│   └── ui/
│       ├── layout.tsx         # HTML document shell
│       ├── app-shell.tsx      # Authenticated wrapper
│       ├── icons.tsx          # 28 inline SVG icons
│       └── components/        # 12 reusable JSX components
├── migrations/
│   └── 0001_init.sql          # D1 schema (8 tables)
├── public/
│   ├── js/                    # Client island bundles
│   └── styles/                # tokens.css, base.css, app.css, new-ui.css
├── scripts/
│   ├── build-tokens.mjs       # DESIGN.md → tokens.css
│   ├── build-client.mjs       # esbuild client islands
│   └── generate-new-ui-css.mjs
├── tests/                     # Vitest + Playwright tests
└── docs/                      # Design docs
```

## Database Schema (D1)

Eight tables in `migrations/0001_init.sql`:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `plans` | Plan definitions | id, name, limits_json |
| `users` | User accounts | id, email (unique), plan_id, onboarded_at |
| `sessions` | Auth sessions | id, user_id, expires_at |
| `magic_links` | One-time auth tokens | token_hash (PK), email, expires_at, consumed_at |
| `folders` | QR organization | id, user_id, name |
| `qr_codes` | QR records | id, user_id, type, title, is_dynamic, short_code (unique), destination, content_json, design_json, folder_id |
| `dynamic_pages` | Landing page data | qr_id (PK), kind, data_json, asset_keys |
| `scans` | Raw scan events | id, qr_id, ts, country, city, device, referer |
| `scan_daily` | Daily aggregates | qr_id, day, country, device, count (composite PK) |

**Key design notes:**
- Plan lives on `users`, not `qr_codes`
- Content and design are JSON strings (flexible schema)
- Dynamic QR types get a landing page in `dynamic_pages`
- Scans use dual-write: raw row in D1 + daily aggregate counter in KV

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | All persistent data |
| `SCAN_COUNTERS` | KV | Hot-path scan counters |
| `RATE_LIMIT` | KV | IP-based rate limiting |
| `SESSION_CACHE` | KV | Session cache (10-min TTL) |
| `ASSETS_BUCKET` | R2 | Logo/image uploads |
| `AI` | Workers AI | Vision + text + image models |

## Route Architecture

Routes are defined as Hono sub-apps in `src/routes/` and mounted in `src/index.tsx`:

```typescript
// Public APIs
app.route("/", previewApi);    // POST /api/preview
app.route("/", brandApi);      // POST /api/brand
app.route("/", wallpaperApi);  // POST /api/wallpaper
app.route("/", qrApi);        // /api/qr*
app.route("/", analyticsApi); // /api/qr/:id/analytics
app.route("/", uploadApi);    // POST /api/upload, GET /assets/:key

// Auth + onboarding
app.route("/", auth);         // /login, /auth/verify, /auth/logout
app.route("/", onboarding);   // /onboarding*

// App pages (requireAuth guards themselves)
app.route("/", dashboard);    // /app
app.route("/", settings);     // /app/settings
app.route("/", studio);       // /app/new, /app/:id/edit
app.route("/", qrDetail);     // /app/:id

// Dynamic QR + hosted pages
app.route("/", redirect);     // /r/:code
app.route("/", pages);        // /p/:slug

// Marketing (catch-all, registered last)
app.route("/", marketing);    // /, /features, /pricing, etc.
```

**Route registration order matters** — static segments before parameterized routes.

## Authentication System

- **Passwordless magic link** — no passwords
- Token: 32-byte random hex, SHA-256 hashed, stored in D1
- 15-minute TTL, single-use (atomic consume via conditional UPDATE)
- Session: 30-day cookie (`sqanny_session`), dual-stored in D1 + KV cache
- `loadUser` middleware: reads cookie → KV cache → D1 fallback → sets `c.set("user", ...)`
- `requireAuth` middleware: calls loadUser, redirects to `/login` if no user

## QR Engine

Located in `src/lib/qr/`:

1. **`content.ts`** — `buildPayload(type, fields)` encodes type-specific content (URL, Wi-Fi, vCard, etc.)
2. **`encoder.ts`** — `encodeMatrix(text, ecc)` uses qrcode-generator to produce a boolean[][] matrix
3. **`render-svg.ts`** — `renderSvg(matrix, design)` converts matrix to SVG with module shapes, eye styles, logo, frame
4. **`scannability.ts`** — WCAG contrast ratio, safe palette enforcement

**Short code generation:** `src/lib/shortcode.ts` — base62 (7 chars), cryptographically random, collision-checked via D1 lookup.

## Client Islands

Vanilla TypeScript files bundled via esbuild to IIFE format in `public/js/`:

| Island | Page | Purpose |
|--------|------|---------|
| `generator.ts` | Marketing home | Live QR preview, Brand Match |
| `studio.ts` | /app/new, /app/:id/edit | Full QR editor, save, export |
| `charts.ts` | /app/:id | Analytics line/bar charts |
| `theme.ts` | All pages | Dark/light toggle |
| `wallpaper.ts` | /wallpaper | AI wallpaper canvas compositor |

**Pattern:** Server renders HTML shell + initial state → client island hydrates specific DOM nodes with event listeners and fetch calls.

## CSS System

- **`tokens.css`** — auto-generated from `DESIGN.md` YAML frontmatter
- **`base.css`** — reset, focus rings, type scale utilities
- **`app.css`** — ~2900 lines of component styles
- **`new-ui.css`** — auto-generated component variants

All colors use CSS custom properties. Raw hex is banned except in documented exceptions (QR render, scannability constants, email HTML, favicon).

## Design System Components

12 JSX components in `src/ui/components/`:
`badge`, `button`, `card`, `footer`, `input`, `modal`, `nav`, `qr-preview`, `select`, `stat`, `textarea`, `toast`

28 inline SVG icons in `src/ui/icons.tsx`.

## Testing

- **Vitest** + `@cloudflare/vitest-pool-workers` for unit/integration tests
- **Playwright** for E2E browser tests
- Tests run in Cloudflare Workers-compatible environment

## Key Constraints

1. No React — server JSX via hono/jsx, client islands via vanilla TS
2. No external database — D1 only
3. No Node.js dependencies — Workers-compatible only
4. All AI calls have safe fallbacks
5. QR scannability is invariant — dark modules on white always
6. Analytics logging is best-effort (waitUntil, never blocks redirects)
