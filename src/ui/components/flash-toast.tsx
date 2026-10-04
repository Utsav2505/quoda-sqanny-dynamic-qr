import type { FC } from "hono/jsx";
import { readFlash, FLASH_PARAM, type FlashTone } from "../../lib/flash";
import { Icon } from "../icons";
import type { IconName } from "../icons";

interface FlashToastProps {
  /** raw `?notice=` value; unrecognised codes render nothing */
  notice?: string | null;
}

const TONE_ICON: Record<FlashTone, IconName> = {
  success: "check",
  danger: "close",
};

/**
 * FlashToast — the single confirmation surface for a POST -> redirect -> GET.
 *
 * Rendered server-side from the `?notice=` code, so the message is present in the
 * HTML: a redirect-based success notice that depended on JavaScript would be
 * invisible with the script blocked, which is exactly when a user most needs
 * confirmation that the save worked.
 *
 * `role="status"` (polite) rather than `alert`: a save confirmation should not
 * interrupt a screen reader mid-sentence.
 */
export const FlashToast: FC<FlashToastProps> = ({ notice }) => {
  const flash = readFlash(notice);
  if (!flash) return null;

  return (
    <div class="flash-region" role="status" aria-live="polite">
      <div class={`flash flash-${flash.tone}`} data-flash={flash.code}>
        <span class="flash-icon" aria-hidden="true">
          <Icon name={TONE_ICON[flash.tone]} size={18} />
        </span>
        <div class="flash-body">
          {flash.title ? <p class="flash-title t-body-sm">{flash.title}</p> : null}
          <p class="flash-message t-body-sm">{flash.message}</p>
        </div>
        <button
          type="button"
          class="flash-dismiss"
          data-flash-dismiss
          aria-label="Dismiss message"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </div>
  );
};

/** The query param to read. Exported so routes and tests agree on the name. */
export const FLASH_QUERY_KEY = FLASH_PARAM;
