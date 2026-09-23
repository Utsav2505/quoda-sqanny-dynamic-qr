import type { FC, PropsWithChildren, Child } from "hono/jsx";

export interface CardProps {
  /** card style variant */
  variant?: "base" | "feature" | "feature-dark" | "product-deploy" | "course" | "cert" | "pricing" | "pricing-featured";
  /** optional title rendered as a heading-sm */
  title?: string;
  /** optional secondary line under the title */
  subtitle?: string;
  /** content for the top-right corner (badge, menu, etc.) */
  actions?: Child;
  /** raise the card to a hoverable elevation (e.g. clickable list items) */
  interactive?: boolean;
  /** make the whole card a link */
  href?: string;
  /** heading element level for the title (default h3) */
  as?: "h2" | "h3" | "h4";
  class?: string;
}

export const Card: FC<PropsWithChildren<CardProps>> = ({
  variant = "base",
  title,
  subtitle,
  actions,
  interactive,
  href,
  as = "h3",
  class: cls,
  children,
}) => {
  const classes = [
    variant === "pricing-featured" ? "pricing-card-featured" : (variant.startsWith("pricing") ? "pricing-card" : `card-${variant}`),
    interactive ? "card-interactive" : null,
    cls
  ]
    .filter(Boolean)
    .join(" ");

  const Heading = as;

  const body = (
    <>
      {title || actions ? (
        <div class="card-header">
          {title ? (
            <div class="card-heading">
              <Heading class="card-title t-heading-sm">{title}</Heading>
              {subtitle ? <p class="card-subtitle t-body-sm text-secondary">{subtitle}</p> : null}
            </div>
          ) : (
            <div />
          )}
          {actions ? <div class="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children != null ? <div class="card-body">{children}</div> : null}
    </>
  );

  if (href) {
    return (
      <a class={classes} href={href}>
        {body}
      </a>
    );
  }

  return <div class={classes}>{body}</div>;
};
