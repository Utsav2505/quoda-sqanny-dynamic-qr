# Sqanny UI Migration Plan — React + Tailwind + shadcn/ui

## Executive Summary

Replace the entire Sqanny frontend UI system (Hono JSX + vanilla TypeScript) with a React + Tailwind CSS + shadcn/ui architecture, while preserving the Cloudflare Workers/Hono backend.

---

## Current State Analysis

### Architecture
| Layer | Current | Target |
|-------|---------|--------|
| Runtime | Cloudflare Workers | Cloudflare Workers (unchanged) |
| Backend | Hono | Hono (unchanged) |
| UI Rendering | Hono JSX (server-side) | React (client-side) |
| CSS | Hand-written CSS (87KB) | Tailwind CSS + shadcn/ui |
| Client Islands | Vanilla TypeScript (5 files) | React components |
| Build | esbuild (IIFE islands) | Vite (React app) |

### Current Components to Migrate
- 12 UI components (badge, button, card, footer, input, modal, nav, qr-preview, select, stat, textarea, toast)
- 4 shell/layout files (layout, app-shell, admin-shell, icons)
- 5 client islands (charts, generator, studio, theme, wallpaper)
- 22 route files (14 pages, 8 APIs)

### Key Constraints
1. `/r/:code` must remain a direct Worker redirect (no React)
2. Authentication must remain server-enforced
3. Must deploy on Cloudflare Workers
4. No separate frontend hosting

---

## Architecture Decision: React on Cloudflare

### Option A: React SPA served from Worker (CHOSEN)
```
Cloudflare Worker (Hono)
├── /api/*          → Hono API handlers
├── /r/:code        → Direct redirect (no React)
├── /p/:slug        → Direct redirect (no React)
├── /*              → Serve React SPA (static assets)
└── Static assets   → Built React app in ./dist
```

**Why this works:**
- Hono serves static assets via `./public` directory
- React app builds to `./public` (or `./dist`)
- Worker handles API routes first, falls through to static assets
- `/r/:code` is a direct Worker route, never touches React
- No separate hosting needed

### Option B: React on Cloudflare Pages (NOT chosen)
- Would require separate deployment
- More complex CI/CD
- Not necessary for this project

---

## Implementation Phases

### Phase 1: Foundation Setup (Days 1-2)

#### 1.1 Add React + Tailwind Dependencies
```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "hono": "^4.6.14",
    "qrcode-generator": "^1.4.4"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "vite": "^5.4.0",
    "wrangler": "4.12.1"
  }
}
```

#### 1.2 Configure Tailwind
- `tailwind.config.js` with Sqanny design tokens
- `postcss.config.js`
- Update `src/styles/globals.css` with Tailwind directives

#### 1.3 Setup shadcn/ui
- Initialize shadcn/ui
- Configure component paths
- Add core components: Button, Input, Card, Dialog, Table, Badge, etc.

#### 1.4 Vite Configuration
- `vite.config.ts` for React build
- Output to `./dist` for Cloudflare Workers
- Configure for Workers compatibility

---

### Phase 2: Application Shell (Days 3-4)

#### 2.1 React App Entry Point
- `src/app/main.tsx` — React entry
- `src/app/App.tsx` — Root component with routing
- `src/app/router.tsx` — React Router configuration

#### 2.2 Layout Components
Using shadcn/ui patterns:
- `src/components/layout/app-shell.tsx` — Authenticated layout
- `src/components/layout/admin-shell.tsx` — Admin layout with sidebar
- `src/components/layout/marketing-shell.tsx` — Marketing pages
- `src/components/layout/sidebar.tsx` — shadcn Sidebar
- `src/components/layout/header.tsx` — Top navigation

#### 2.3 Authentication Integration
- Keep server-side auth in Hono
- React fetches `/api/auth/me` to get current user
- Auth context provides user state
- Protected routes check auth client-side (server enforces)

---

### Phase 3: Admin UI (Days 5-8)

#### 3.1 Admin Dashboard
- Stats cards (shadcn Card)
- Recent batches table (shadcn Table)
- Quick actions

#### 3.2 SKU Management
- SKU list with shadcn Data Table
- Create/Edit SKU forms (shadcn Form + Input)
- SKU detail page

#### 3.3 Batch Management
- Batch list with status badges
- Create batch form (SKU selector + quantity)
- Batch detail with progress bar
- Generated QR codes list

#### 3.4 QR Inventory (Critical)
- shadcn Data Table with:
  - Server-side pagination
  - Search (serial, short code, SKU, customer)
  - Filters (SKU, batch, status, date)
  - Sorting (newest, serial, status)
- QR detail page with:
  - QR preview (canonical renderer)
  - Status management
  - Customer info
  - Destination URL

#### 3.5 Customer Management
- Customer list
- Customer detail with their QR codes

#### 3.6 Audit Log
- Audit log table with filters

---

### Phase 4: QR Editor + Canonical Rendering (Days 9-11)

#### 4.1 QR Configuration Schema
```typescript
interface QrConfig {
  type: QrType;
  content: Record<string, string>;
  design: {
    foreground: string;
    background: string;
    moduleShape: 'square' | 'dots' | 'rounded';
    eyeStyle: 'square' | 'rounded' | 'circle';
    ecc: 'L' | 'M' | 'Q' | 'H';
    logo?: string;
    logoSize: number;
    frame?: string;
    margin: number;
  };
}
```

#### 4.2 Canonical QR Renderer
- Single React component: `<QRPreview config={config} />`
- Uses existing `src/lib/qr/` engine (keep server-side for SVG generation)
- API endpoint: `POST /api/qr/render` returns SVG
- Same renderer used in:
  - Editor preview
  - Saved QR detail
  - Export (SVG/PNG/PDF)
  - Inventory list thumbnails

#### 4.3 QR Editor UI
```
┌───────────────────────────────────────────────┐
│ Breadcrumbs: QR Editor                        │
├───────────────────────┬───────────────────────┤
│ Configuration         │ Live Preview          │
│                       │                       │
│ [Type Selector]       │   ┌─────────────┐     │
│ [Content Fields]      │   │             │     │
│                       │   │  QR CODE    │     │
│ [Design Section]      │   │             │     │
│  - Colors             │   └─────────────┘     │
│  - Module Shape       │                       │
│  - Eye Style          │   [Export Buttons]     │
│  - Logo Upload        │   - SVG               │
│  - Frame              │   - PNG               │
│  - Margin             │   - PDF               │
│                       │                       │
│ [Save Button]         │                       │
└───────────────────────┴───────────────────────┘
```

#### 4.4 QR Export
- SVG: Direct download from API
- PNG: Canvas rendering from SVG
- PDF: Existing PDF builder (keep vanilla TS logic)

---

### Phase 5: Customer UI (Days 12-14)

#### 5.1 Customer Dashboard
- My stands list
- Quick actions

#### 5.2 Claim Flow
- Step 1: Scan/enter QR code
- Step 2: Verify code
- Step 3: Confirm claim
- Step 4: Configure destination

#### 5.3 Stand Management
- Stand detail
- Destination editor
- Status management

---

### Phase 6: Marketing + Auth Pages (Days 15-16)

#### 6.1 Marketing Pages
- Homepage with live generator
- Features, Pricing, Use Cases, Docs

#### 6.2 Authentication
- Login page (magic link)
- Verification handling
- Logout

---

### Phase 7: Polish + React Bits (Days 17-18)

#### 7.1 Micro-interactions
- Page transitions
- Loading states
- Hover effects
- Toast notifications

#### 7.2 Responsive Design
- Mobile sidebar → sheet/drawer
- Responsive tables
- Mobile-first forms

---

### Phase 8: Cleanup + Testing (Days 19-20)

#### 8.1 Remove Old UI
- Delete old Hono JSX components
- Remove unused CSS
- Clean up dead code

#### 8.2 Testing
- Unit tests for React components
- Integration tests for API calls
- E2E tests with Playwright
- Verify Cloudflare deployment

---

## Component Migration Map

### shadcn/ui Components to Add
| Sqanny Component | shadcn Replacement |
|-----------------|-------------------|
| `button.tsx` | `Button` |
| `input.tsx` | `Input` |
| `textarea.tsx` | `Textarea` |
| `select.tsx` | `Select` |
| `card.tsx` | `Card` |
| `badge.tsx` | `Badge` |
| `modal.tsx` | `Dialog` |
| `toast.tsx` | `Sonner` |
| `nav.tsx` | `Sidebar` + `NavigationMenu` |
| `stat.tsx` | Custom (Card + Typography) |
| `qr-preview.tsx` | Custom (uses QR API) |

### Custom Components to Build
| Component | Purpose |
|-----------|---------|
| `QRPreview` | Canonical QR renderer |
| `QREditor` | QR configuration editor |
| `QRTypeSelector` | QR type picker |
| `QRDesignConfig` | Design options panel |
| `BatchProgress` | Generation progress |
| `StatusBadge` | QR lifecycle status |
| `DataTable` | shadcn Data Table wrapper |
| `SearchInput` | Debounced search |
| `FilterDropdown` | Multi-select filter |

---

## File Structure Target

```
src/
├── app/                    # React app
│   ├── main.tsx           # Entry point
│   ├── App.tsx            # Root component
│   ├── router.tsx         # React Router
│   └── providers.tsx      # Context providers
├── components/            # React components
│   ├── ui/               # shadcn/ui components
│   ├── layout/           # Layout shells
│   ├── admin/            # Admin-specific
│   ├── customer/         # Customer-specific
│   ├── qr/               # QR-related
│   └── shared/           # Shared components
├── hooks/                 # Custom hooks
├── lib/                   # Utilities
│   ├── api.ts            # API client
│   ├── auth.ts           # Auth helpers
│   └── qr.ts             # QR config types
├── styles/                # CSS
│   └── globals.css       # Tailwind + custom
├── types/                 # TypeScript types
└── routes/               # Hono API routes (unchanged)
    ├── api/
    └── ...
```

---

## Deployment Architecture

```
npm run build
    ↓
Vite builds React app → ./dist
    ↓
Wrangler deploys:
    - src/index.tsx (Hono Worker)
    - ./dist (static React assets)
    ↓
Cloudflare Worker serves:
    - /api/* → Hono handlers
    - /r/:code → Direct redirect
    - /* → React SPA from ./dist
```

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| React bundle size | Code splitting, lazy loading |
| Cold start performance | Keep Worker small, lazy load React |
| QR redirect performance | Direct Worker route, no React |
| Auth security | Server-side enforcement, React reads session |
| Build complexity | Vite + Wrangler integration |
| CSS migration | Tailwind incremental adoption |

---

## Success Criteria

- [ ] React is the primary UI layer
- [ ] shadcn/ui used for all standard components
- [ ] Tailwind CSS for styling
- [ ] Hono remains backend
- [ ] Cloudflare Workers deployment works
- [ ] `/r/:code` remains direct redirect
- [ ] Authentication server-enforced
- [ ] QR short codes immutable
- [ ] QR config persists correctly
- [ ] QR editor/detail/export use same renderer
- [ ] Logos persist correctly
- [ ] Admin UI fully modernized
- [ ] Customer UI modernized
- [ ] Responsive design works
- [ ] Old UI code removed
- [ ] Tests pass
- [ ] Production build works
