import type { FC } from "hono/jsx";
import { Icon } from "../icons";

export interface FooterColumn {
  heading: string;
  links: { label: string; href: string }[];
}

export interface FooterProps {
  columns?: FooterColumn[];
  /** repo / source link shown in the meta row */
  repoHref?: string;
}

const DEFAULT_COLUMNS: FooterColumn[] = [
  {
    heading: "Product",
    links: [
      { label: "Generator", href: "/" },
      { label: "Features", href: "/features" },
      { label: "Pricing", href: "/pricing" },
      { label: "Use cases", href: "/use-cases" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Self-host", href: "/docs/self-host" },
      { label: "Changelog", href: "/changelog" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

/**
 * Footer — site-wide footer. Repeats the brand wordmark + tagline and a
 * link grid. Token-only; the meta row carries the source/repo link to signal
 * the open-source promise.
 */
export const Footer: FC<FooterProps> = ({
  columns = DEFAULT_COLUMNS,
  repoHref = "https://github.com/canerdogan/quoda",
}) => (
  <footer class="footer">
    <div class="footer-inner">
      <div class="footer-brand">
        <a class="nav-brand" href="/" aria-label="Sqanny home">
          <span class="nav-brandmark" aria-hidden="true" style="display: flex; align-items: center;">
            <img src="/logo.png" alt="Sqanny logo" style="height: 22px; width: auto;" />
          </span>
          <span class="nav-wordmark">sqanny</span>
        </a>
        <p class="footer-tagline t-body-sm text-secondary">The QR code that never breaks.</p>
      </div>

      <div class="footer-cols">
        {columns.map((col) => (
          <nav class="footer-col" aria-label={col.heading}>
            <h2 class="footer-col-heading t-ui-label text-secondary">{col.heading}</h2>
            <ul class="footer-list">
              {col.links.map((l) => (
                <li>
                  <a class="footer-link" href={l.href}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
    </div>

    <div class="footer-meta">
      <p class="t-caption text-tertiary">© {new Date().getFullYear()} CHETNAVERSE AI SYSTEMS LLP</p>
      <a class="footer-link t-caption" href={repoHref} rel="noopener">
        <span class="footer-meta-icon" aria-hidden="true">
          <Icon name="link" size={14} />
        </span>
        Source on GitHub
      </a>
    </div>
  </footer>
);
