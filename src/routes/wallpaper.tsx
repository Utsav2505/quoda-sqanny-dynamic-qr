import { Hono } from "hono";
import { raw } from "hono/html";
import type { Bindings } from "../types";
import { Layout } from "../ui/layout";
import { Nav } from "../ui/components/nav";
import { Footer } from "../ui/components/footer";
import { Input } from "../ui/components/input";
import { Button } from "../ui/components/button";
import { Icon } from "../ui/icons";

export const wallpaper = new Hono<{ Bindings: Bindings }>();

const STYLES = [
  { id: "auto", label: "Auto" },
  { id: "signal", label: "Signal" },
  { id: "ember", label: "Ember" },
  { id: "neon", label: "Neon" },
  { id: "editorial", label: "Editorial" },
  { id: "terrain", label: "Terrain" },
];
const NAV_LINKS = [
  { label: "Features", href: "/features" },
  { label: "Wallpaper", href: "/wallpaper", active: true },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
];

wallpaper.get("/wallpaper", (c) =>
  c.html(
    <>
      {raw("<!DOCTYPE html>")}
      <Layout
        title="AI Phone Wallpaper"
        description="Turn any link into a branded phone wallpaper with a scannable QR — AI generates the background, Sqanny renders the code."
      >
        <div class="page">
          <Nav links={NAV_LINKS} cta={{ label: "Make it permanent", href: "/login" }} />
          <main class="page-main wp">
            <header class="wp-head">
              <h1 class="t-display-md">QR wallpaper</h1>
              <p class="t-body-lg text-secondary wp-sub">
                Paste a link. AI paints an on-brand background, and Sqanny composes a
                meeting-ready poster — brand logo, a real scannable code, and a tagline —
                straight onto your phone wallpaper.
              </p>
            </header>

            <div class="wp-grid">
              {/* Controls */}
              <section class="wp-controls stack" aria-label="Wallpaper options">
                <Input
                  id="wp-url"
                  name="url"
                  label="QR destination"
                  type="url"
                  inputmode="url"
                  autocomplete="url"
                  placeholder="linkedin.com/in/you"
                  hint="Where the code opens when scanned."
                />

                <Input
                  id="wp-brand"
                  name="brandUrl"
                  label="Style it like (optional)"
                  type="url"
                  inputmode="url"
                  autocomplete="url"
                  placeholder="gamebyte.ai"
                  hint="Borrow another brand's look. Leave blank to match the destination."
                />

                <div class="wp-field">
                  <span class="field-label">Art direction</span>
                  <div class="wp-chips" role="group" aria-label="Art direction">
                    {STYLES.map((s, i) => (
                      <button
                        type="button"
                        class={`wp-chip${i === 0 ? " wp-chip-on" : ""}`}
                        data-wp-style={s.id}
                        aria-pressed={i === 0 ? "true" : "false"}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <p class="field-hint">Auto lets a creative director pick a direction to fit the brand — or force one.</p>
                </div>

                <Button id="wp-generate" size="lg" block iconLeft={<Icon name="sparkles" />}>
                  Generate wallpaper
                </Button>
                <p class="wp-status t-body-sm text-secondary" id="wp-status" role="status" aria-live="polite"></p>

                <div class="wp-actions" id="wp-actions" hidden>
                  <Button id="wp-download" variant="secondary" iconLeft={<Icon name="download" />}>
                    Download wallpaper
                  </Button>
                  <Button id="wp-regen" variant="ghost">Regenerate</Button>
                </div>
              </section>

              {/* Phone-frame preview */}
              <section class="wp-preview" aria-label="Wallpaper preview">
                <div class="wp-phone">
                  <div class="wp-phone-notch" aria-hidden="true"></div>
                  <canvas
                    id="wp-canvas"
                    class="wp-canvas"
                    width="1080"
                    height="1800"
                    role="img"
                    aria-label="Phone wallpaper preview"
                  ></canvas>
                  <div class="wp-phone-empty" id="wp-empty">
                    <span class="wp-phone-empty-icon" aria-hidden="true"><Icon name="sparkles" size={28} /></span>
                    <p class="t-body-sm text-tertiary">Your wallpaper appears here.</p>
                  </div>
                </div>
              </section>
            </div>
          </main>
          <Footer />
        </div>
      </Layout>
      <script src="/js/wallpaper.js" defer></script>
    </>,
  ),
);
