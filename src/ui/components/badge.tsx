import type { FC, PropsWithChildren, Child } from "hono/jsx";

export type BadgeTone = "green" | "green-soft" | "purple" | "orange" | "popular";

export interface BadgeProps {
  tone?: BadgeTone;
  /** small dot before the label (status indicator) */
  dot?: boolean;
  /** optional leading icon */
  icon?: Child;
  class?: string;
}

export const Badge: FC<PropsWithChildren<BadgeProps>> = ({
  tone = "green-soft",
  dot,
  icon,
  class: cls,
  children,
}) => {
  const classes = [`badge-${tone}`, cls].filter(Boolean).join(" ");
  return (
    <span class={classes}>
      {dot ? <span class="badge-dot" aria-hidden="true" /> : null}
      {icon ? <span class="badge-icon">{icon}</span> : null}
      {children}
    </span>
  );
};
