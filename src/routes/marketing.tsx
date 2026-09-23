import { Hono } from "hono";
import { raw } from "hono/html";
import type { FC, PropsWithChildren, Child } from "hono/jsx";
import type { Bindings } from "../types";
import { Layout } from "../ui/layout";
import { Nav } from "../ui/components/nav";
import { Footer } from "../ui/components/footer";
import { Card } from "../ui/components/card";
import { Badge } from "../ui/components/badge";
import { Button } from "../ui/components/button";
import { Input } from "../ui/components/input";
import { Icon } from "../ui/icons";
import type { IconName } from "../ui/icons";
import { encodeMatrix } from "../lib/qr/encoder";
import { renderSvg } from "../lib/qr/render-svg";
import { getLimits } from "../lib/plans";

export const marketing = new Hono<{ Bindings: Bindings }>();

// Brand-invariant palette for the placeholder QR (dark modules on white). This
// is exported image markup, so literal hex is correct here.
const PLACEHOLDER_DESIGN = {
  fg: "#0D0D0F",
  bg: "#FFFFFF",
  moduleShape: "square" as const,
  eyeStyle: "square" as const,
  ecc: "M" as const,
  margin: 4,
};

// A real, scannable QR pointing at the product — shown before the user types so
// the hero never renders empty. Built at module-load (deterministic, no I/O).
const PLACEHOLDER_QR_SVG = renderSvg(
  encodeMatrix("https://getsqanny.com", PLACEHOLDER_DESIGN.ecc),
  PLACEHOLDER_DESIGN,
);

// --------------------------------------------------------------- Page chrome

const MARKETING_LINKS = [
  { label: "Features", href: "/features" },
  { label: "Wallpaper", href: "/wallpaper" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
];

type ActiveKey = "" | "features" | "pricing" | "use-cases" | "docs";

const SiteShell: FC<
  PropsWithChildren<{ title?: string; description?: string; active?: ActiveKey }>
> = ({ title, description, active = "", children }) => (
  <>
    {raw("<!DOCTYPE html>")}
    <Layout title={title} description={description}>
      <div class="page">
        <Nav
          brandHref="/"
          links={MARKETING_LINKS.map((l) => ({
            ...l,
            active: active !== "" && l.href === `/${active}`,
          }))}
          cta={{ label: "Make it permanent", href: "/login" }}
        />
        <main class="page-main">{children}</main>
        <Footer />
      </div>
    </Layout>
  </>
);

const FeatureCard: FC<{ icon: IconName; title: string; body: string }> = ({
  icon,
  title,
  body,
}) => (
  <Card>
    <div class="feature">
      <span class="feature-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <h3 class="feature-title t-heading-sm">{title}</h3>
      <p class="feature-body t-body text-secondary">{body}</p>
    </div>
  </Card>
);

const SectionHeader: FC<{ eyebrow?: string; title: string; lead?: string }> = ({
  eyebrow,
  title,
  lead,
}) => (
  <header class="section-header">
    {eyebrow ? <p class="section-eyebrow t-ui-label">{eyebrow}</p> : null}
    <h2 class="section-title t-display-lg">{title}</h2>
    {lead ? <p class="section-lead t-body-lg text-secondary">{lead}</p> : null}
  </header>
);

// ===================================================================== HOME

marketing.get("/", (c) =>
  c.html(
    <SiteShell
      title={undefined}
      description="Make a QR code in seconds — then make it permanent. Edit where it points anytime; the printed code never changes. Open-source, with scan analytics."
    >
      {/* -------------------------------------------------------------- Hero */}
      <section class="hero hero-band-dark" aria-labelledby="hero-title">
        <div class="hero-copy">
          <h1 id="hero-title" class="hero-title t-hero-display text-center" style="margin-bottom: var(--spacing-md)">
            Sqanny — The QR Code API
          </h1>
          <p class="hero-lead t-body-lg text-center" style="color: var(--color-on-dark-muted); margin-bottom: var(--spacing-xl)">
            Generate dynamic QR codes programmatically. Built for developers, trusted by enterprises.
          </p>
        </div>

        <div class="code-mockup-card" style="max-width: 600px; margin: 0 auto; margin-bottom: var(--spacing-xxl)">
          <div style="display: flex; justify-content: space-between; margin-bottom: var(--spacing-md)">
            <span class="t-caption-bold">POST /v1/qr</span>
            <span class="badge-purple">API Reference</span>
          </div>
          <pre class="code-block" style="overflow-x: auto; background-color: var(--color-brand-teal-deep); border: 1px solid var(--color-hairline-dark)">
<code>{`curl -X POST https://api.sqanny.com/v1/qr \\
  -H "Authorization: Bearer sq_..." \\
  -d '{
    "url": "https://example.com/promo",
    "design": { "color": "#00ed64" }
  }'`}</code>
          </pre>
          <div style="margin-top: var(--spacing-md); display: flex; justify-content: flex-end">
            <Button variant="primary" href="/docs">Read the Docs</Button>
          </div>
        </div>

        {/* The live generator */}
        <div class="generator card-feature-dark" role="form" aria-label="Live QR generator" style="max-width: 800px; margin: 0 auto">
          <div class="generator-input">
            <Input
              id="gen-url"
              name="url"
              label="Your URL"
              type="url"
              inputmode="url"
              autocomplete="url"
              placeholder="yoursite.com"
              hint="Start typing — your code appears instantly."
            />
            {/* Brand Match */}
            <div class="generator-brand" id="gen-brand-wrap" hidden aria-hidden="true">
              <button type="button" class="button-secondary-on-dark btn-block" id="gen-brand" data-brand>
                <span class="btn-icon" aria-hidden="true">
                  <Icon name="sparkles" />
                </span>
                <span class="btn-label">Brand it with AI</span>
              </button>
              <p class="generator-brand-note t-caption text-tertiary" id="gen-brand-note" role="status" aria-live="polite"></p>
            </div>
            {/* CTA */}
            <div class="generator-cta" id="gen-cta" hidden aria-hidden="true">
              <Button variant="primary" size="lg" href="/login" block>
                Make it permanent
              </Button>
              <p class="generator-cta-note t-caption" style="color: var(--color-on-dark-muted)">
                Free account · keeps your code editable forever.
              </p>
            </div>
          </div>

          <div class="generator-preview">
            <figure class="qr-preview qr-preview-hero">
              <div
                class="qr-preview-surface"
                id="gen-preview-surface"
                style="color-scheme: light;"
                role="img"
                aria-label="Live QR code preview"
                aria-live="polite"
              >
                {raw(PLACEHOLDER_QR_SVG)}
              </div>
              <figcaption class="qr-preview-caption t-body-sm" style="color: var(--color-on-dark-muted)">
                Scannable the moment it appears.
              </figcaption>
            </figure>
            <p
              class="generator-status t-caption"
              id="gen-status"
              role="status"
              aria-live="polite"
              style="color: var(--color-on-dark-muted)"
            ></p>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------- Feature highlights */}
      <section class="section" style="padding-block: var(--spacing-section-lg)" aria-labelledby="why-title">
        <header class="section-header">
          <h2 id="why-title" class="section-title t-display-lg">
            Built to stay reliable.
          </h2>
          <p class="section-lead t-body-lg text-secondary">
            Everything you print is permanent. Everything behind it stays yours
            to change.
          </p>
        </header>
        <div class="feature-grid">
          <FeatureCard
            icon="link"
            title="Dynamic — never breaks"
            body="Print once, redirect forever. Edit the destination anytime and every code already in the wild updates instantly."
          />
          <FeatureCard
            icon="chart"
            title="Scan analytics"
            body="See total scans, daily trends, device and country breakdowns — so you know your code is working."
          />
          <FeatureCard
            icon="qr"
            title="Customization"
            body="Colors, module shapes, finder styles, a centered logo and frame labels — with a live scannability guard."
          />
          <FeatureCard
            icon="settings"
            title="Open-source"
            body="MIT licensed and self-hostable on your own Cloudflare account. No vendor lock-in, no data leaving your stack."
          />
        </div>
      </section>

      {/* ------------------------------------------------------- Use-cases strip */}
      <section class="section section-quiet" aria-labelledby="uses-title">
        <header class="section-header">
          <h2 id="uses-title" class="section-title t-display-lg">
            One code for every place it lives.
          </h2>
        </header>
        <ul class="usecase-strip" role="list">
          {[
            { icon: "menu" as IconName, label: "Restaurant menus" },
            { icon: "social" as IconName, label: "Events & posters" },
            { icon: "vcard" as IconName, label: "Business cards" },
            { icon: "business" as IconName, label: "Retail & packaging" },
          ].map((u) => (
            <li class="usecase-chip">
              <span class="usecase-chip-icon" aria-hidden="true">
                <Icon name={u.icon} size={20} />
              </span>
              <span class="t-body">{u.label}</span>
            </li>
          ))}
        </ul>
        <div class="section-cta">
          <Button variant="secondary" href="/use-cases">
            Explore use cases
          </Button>
        </div>
      </section>

      <script src="/js/generator.js" defer></script>
    </SiteShell>,
  ),
);

// ================================================================= FEATURES

const FEATURE_SECTIONS: {
  icon: IconName;
  title: string;
  body: string;
  points: string[];
}[] = [
  {
    icon: "link",
    title: "Dynamic QR codes",
    body: "A dynamic code points at a short redirect you control. Change the destination whenever you like — the printed code never changes.",
    points: [
      "Edit the destination after printing, with zero reprints",
      "The same code can serve a campaign today and a new page tomorrow",
      "Static codes too, when you want the payload baked in",
    ],
  },
  {
    icon: "chart",
    title: "Scan analytics",
    body: "Every scan is logged the instant it happens, then aggregated so you can read trends at a glance.",
    points: [
      "Total scans and day-by-day trends",
      "Device and country breakdowns",
      "Counts that stay accurate as your codes spread",
    ],
  },
  {
    icon: "qr",
    title: "Customization",
    body: "Make the code yours without making it unscannable. A live guard checks contrast as you design.",
    points: [
      "Custom foreground and background colors",
      "Square, dotted, or rounded modules and finder styles",
      "Centered logo with a clean quiet-zone knockout, plus frame labels",
    ],
  },
  {
    icon: "menu",
    title: "All 12 QR types",
    body: "From a plain link to a full hosted landing page, generated from one consistent engine.",
    points: [
      "URL, text, Wi-Fi, email, phone, SMS and vCard",
      "Rich hosted pages: PDF, menu, business card, app store and social",
      "Rich types are always dynamic, so the page is editable forever",
    ],
  },
  {
    icon: "settings",
    title: "Self-hostable & open-source",
    body: "Sqanny is MIT licensed and runs entirely on Cloudflare primitives. Host it yourself in minutes.",
    points: [
      "Cloudflare Worker, D1, KV and R2 — nothing else required",
      "Runs fully locally with a single dev command",
      "Your data stays in your account",
    ],
  },
];

marketing.get("/features", (c) =>
  c.html(
    <SiteShell
      title="Features"
      description="Dynamic QR codes, scan analytics, full customization, all 12 QR types, and a self-hostable open-source platform."
      active="features"
    >
      <SectionHeader
        eyebrow="Features"
        title="Reliable by design."
        lead="Everything you need to make a QR you can rely on forever — and nothing that gets in the way."
      />
      <div class="feature-detail-list">
        {FEATURE_SECTIONS.map((f) => (
          <Card>
            <div class="feature-detail">
              <span class="feature-icon" aria-hidden="true">
                <Icon name={f.icon} size={24} />
              </span>
              <div class="feature-detail-copy">
                <h2 class="t-display-md">{f.title}</h2>
                <p class="t-body-lg text-secondary">{f.body}</p>
                <ul class="feature-points" role="list">
                  {f.points.map((p) => (
                    <li class="feature-point">
                      <span class="feature-point-icon" aria-hidden="true">
                        <Icon name="check" size={16} />
                      </span>
                      <span class="t-body">{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <div class="section-cta">
        <Button variant="primary" size="lg" href="/login">
          Make it permanent
        </Button>
      </div>
    </SiteShell>,
  ),
);

// ================================================================== PRICING

const PlanCard: FC<{
  name: string;
  price: string;
  cadence?: string;
  tagline: string;
  features: string[];
  cta: Child;
  featured?: boolean;
}> = ({ name, price, cadence, tagline, features, cta, featured }) => (
  <div class={["plan-card", featured ? "plan-card-featured" : null].filter(Boolean).join(" ")}>
    <div class="plan-head">
      <div class="plan-name-row">
        <h2 class="t-heading-sm">{name}</h2>
        {featured ? <Badge tone="accent">Cloud</Badge> : null}
      </div>
      <p class="plan-tagline t-body-sm text-secondary">{tagline}</p>
    </div>
    <p class="plan-price">
      <span class="plan-price-amount t-display-lg">{price}</span>
      {cadence ? <span class="plan-price-cadence t-body text-secondary">{cadence}</span> : null}
    </p>
    <ul class="plan-features" role="list">
      {features.map((f) => (
        <li class="plan-feature">
          <span class="plan-feature-icon" aria-hidden="true">
            <Icon name="check" size={16} />
          </span>
          <span class="t-body">{f}</span>
        </li>
      ))}
    </ul>
    <div class="plan-cta">{cta}</div>
  </div>
);

marketing.get("/pricing", (c) => {
  // Read the seeded limits so the cards never drift from the real plan config.
  const free = getLimits("free");
  const pro = getLimits("pro");

  const freeFeatures = [
    `${free.dynamicCodes} dynamic codes that never break`,
    "Unlimited static codes",
    `${free.analyticsRetentionDays} days of scan analytics`,
    "Full customization with logo upload",
    "Self-host the whole thing, free",
  ];
  const proFeatures = [
    pro.dynamicCodes === -1
      ? "Unlimited dynamic codes"
      : `${pro.dynamicCodes} dynamic codes`,
    "Unlimited static codes",
    `${pro.analyticsRetentionDays} days of scan analytics`,
    "Everything in Free",
    "Hosted, managed, and supported",
  ];

  return c.html(
    <SiteShell
      title="Pricing"
      description="Free forever, self-hostable. A hosted Pro plan is coming in Sqanny Cloud."
      active="pricing"
    >
      <SectionHeader
        eyebrow="Pricing"
        title="Free to run. Yours to keep."
        lead="Sqanny is open-source and free to self-host. A managed Pro plan arrives with Sqanny Cloud."
      />
      <div class="plan-grid">
        <PlanCard
          name="Free"
          price="$0"
          cadence="forever"
          tagline="Everything you need to ship reliable codes."
          features={freeFeatures}
          cta={
            <Button variant="primary" href="/login" block>
              Make it permanent
            </Button>
          }
        />
        <PlanCard
          name="Pro"
          price="Soon"
          tagline="Managed hosting, more dynamic codes, longer history."
          features={proFeatures}
          featured
          cta={
            <Button variant="secondary" block disabled aria-label="Pro plan coming in Sqanny Cloud">
              Coming in Cloud
            </Button>
          }
        />
      </div>
      <p class="pricing-note t-body-sm text-secondary">
        Prefer to run it yourself? Every feature above is in the open-source
        build — see the{" "}
        <a class="inline-link" href="/docs">
          self-host quickstart
        </a>
        .
      </p>
    </SiteShell>,
  );
});

// ================================================================ USE CASES

const USE_CASES: {
  icon: IconName;
  title: string;
  body: string;
  example: string;
}[] = [
  {
    icon: "menu",
    title: "Restaurants & menus",
    body: "Print one code on the table. Swap today's specials or the whole menu without reprinting a thing.",
    example: "A hosted menu page you edit from your phone between services.",
  },
  {
    icon: "social",
    title: "Events & posters",
    body: "Put a code on a poster weeks early. Point it at the schedule now, the livestream during, the recap after.",
    example: "One poster code that follows the event through every phase.",
  },
  {
    icon: "vcard",
    title: "Business cards",
    body: "Share contact details that update themselves. Change roles or numbers and old cards still work.",
    example: "A vCard or a hosted business-card page behind a single code.",
  },
  {
    icon: "business",
    title: "Retail & packaging",
    body: "Codes printed on packaging last for years. Keep them pointing at the right product, manual, or offer.",
    example: "Product packaging that always resolves to current support content.",
  },
];

marketing.get("/use-cases", (c) =>
  c.html(
    <SiteShell
      title="Use cases"
      description="Restaurants and menus, events, business cards, and retail — reliable QR codes for every surface."
      active="use-cases"
    >
      <SectionHeader
        eyebrow="Use cases"
        title="Wherever it's printed, it keeps working."
        lead="The places a QR code lives longest are the ones where it can't afford to break. That's exactly where Sqanny fits."
      />
      <div class="usecase-grid">
        {USE_CASES.map((u) => (
          <Card title={u.title}>
            <div class="usecase">
              <span class="feature-icon" aria-hidden="true">
                <Icon name={u.icon} size={22} />
              </span>
              <p class="t-body text-secondary">{u.body}</p>
              <p class="usecase-example t-body-sm">
                <span class="usecase-example-label t-ui-label">Example</span>{" "}
                {u.example}
              </p>
            </div>
          </Card>
        ))}
      </div>
      <div class="section-cta">
        <Button variant="primary" size="lg" href="/login">
          Make it permanent
        </Button>
      </div>
    </SiteShell>,
  ),
);

// ===================================================================== DOCS

const CodeBlock: FC<{ children: string }> = ({ children }) => (
  <pre class="code-block">
    <code>{children}</code>
  </pre>
);

marketing.get("/docs", (c) =>
  c.html(
    <SiteShell
      title="Docs — Self-host quickstart"
      description="Run Sqanny locally and deploy it to your own Cloudflare account: D1, KV, and R2 setup with wrangler."
      active="docs"
    >
      <SectionHeader
        eyebrow="Docs"
        title="Self-host quickstart."
        lead="Sqanny runs entirely on Cloudflare primitives. You can have it running locally in a couple of minutes, then deploy the same code to your own account."
      />

      <div class="docs">
        <nav class="docs-toc" aria-label="On this page">
          <h2 class="docs-toc-heading t-ui-label text-secondary">On this page</h2>
          <ul class="docs-toc-list" role="list">
            <li>
              <a class="docs-toc-link" href="#requirements">
                Requirements
              </a>
            </li>
            <li>
              <a class="docs-toc-link" href="#local">
                Local development
              </a>
            </li>
            <li>
              <a class="docs-toc-link" href="#resources">
                Create D1, KV &amp; R2
              </a>
            </li>
            <li>
              <a class="docs-toc-link" href="#deploy">
                Deploy with wrangler
              </a>
            </li>
            <li>
              <a class="docs-toc-link" href="#env">
                Environment variables
              </a>
            </li>
          </ul>
        </nav>

        <article class="docs-body">
          <section id="requirements" class="docs-section">
            <h2 class="t-display-md">Requirements</h2>
            <p class="t-body text-secondary">
              Node 18+ and a Cloudflare account (only needed to deploy — local
              dev needs no external services). Everything else is installed by
              npm.
            </p>
          </section>

          <section id="local" class="docs-section">
            <h2 class="t-display-md">Local development</h2>
            <p class="t-body text-secondary">
              Clone the repo, install dependencies, apply the local D1 migrations,
              and start the dev server. The dev command also builds the design
              tokens and bundles the client islands.
            </p>
            <CodeBlock>{`git clone https://github.com/canerdogan/quoda
cd sqanny
npm install
npm run migrate:local
npm run dev`}</CodeBlock>
            <p class="t-body text-secondary">
              Wrangler serves the app at{" "}
              <code class="code-inline">http://localhost:8787</code> with local
              D1, KV, and R2 — no cloud account required. Sign-in emails are
              printed to the dev console as a clearly labelled{" "}
              <code class="code-inline">[DEV MAGIC LINK]</code> banner.
            </p>
          </section>

          <section id="resources" class="docs-section">
            <h2 class="t-display-md">Create D1, KV &amp; R2</h2>
            <p class="t-body text-secondary">
              To deploy, create the bindings Sqanny expects, then copy the
              returned ids into <code class="code-inline">wrangler.jsonc</code>.
              Sqanny needs one D1 database, three KV namespaces, and one R2
              bucket.
            </p>
            <CodeBlock>{`# D1 database (binding: DB)
wrangler d1 create sqanny

# KV namespaces (bindings: SCAN_COUNTERS, RATE_LIMIT, SESSION_CACHE)
wrangler kv namespace create SCAN_COUNTERS
wrangler kv namespace create RATE_LIMIT
wrangler kv namespace create SESSION_CACHE

# R2 bucket (binding: ASSETS_BUCKET)
wrangler r2 bucket create sqanny-assets`}</CodeBlock>
            <p class="t-body text-secondary">
              Apply the migrations to your remote database once it exists:
            </p>
            <CodeBlock>{`npm run migrate:remote`}</CodeBlock>
          </section>

          <section id="deploy" class="docs-section">
            <h2 class="t-display-md">Deploy with wrangler</h2>
            <p class="t-body text-secondary">
              The deploy script builds tokens, bundles islands, and ships the
              Worker in one step.
            </p>
            <CodeBlock>{`npm run deploy`}</CodeBlock>
            <p class="t-body text-secondary">
              That runs{" "}
              <code class="code-inline">
                build:tokens &amp;&amp; build:client &amp;&amp; wrangler deploy
              </code>
              . After it finishes, your Worker is live on your{" "}
              <code class="code-inline">workers.dev</code> subdomain or your
              custom domain.
            </p>
          </section>

          <section id="env" class="docs-section">
            <h2 class="t-display-md">Environment variables</h2>
            <p class="t-body text-secondary">
              Set <code class="code-inline">APP_URL</code> to your deployed origin
              so generated short links and hosted pages resolve correctly. For
              real sign-in emails, add a{" "}
              <code class="code-inline">RESEND_API_KEY</code>; without it, magic
              links are logged to the console (never silently dropped). For
              premium AI wallpaper backgrounds, add a{" "}
              <code class="code-inline">FAL_KEY</code> (fal.ai); without it,
              backgrounds fall back to Cloudflare Workers AI.
            </p>
            <CodeBlock>{`# wrangler.jsonc -> vars
"vars": { "APP_URL": "https://your-domain.com" }

# secrets (optional)
wrangler secret put RESEND_API_KEY   # real email delivery
wrangler secret put FAL_KEY          # premium fal.ai wallpaper backgrounds`}</CodeBlock>
            <p class="t-body text-secondary">
              For local dev, copy{" "}
              <code class="code-inline">.dev.vars.example</code> to{" "}
              <code class="code-inline">.dev.vars</code> and fill in what you
              need.
            </p>
          </section>
        </article>
      </div>

      <div class="section-cta">
        <Button variant="secondary" href="https://github.com/canerdogan/quoda">
          Source on GitHub
        </Button>
      </div>
    </SiteShell>,
  ),
);
