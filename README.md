<div align="center">

# Sqanny

### The QR code that never breaks.

Open-source, self-hostable QR platform built entirely on Cloudflare.
Dynamic QR codes whose destination is editable forever — print once, re-target anytime — with built-in scan analytics.

</div>

---

## Why Sqanny

A printed QR code is permanent, but the thing it points to usually isn't. **Dynamic QR codes** solve this: the printed code encodes a short Sqanny link (`/r/<code>`) that you can re-point at any time. The sticker on your menu, poster, or business card never has to be reprinted.

- **Static QR** — classic codes that embed the data directly (URL, text, Wi-Fi, email, phone, SMS, vCard).
- **Dynamic QR** — editable destination + scan analytics. The printed code never changes.
- **Rich dynamic pages** — hosted landings for PDF, Menu, Business card, App-store smart links, and Social link-in-bio.
- **Customization** — colors, module shape, eye style, error correction, logo, frame label. Scannability is guarded automatically.
- **Analytics** — total scans, over time, by country and device.
- **Premium, accessible UI** — Apple-grade minimalism, first-class dark mode, WCAG AA. Design tokens compiled from a single source of truth.

## Architecture

A single [Hono](https://hono.dev) Worker, no framework runtime:

```
Worker (Hono + hono/jsx SSR)
├── /                 marketing + live generator
├── /app/*            dashboard, studio, analytics (magic-link auth)
├── /r/:code          dynamic-QR redirect (logs scan → 302 to current target)
├── /p/:slug          hosted rich landing pages
├── /api/*            JSON endpoints (preview, qr CRUD, analytics, upload)
└── bindings: D1 (SQL) · KV (scan counters / rate-limit / sessions) · R2 (exports, logos, assets)
```

- **Rendering:** server-side JSX SSR + dependency-free vanilla-TS islands (no React).
- **QR engine:** `qrcode-generator` for the matrix + a custom themed SVG renderer; PNG/PDF export client-side.
- **Auth:** passwordless magic link. In dev the link is printed to the console (zero email setup); in production it's sent via [Resend](https://resend.com) when `RESEND_API_KEY` is set.
- **Design system:** all colors/spacing/motion live in `docs/design/design-guideline.json`, compiled to `public/styles/tokens.css`. Components reference tokens only — never raw hex.

## Local development

Requires Node 18+ and npm. No external services needed for the core flows.

```bash
git clone https://github.com/canerdogan/quoda.git
cd quoda
npm install
npm run migrate:local      # apply D1 schema to the local database
npm run dev                # builds tokens + islands, then wrangler dev
```

Open <http://localhost:8787>. To sign in, enter any email on `/login` — the magic link is printed to the `wrangler dev` console with a `[DEV MAGIC LINK]` banner; open it to complete login.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Build tokens + islands, start `wrangler dev` |
| `npm test` | Unit/integration tests (Vitest + `@cloudflare/vitest-pool-workers`) |
| `npm run test:e2e` | Playwright E2E + QR scannability decode tests |
| `npm run typecheck` | Type-check worker + client |
| `npm run build:tokens` | Compile `design-guideline.json` → `tokens.css` |
| `npm run migrate:local` | Apply migrations to the local D1 |

## Self-hosting on Cloudflare

1. **Create the resources** (one-time), then put the returned IDs into `wrangler.jsonc`:

   ```bash
   npx wrangler d1 create sqanny
   npx wrangler kv namespace create SCAN_COUNTERS
   npx wrangler kv namespace create RATE_LIMIT
   npx wrangler kv namespace create SESSION_CACHE
   npx wrangler r2 bucket create sqanny-assets
   ```

2. **Apply the schema to the remote database:**

   ```bash
   npm run migrate:remote
   ```

3. **Set production config & secrets:**

   ```bash
   npx wrangler secret put RESEND_API_KEY      # optional — enables real magic-link emails
   # set "APP_URL" in wrangler.jsonc vars to your deployed URL (https://…)
   ```

4. **Deploy:**

   ```bash
   npm run deploy
   ```

`APP_URL` must be your public `https://` origin in production — it's embedded in magic links and dynamic-QR redirect targets, and it controls the `Secure` cookie flag.

## Project layout

```
migrations/0001_init.sql      D1 schema
scripts/build-tokens.mjs      design-guideline.json → tokens.css
scripts/build-client.mjs      bundle src/client/*.ts islands (IIFE)
src/
  index.tsx                   Hono app + route wiring
  db/queries.ts               typed D1 data access
  lib/qr/                      encoder · content builders · scannability · SVG renderer
  lib/auth/                    magic-link · sessions · email
  lib/analytics.ts             scan logging + aggregation
  routes/                      marketing · auth · dashboard · studio · qr-detail · redirect · pages · api/*
  ui/                          layout · app-shell · components · icons
  client/                      generator · studio · charts · theme islands
docs/design/                   DESIGN-GUIDELINE.md + machine-readable tokens
docs/superpowers/              spec + implementation plan
```

## Roadmap

- Billing for a hosted edition (the plan/limit architecture is already in place; checkout is intentionally stubbed).
- Bulk generation, team seats.

## License

[MIT](./LICENSE) © 2026 CHETNAVERSE AI SYSTEMS LLP
