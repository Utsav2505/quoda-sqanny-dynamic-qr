import type { FC, PropsWithChildren, Child } from "hono/jsx";
import { Icon } from "../icons";
import type { IconName } from "../icons";

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  /** explains what this screen is for and what to do next */
  body: string;
  /** the primary next step — an anchor, so it works with no JS */
  action?: Child;
  /** secondary, lower-emphasis step (e.g. "I'll do this later") */
  secondary?: Child;
  /** `card` sits in a bordered panel; `inline` is a lighter inline block */
  variant?: "card" | "inline";
  class?: string;
}

/**
 * EmptyState — every "nothing here yet" surface.
 *
 * The contract: say what is missing, say why it matters, and offer exactly one
 * obvious next step. An empty state that only says "No data" is a dead end, so
 * `body` is required and `action` is expected wherever one exists.
 */
export const EmptyState: FC<EmptyStateProps> = ({
  icon = "qr",
  title,
  body,
  action,
  secondary,
  variant = "card",
  class: cls,
}) => (
  <div
    class={["empty-state-panel", `empty-state-${variant}`, cls].filter(Boolean).join(" ")}
  >
    <span class="empty-state-glyph" aria-hidden="true">
      <Icon name={icon} size={28} />
    </span>
    <div class="empty-state-body">
      <h2 class="empty-state-title t-heading-sm">{title}</h2>
      <p class="empty-state-text t-body text-secondary">{body}</p>
      {action || secondary ? (
        <div class="empty-state-actions">
          {action}
          {secondary}
        </div>
      ) : null}
    </div>
  </div>
);

/** Convenience: an EmptyState with a primary Button already wired. */
export const EmptyStateButton: FC<
  PropsWithChildren<{
    href: string;
    label: string;
    icon?: IconName;
    variant?: "primary" | "secondary";
  }>
> = ({ href, label, icon, variant = "primary" }) => (
  <a class={`btn btn-${variant}`} href={href} role="button">
    {icon ? (
      <span class="btn-icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
    ) : null}
    <span class="btn-label">{label}</span>
  </a>
);
