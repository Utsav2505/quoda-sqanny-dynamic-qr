# ChetnaVerse Rebranding Guide

This document lists all the locations in the repository where the "Quoda" branding (or its variations) is currently used. When rebranding the project for your own product, you will need to review and update these files.

## 1w. Project Configuration & Metadata
These files contain the project name, repository URLs, author info, and domain names.
- [ ] `package.json` (Project name, description, author)
- [ ] `package-lock.json` (Project name references)
- [ ] `wrangler.jsonc` (Cloudflare Worker name, D1 database name, custom domains)
- [ ] `README.md` (Project title, documentation, commands)

## 2. Core UI, Layouts & Components
These files contain visible branding elements like the logo, navigation titles, page metadata (title/description tags), and footer text.
- [ ] `src/ui/layout.tsx` (Global page titles, meta tags)
- [ ] `src/ui/icons.tsx` (Quoda logo SVG, favicon paths)
- [ ] `src/ui/components/nav.tsx` (Navbar branding and logo link)
- [ ] `src/ui/components/footer.tsx` (Copyright text, links)

## 3. Routes & Pages
These files contain page-specific headings, marketing copy, and UI text referencing the brand.
- [ ] `src/index.tsx`
- [ ] `src/routes/marketing.tsx` (Landing page copy, hero text)
- [ ] `src/routes/onboarding.tsx`
- [ ] `src/routes/auth.tsx`
- [ ] `src/routes/pages.tsx`
- [ ] `src/routes/settings.tsx`
- [ ] `src/routes/studio.tsx`
- [ ] `src/routes/styleguide.tsx`
- [ ] `src/routes/wallpaper.tsx`
- [ ] `src/routes/api/qr.ts`

## 4. Libraries & Client Scripts
These contain backend logic, email templates, and AI prompts that might hardcode the brand name.
- [ ] `src/lib/auth/email.ts` (Magic link email subject, from address, HTML template)
- [ ] `src/lib/auth/session.ts` (Cookie names, e.g., `quoda_session`)
- [ ] `src/lib/ai/brand.ts` (AI prompts generating branded assets)
- [ ] `src/client/studio.ts` (Client-side logic potentially referencing brand elements)
- [ ] `src/client/wallpaper.ts`

## 5. Styling & Assets
CSS files might have specific class names or comments referencing the brand.
- [ ] `public/styles/app.css`
- [ ] `public/styles/base.css`
- *Note:* Also remember to replace the actual images/icons in the `public/` directory (e.g., favicons).

## 6. Database Migrations
- [ ] `migrations/0001_init.sql` (Check if any default seeded data contains the brand name)

## 7. Tests
Update tests to match your new branding text so they don't fail.
- [ ] `tests/marketing.test.ts`
- [ ] `tests/content.test.ts`
- [ ] `tests/auth.test.ts`
- [ ] `tests/auth-routes.test.ts`
- [ ] `tests/qr-encoder.test.ts`
- [ ] `tests/render-svg.test.ts`
- [ ] `tests/e2e/decode.spec.ts`

## 8. Existing Documentation (Optional)
These are historical design docs and specs. You can likely delete these or ignore them.
- [ ] `docs/design/DESIGN-GUIDELINE.md`
- [ ] `docs/design/design-guideline.json`
- [ ] `docs/superpowers/specs/2026-06-07-quoda-design.md`
- [ ] `docs/superpowers/plans/2026-06-07-quoda-build.md`
