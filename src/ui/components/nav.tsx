import type { FC, Child } from "hono/jsx";
import { Icon } from "../icons";

export interface NavLink {
  label: string;
  href: string;
  /** marks the current page (aria-current) */
  active?: boolean;
}

export interface NavProps {
  links?: NavLink[];
  /** trailing call-to-action link (rendered as a primary button) */
  cta?: { label: string; href: string };
  /** href the brand wordmark points to */
  brandHref?: string;
  /** controls rendered after the CTA — account menu, menus, etc. */
  end?: Child;
}

/**
 * Nav — the top bar. Brand wordmark "quoda" is Inter 300, lowercase,
 * tracking -0.02em (the brand signal). Includes a theme toggle button carrying
 * `data-theme-toggle` (handled by the theme island) and an accessible label.
 * The toggle shows both sun/moon glyphs; CSS reveals the relevant one per theme.
 */
export const Nav: FC<NavProps> = ({ links = [], cta, brandHref = "/", end }) => (
  <header class="nav">
    <div class="nav-inner">
      <a class="nav-brand" href={brandHref} aria-label="Sqanny home">
        <span class="nav-brandmark" aria-hidden="true" style="display: flex; align-items: center;">
          <img src="/logo.png" alt="Sqanny logo" style="height: 22px; width: auto;" />
        </span>
        <span class="nav-wordmark">sqanny</span>
      </a>

      {links.length > 0 ? (
        <nav class="nav-links" aria-label="Primary">
          {links.map((l) => (
            <a
              class="nav-link"
              href={l.href}
              aria-current={l.active ? "page" : undefined}
            >
              {l.label}
            </a>
          ))}
        </nav>
      ) : null}

      <div class="nav-end">
        <button
          type="button"
          class="nav-theme-toggle"
          data-theme-toggle=""
          aria-label="Toggle color theme"
          title="Toggle color theme"
        >
          <span class="nav-theme-icon nav-theme-icon-sun" aria-hidden="true">
            <Icon name="sun" size={18} />
          </span>
          <span class="nav-theme-icon nav-theme-icon-moon" aria-hidden="true">
            <Icon name="moon" size={18} />
          </span>
        </button>
        {cta ? (
          <a class="btn btn-primary nav-cta" href={cta.href}>
            <span class="btn-label">{cta.label}</span>
          </a>
        ) : null}
        {end}
      </div>
    </div>
  </header>
);
