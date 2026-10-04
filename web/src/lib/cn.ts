import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The one class-name composer.
 *
 * `clsx` handles conditional/array/object composition; `tailwind-merge`
 * resolves conflicting Tailwind utilities so a caller-supplied `px-6` actually
 * overrides a component's built-in `px-4` instead of being dropped by source
 * order. Without the merge step, every "make this button full width" override
 * silently loses to specificity, which is the usual reason a shadcn fork ends
 * up un-forkable.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}