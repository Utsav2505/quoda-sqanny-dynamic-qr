import { Hono } from "hono";
import { raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";
import { Layout } from "../ui/layout";
import { Nav } from "../ui/components/nav";
import { Footer } from "../ui/components/footer";
import { Button } from "../ui/components/button";
import { Input } from "../ui/components/input";
import { Select } from "../ui/components/select";
import { Textarea } from "../ui/components/textarea";
import { Card } from "../ui/components/card";
import { Badge } from "../ui/components/badge";
import { Modal } from "../ui/components/modal";
import { Toast } from "../ui/components/toast";
import { Stat } from "../ui/components/stat";
import { QrPreview } from "../ui/components/qr-preview";
import { Icon } from "../ui/icons";
import type { IconName } from "../ui/icons";

export const styleguide = new Hono();

/** A small, deterministic demo QR (currentColor modules) for preview states. */
const DEMO_QR_SVG = (() => {
  // 9x9 grid with finder-like corners — purely illustrative, real engine output
  // is injected at runtime. Modules use fill="currentColor" so the preview's
  // forced dark-on-white styling applies.
  const n = 9;
  const cells: string[] = [];
  const filled = (x: number, y: number) =>
    // three finder squares + a sparse diagonal pattern
    (x < 3 && y < 3) ||
    (x > 5 && y < 3) ||
    (x < 3 && y > 5) ||
    (x + y) % 3 === 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (filled(x, y)) {
        cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="currentColor"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">${cells.join("")}</svg>`;
})();

const ALL_ICONS: IconName[] = [
  "qr", "plus", "link", "chart", "settings", "logout", "sun", "moon",
  "check", "copy", "download", "chevron", "close",
  "url", "text", "wifi", "email", "tel", "sms", "vcard", "pdf",
  "menu", "business", "appstore", "social",
];

const Section: FC<PropsWithChildren<{ id: string; title: string; note?: string }>> = ({
  id,
  title,
  note,
  children,
}) => (
  <section class="sg-section" id={id}>
    <h2 class="sg-section-title t-display-md">{title}</h2>
    {note ? <p class="sg-section-note t-body text-secondary">{note}</p> : null}
    {children}
  </section>
);

const TYPE_OPTIONS = [
  { value: "url", label: "URL" },
  { value: "wifi", label: "Wi-Fi" },
  { value: "vcard", label: "vCard" },
  { value: "menu", label: "Menu" },
];

styleguide.get("/", (c) =>
  c.html(
    <>
      {raw("<!DOCTYPE html>")}
      <Layout title="Styleguide">
        <div class="page">
          <Nav
            links={[
              { label: "Generator", href: "/" },
              { label: "Styleguide", href: "/styleguide", active: true },
              { label: "Docs", href: "/docs" },
            ]}
            cta={{ label: "Make it permanent", href: "/signup" }}
          />

          <main class="page-main">
            <header style="margin-bottom:var(--space-32);">
              <h1 class="t-display-lg">Sqanny design system</h1>
              <p class="t-body-lg text-secondary" style="margin-top:var(--space-8);max-width:60ch;">
                Every component in realistic states. Toggle the theme (top-right) to QA
                light and dark. All styling is token-driven; the QR preview always forces
                light, scannable rendering regardless of theme.
              </p>
            </header>

            {/* ---------------------------------------------------- Typography */}
            <Section id="type" title="Typography" note="Inter variable, precise tracking is the brand signal.">
              <div class="stack">
                <p class="t-display-hero">Display hero</p>
                <p class="t-display-lg">Display large</p>
                <p class="t-display-md">Display medium</p>
                <p class="t-heading-sm">Heading small</p>
                <p class="t-body-lg">Body large — lead and onboarding copy.</p>
                <p class="t-body">Body — the default reading size for paragraphs and labels.</p>
                <p class="t-body-sm text-secondary">Body small — helper text.</p>
                <p class="t-ui-label">UI LABEL</p>
                <p class="t-caption text-tertiary">Caption — timestamps, legal.</p>
              </div>
            </Section>

            {/* -------------------------------------------------------- Colors */}
            <Section id="color" title="Color tokens" note="Surfaces, text, border and the single accent. No second hue.">
              <div class="sg-swatches">
                {[
                  ["--color-surface-0", "surface-0"],
                  ["--color-surface-1", "surface-1"],
                  ["--color-surface-2", "surface-2"],
                  ["--color-surface-3", "surface-3"],
                  ["--color-border", "border"],
                  ["--color-text-primary", "text-primary"],
                  ["--color-text-secondary", "text-secondary"],
                  ["--color-accent", "accent"],
                  ["--color-accent-hover", "accent-hover"],
                  ["--color-accent-subtle", "accent-subtle"],
                ].map(([token, name]) => (
                  <div class="sg-swatch">
                    <div class="sg-swatch-chip" style={`background:var(${token});`} />
                    <span class="t-caption text-secondary">{name}</span>
                  </div>
                ))}
              </div>
            </Section>

            {/* ------------------------------------------------------- Buttons */}
            <Section id="buttons" title="Buttons" note="Primary carries the single accent. Press = translateY(1px) 80ms.">
              <div class="stack">
                <div class="sg-row">
                  <Button variant="primary">Make it permanent</Button>
                  <Button variant="secondary">Customize</Button>
                  <Button variant="ghost">Cancel</Button>
                </div>
                <div class="sg-row">
                  <Button variant="primary" size="lg" iconLeft={<Icon name="plus" size={18} />}>
                    New QR
                  </Button>
                  <Button variant="secondary" iconLeft={<Icon name="download" size={18} />}>
                    Download
                  </Button>
                  <Button variant="ghost" iconLeft={<Icon name="copy" size={18} />}>
                    Copy link
                  </Button>
                </div>
                <div class="sg-row">
                  <Button variant="primary" disabled>
                    Disabled primary
                  </Button>
                  <Button variant="secondary" disabled>
                    Disabled secondary
                  </Button>
                  <Button variant="primary" href="/signup">
                    Link button
                  </Button>
                </div>
                <Button variant="primary" block iconLeft={<Icon name="check" size={18} />}>
                  Full-width block button
                </Button>
              </div>
            </Section>

            {/* --------------------------------------------------------- Forms */}
            <Section id="forms" title="Form fields" note="Labeled controls, ≥44px tall, hints + errors wired via aria-describedby.">
              <div class="sg-grid">
                <Input
                  id="sg-url"
                  label="Destination URL"
                  type="url"
                  placeholder="https://example.com"
                  hint="This is where the QR points."
                  required
                />
                <Input
                  id="sg-email"
                  label="Email"
                  type="email"
                  value="not-an-email"
                  error="Enter a valid email address."
                />
                <Select id="sg-type" label="QR type" options={TYPE_OPTIONS} value="url" hint="Pick a content type." />
                <Select id="sg-type-err" label="QR type" options={TYPE_OPTIONS} error="Selection required." />
                <Textarea
                  id="sg-note"
                  label="Note"
                  placeholder="Internal note (optional)"
                  hint="Only visible to your team."
                />
                <Input id="sg-disabled" label="Disabled field" value="Read only" disabled />
              </div>
            </Section>

            {/* --------------------------------------------------------- Cards */}
            <Section id="cards" title="Cards" note="surface-1, radius-lg, shadow-md. Interactive variant lifts on hover.">
              <div class="sg-grid">
                <Card title="Campaign QR" subtitle="Dynamic · 1,204 scans" actions={<Badge tone="accent">Dynamic</Badge>}>
                  <p class="t-body-sm text-secondary">
                    A standard card with a header, subtitle, and a badge action.
                  </p>
                </Card>
                <Card title="Menu QR" subtitle="Static · created today" interactive href="/qr/demo">
                  <p class="t-body-sm text-secondary">Interactive card — the whole surface is a link.</p>
                </Card>
                <Card>
                  <p class="t-body">A bare card with body content only — no header.</p>
                </Card>
              </div>
            </Section>

            {/* -------------------------------------------------------- Badges */}
            <Section id="badges" title="Badges" note="Status tones are accent lightness/opacity shifts — never a second hue.">
              <div class="sg-row">
                <Badge tone="neutral">Neutral</Badge>
                <Badge tone="accent">Dynamic</Badge>
                <Badge tone="success" dot>
                  Live
                </Badge>
                <Badge tone="warning">Draft</Badge>
                <Badge tone="danger">Expired</Badge>
                <Badge tone="neutral" icon={<Icon name="link" size={12} />}>
                  Linked
                </Badge>
              </div>
            </Section>

            {/* --------------------------------------------------------- Stats */}
            <Section id="stats" title="Stats" note="Tabular figures (tnum) so columns of numbers align.">
              <div class="sg-grid">
                <Stat label="Total scans" value="12,480" delta="+12%" trend="up" icon={<Icon name="chart" size={16} />} />
                <Stat label="Unique visitors" value="8,902" delta="-3%" trend="down" />
                <Stat label="Active codes" value="34" unit="codes" trend="flat" delta="0%" />
                <Stat label="Avg. scans / day" value="412" icon={<Icon name="qr" size={16} />} />
              </div>
            </Section>

            {/* ---------------------------------------------------- QR preview */}
            <Section
              id="qr-preview"
              title="QR preview"
              note="Forced light, white background, dark modules — scannable in any theme. aria-live=polite."
            >
              <div class="sg-row" style="align-items:flex-start;">
                <QrPreview svg={DEMO_QR_SVG} label="QR code for example.com" caption="https://example.com" />
                <QrPreview svg={DEMO_QR_SVG} label="QR code, hero treatment" hero caption="Hover to lift (hero)" />
              </div>
            </Section>

            {/* --------------------------------------------------------- Toast */}
            <Section id="toasts" title="Toasts" note="role=status; tones via accent + icon. Stack container is aria-live=polite.">
              <div class="toast-stack" style="position:static;width:min(360px,100%);" aria-live="polite">
                <Toast tone="success" title="Saved">Your QR is now permanent.</Toast>
                <Toast tone="neutral">Copied short link to clipboard.</Toast>
                <Toast tone="danger" title="Couldn't save">Check your connection and retry.</Toast>
              </div>
            </Section>

            {/* --------------------------------------------------------- Modal */}
            <Section id="modal" title="Modal" note="Rendered open here for QA. Backdrop + focus-trap sentinels + dialog aria.">
              <div style="position:relative;min-height:360px;border:1px solid var(--color-border);border-radius:var(--radius-lg);overflow:hidden;">
                <Modal
                  id="sg-modal"
                  title="Delete this QR?"
                  description="This permanently removes the code and its scan history. This cannot be undone."
                  open
                  footer={
                    <>
                      <Button variant="ghost">Cancel</Button>
                      <Button variant="primary">Delete</Button>
                    </>
                  }
                >
                  <p class="t-body text-secondary">
                    Dynamic codes pointing at this destination will stop resolving immediately.
                  </p>
                </Modal>
              </div>
            </Section>

            {/* --------------------------------------------------------- Icons */}
            <Section id="icons" title="Icons" note="Inline SVG, currentColor, theme-correct. QR menu types included.">
              <div class="sg-icons">
                {ALL_ICONS.map((name) => (
                  <div class="sg-icon-cell">
                    <Icon name={name} size={22} title={name} />
                    <span class="sg-icon-name t-caption">{name}</span>
                  </div>
                ))}
              </div>
            </Section>
          </main>

          <Footer />
        </div>
      </Layout>
    </>,
  ),
);
