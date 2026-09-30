import { Hono } from "hono";
import { raw } from "hono/html";
import type { FC, Child } from "hono/jsx";
import type { Bindings } from "../types";
import type { DynamicPageKind, DynamicPageRow, QrRow } from "../db/queries";
import { getDynamicPageBySlug } from "../db/queries";
import { readCookie } from "../lib/auth/session";
import { SCAN_COOKIE } from "../lib/analytics";
import { Layout } from "../ui/layout";
import { Icon } from "../ui/icons";
import type { IconName } from "../ui/icons";

/**
 * Public hosted dynamic landing pages, served at /p/:slug.
 *
 * The slug is the QR's short_code. The printed QR encodes /r/<short_code>, which
 * 302s to /p/<short_code> — so editing the page content here never changes the
 * printed code. Each scan is logged by the /r/:code redirect (see routes/redirect.ts);
 * /p/:slug is purely the destination target, so no scan logging happens here.
 *
 * These pages are PUBLIC (no auth). They are token-styled, mobile-first and
 * dark-mode correct — they reuse the shared Layout and the design-token CSS.
 */
export const pages = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Data shapes (parsed from dynamic_pages.data_json). Every field is optional on
// the wire so a partially-filled page still renders gracefully.
// ---------------------------------------------------------------------------

interface MenuItem {
  name?: string;
  description?: string;
  price?: string;
}
interface MenuSection {
  title?: string;
  items?: MenuItem[];
}
interface MenuData {
  title?: string;
  subtitle?: string;
  currency?: string;
  sections?: MenuSection[];
}

interface BusinessData {
  name?: string;
  title?: string;
  company?: string;
  bio?: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  mapUrl?: string;
}

interface SocialLink {
  label?: string;
  url?: string;
  /** optional icon name; falls back to the generic link glyph */
  icon?: IconName;
}
interface SocialData {
  name?: string;
  bio?: string;
  avatar?: string;
  links?: SocialLink[];
}

interface AppStoreData {
  appName?: string;
  tagline?: string;
  icon?: string;
  iosUrl?: string;
  androidUrl?: string;
  fallbackUrl?: string;
}

interface PdfData {
  title?: string;
  description?: string;
  /** public URL or data URI for the PDF asset */
  fileUrl?: string;
  fileName?: string;
}

// ---------------------------------------------------------------------------
// Shared landing chrome
// ---------------------------------------------------------------------------

/** Outer wrapper for every hosted page: centered, mobile-first column. */
const PageShell: FC<{ children: Child }> = ({ children }) => (
  <main class="lp">
    <div class="lp-inner">{children}</div>
    <p class="lp-footer t-caption text-tertiary">
      Powered by <span class="lp-footer-brand">quoda</span> — the QR code that never breaks.
    </p>
  </main>
);

/** A safe external-link button used across the landing kinds. */
const LinkButton: FC<{ href: string; icon?: IconName; children: Child; primary?: boolean }> = ({
  href,
  icon,
  children,
  primary,
}) => (
  <a
    class={primary ? "lp-btn lp-btn-primary" : "lp-btn"}
    href={href}
    rel="noopener noreferrer"
    target="_blank"
  >
    {icon ? (
      <span class="lp-btn-icon">
        <Icon name={icon} size={18} />
      </span>
    ) : null}
    <span class="lp-btn-label">{children}</span>
  </a>
);

// ---------------------------------------------------------------------------
// Per-kind renderers
// ---------------------------------------------------------------------------

const MenuPage: FC<{ data: MenuData; fallbackTitle: string }> = ({ data, fallbackTitle }) => {
  const sections = data.sections ?? [];
  return (
    <>
      <header class="lp-head">
        <h1 class="lp-title t-display-md">{data.title || fallbackTitle}</h1>
        {data.subtitle ? <p class="lp-subtitle t-body text-secondary">{data.subtitle}</p> : null}
      </header>
      {sections.length === 0 ? (
        <p class="lp-empty t-body text-secondary">This menu is being prepared.</p>
      ) : (
        <div class="lp-menu">
          {sections.map((section) => (
            <section class="lp-menu-section">
              {section.title ? <h2 class="lp-menu-section-title t-heading-sm">{section.title}</h2> : null}
              <ul class="lp-menu-items">
                {(section.items ?? []).map((item) => (
                  <li class="lp-menu-item">
                    <div class="lp-menu-item-main">
                      <span class="lp-menu-item-name t-body">{item.name}</span>
                      {item.description ? (
                        <span class="lp-menu-item-desc t-body-sm text-secondary">{item.description}</span>
                      ) : null}
                    </div>
                    {item.price ? (
                      <span class="lp-menu-item-price t-body tnum">
                        {data.currency ? `${data.currency}${item.price}` : item.price}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
};

const BusinessPage: FC<{ data: BusinessData; fallbackTitle: string }> = ({ data, fallbackTitle }) => {
  const name = data.name || fallbackTitle;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  const subline = [data.title, data.company].filter(Boolean).join(" · ");
  return (
    <>
      <header class="lp-head lp-head-center">
        <div class="lp-avatar lp-avatar-initials" aria-hidden="true">
          {initials || "•"}
        </div>
        <h1 class="lp-title t-display-md">{name}</h1>
        {subline ? <p class="lp-subtitle t-body text-secondary">{subline}</p> : null}
        {data.bio ? <p class="lp-bio t-body text-secondary">{data.bio}</p> : null}
      </header>
      <div class="lp-actions">
        {data.phone ? (
          <LinkButton href={`tel:${data.phone}`} icon="tel" primary>
            Call
          </LinkButton>
        ) : null}
        {data.email ? (
          <LinkButton href={`mailto:${data.email}`} icon="email">
            Email
          </LinkButton>
        ) : null}
        {data.website ? (
          <LinkButton href={data.website} icon="link">
            Website
          </LinkButton>
        ) : null}
        {data.mapUrl || data.address ? (
          <LinkButton
            href={data.mapUrl || `https://maps.google.com/?q=${encodeURIComponent(data.address ?? "")}`}
            icon="business"
          >
            {data.address || "View on map"}
          </LinkButton>
        ) : null}
      </div>
    </>
  );
};

const SocialPage: FC<{ data: SocialData; fallbackTitle: string }> = ({ data, fallbackTitle }) => {
  const name = data.name || fallbackTitle;
  const links = data.links ?? [];
  return (
    <>
      <header class="lp-head lp-head-center">
        {data.avatar ? (
          <img class="lp-avatar" src={data.avatar} alt={name} width="88" height="88" />
        ) : (
          <div class="lp-avatar lp-avatar-initials" aria-hidden="true">
            {(name[0] ?? "•").toUpperCase()}
          </div>
        )}
        <h1 class="lp-title t-display-md">{name}</h1>
        {data.bio ? <p class="lp-bio t-body text-secondary">{data.bio}</p> : null}
      </header>
      {links.length === 0 ? (
        <p class="lp-empty t-body text-secondary">No links yet.</p>
      ) : (
        <div class="lp-actions lp-actions-stacked">
          {links.map((link) =>
            link.url ? (
              <LinkButton href={link.url} icon={link.icon ?? "link"}>
                {link.label || link.url}
              </LinkButton>
            ) : null,
          )}
        </div>
      )}
    </>
  );
};

const AppStorePage: FC<{ data: AppStoreData; fallbackTitle: string; slug: string }> = ({
  data,
  fallbackTitle,
  slug,
}) => {
  const appName = data.appName || fallbackTitle;
  // Smart store routing: redirect to the right store by platform on load, with
  // visible buttons as the no-JS / desktop fallback.
  const smartRedirect = `(function(){try{var ua=navigator.userAgent||'';var ios=/iPad|iPhone|iPod/.test(ua);var android=/Android/.test(ua);var ios_url=${JSON.stringify(
    data.iosUrl ?? "",
  )};var and_url=${JSON.stringify(data.androidUrl ?? "")};var fb=${JSON.stringify(
    data.fallbackUrl ?? "",
  )};var to='';if(ios&&ios_url)to=ios_url;else if(android&&and_url)to=and_url;else if(fb)to=fb;if(to)window.location.replace(to);}catch(e){}})();`;
  return (
    <>
      <header class="lp-head lp-head-center">
        {data.icon ? (
          <img class="lp-app-icon" src={data.icon} alt={appName} width="96" height="96" />
        ) : (
          <div class="lp-app-icon lp-app-icon-empty" aria-hidden="true">
            <Icon name="appstore" size={40} />
          </div>
        )}
        <h1 class="lp-title t-display-md">{appName}</h1>
        {data.tagline ? <p class="lp-subtitle t-body text-secondary">{data.tagline}</p> : null}
      </header>
      <div class="lp-actions lp-actions-stacked">
        {data.iosUrl ? (
          <LinkButton href={data.iosUrl} icon="appstore" primary>
            Download on the App Store
          </LinkButton>
        ) : null}
        {data.androidUrl ? (
          <LinkButton href={data.androidUrl} icon="appstore">
            Get it on Google Play
          </LinkButton>
        ) : null}
        {data.fallbackUrl ? (
          <LinkButton href={data.fallbackUrl} icon="link">
            Open on the web
          </LinkButton>
        ) : null}
      </div>
      {data.iosUrl || data.androidUrl || data.fallbackUrl ? (
        <script data-slug={slug} dangerouslySetInnerHTML={{ __html: smartRedirect }} />
      ) : null}
    </>
  );
};

const PdfPage: FC<{ data: PdfData; fallbackTitle: string }> = ({ data, fallbackTitle }) => {
  const title = data.title || fallbackTitle;
  return (
    <>
      <header class="lp-head lp-head-center">
        <div class="lp-app-icon lp-app-icon-empty" aria-hidden="true">
          <Icon name="pdf" size={40} />
        </div>
        <h1 class="lp-title t-display-md">{title}</h1>
        {data.description ? <p class="lp-subtitle t-body text-secondary">{data.description}</p> : null}
      </header>
      {data.fileUrl ? (
        <>
          <div class="lp-actions lp-actions-stacked">
            <LinkButton href={data.fileUrl} icon="download" primary>
              Download PDF
            </LinkButton>
          </div>
          <div class="lp-pdf-frame">
            <iframe
              class="lp-pdf-viewer"
              src={data.fileUrl}
              title={data.fileName || title}
              loading="lazy"
            />
          </div>
        </>
      ) : (
        <p class="lp-empty t-body text-secondary">This document is being prepared.</p>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function renderKind(kind: DynamicPageKind, raw_json: string, qr: QrRow, slug: string): Child {
  let data: unknown = {};
  try {
    data = JSON.parse(raw_json) as unknown;
  } catch {
    data = {};
  }
  const fallbackTitle = qr.title || "Sqanny";
  switch (kind) {
    case "menu":
      return <MenuPage data={data as MenuData} fallbackTitle={fallbackTitle} />;
    case "business":
      return <BusinessPage data={data as BusinessData} fallbackTitle={fallbackTitle} />;
    case "social":
      return <SocialPage data={data as SocialData} fallbackTitle={fallbackTitle} />;
    case "appstore":
      return <AppStorePage data={data as AppStoreData} fallbackTitle={fallbackTitle} slug={slug} />;
    case "pdf":
      return <PdfPage data={data as PdfData} fallbackTitle={fallbackTitle} />;
    default:
      return <p class="lp-empty t-body text-secondary">This page is unavailable.</p>;
  }
}

function pageTitle(kind: DynamicPageKind, data_json: string, qr: QrRow): string {
  try {
    const d = JSON.parse(data_json) as Record<string, unknown>;
    const candidate =
      (typeof d.name === "string" && d.name) ||
      (typeof d.title === "string" && d.title) ||
      (typeof d.appName === "string" && d.appName) ||
      "";
    if (candidate) return candidate;
  } catch {
    /* fall through */
  }
  return qr.title || "Sqanny";
}

pages.get("/p/:slug", async (c) => {
  const slug = c.req.param("slug");
  const found = await getDynamicPageBySlug(c.env.DB, slug);
  if (!found) {
    return c.text("Not Found", 404);
  }
  const { page, qr }: { page: DynamicPageRow; qr: QrRow } = found;

  // Ship the enrichment script ONLY when this request carries a fresh scan
  // correlation cookie. The cookie is HttpOnly, so the script cannot know this
  // itself — deciding here means an ordinary page view loads no tracker and
  // fires no request.
  const scanned = Boolean(readCookie(c.req.raw, SCAN_COOKIE));

  return c.html(
    <>
      {raw("<!DOCTYPE html>")}
      <Layout title={pageTitle(page.kind, page.data_json, qr)} bare>
        <PageShell>{renderKind(page.kind, page.data_json, qr, slug)}</PageShell>
        {scanned ? <script src="/js/enrich.js" defer /> : null}
      </Layout>
    </>,
  );
});
