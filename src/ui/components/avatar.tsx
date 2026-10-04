import type { FC } from "hono/jsx";
import { assetUrl } from "../../lib/business";

export interface AvatarProps {
  /** R2 object key; falls back to initials when absent or broken */
  src?: string | null;
  name?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  class?: string;
}

/**
 * Up to two initials from a display name. Falls back to "?" so the circle never
 * renders empty — an empty avatar reads as a broken image, a "?" reads as
 * "not set yet".
 */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Avatar — the persistent user/business context signal.
 *
 * Renders the image when there is one and the initials otherwise. On an image
 * load failure the island swaps in the initials, so a deleted R2 object degrades
 * to a monogram instead of a broken-image glyph.
 */
export const Avatar: FC<AvatarProps> = ({ src, name, size = "md", class: cls }) => {
  const url = assetUrl(src);
  const classes = ["avatar", `avatar-${size}`, cls].filter(Boolean).join(" ");
  return (
    <span class={classes} data-avatar data-name={name ?? undefined}>
      <span class="avatar-initials" aria-hidden={url ? "true" : undefined}>
        {initialsOf(name)}
      </span>
      {url ? (
        <img class="avatar-img" src={url} alt="" loading="lazy" data-avatar-img />
      ) : null}
    </span>
  );
};
