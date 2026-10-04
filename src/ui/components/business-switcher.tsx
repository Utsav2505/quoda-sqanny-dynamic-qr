import type { FC } from "hono/jsx";
import type { BusinessSummary } from "../../db/queries";
import { Icon } from "../icons";
import { Avatar } from "./avatar";
import { businessLocation } from "../../lib/business";

export interface BusinessSwitcherProps {
  businesses: BusinessSummary[];
  /** currently active business id; null = "All businesses" */
  currentId: string | null;
  /** the business whose name is shown, when one is active */
  currentName?: string | null;
  /**
   * Where to return after switching.
   *
   * Without it every switch lands on the dashboard, so changing context from the
   * stands list or a business page threw away the page you were on. The value is
   * an internal path the server re-validates (`safeNext`), so it cannot be used
   * as an open redirect.
   */
  next?: string;
}

/**
 * BusinessSwitcher — the persistent "which business am I looking at" control.
 *
 * A disclosure button, not a bare <select>: each row needs a QR count, an
 * archived state, and a footer of actions, which a native option cannot carry.
 * Switching is a real POST (form + submit buttons) so it works without JS and is
 * exercised by the same tests as the rest of the app.
 */
export const BusinessSwitcher: FC<BusinessSwitcherProps> = ({
  businesses,
  currentId,
  currentName,
  next,
}) => {
  const active = businesses.find((b) => b.id === currentId) ?? null;
  const label = active?.name ?? "All businesses";
  const activeList = businesses.filter((b) => b.status === "active");

  return (
    <div class="biz-switch" data-dropdown>
      <button
        type="button"
        class="biz-switch-trigger"
        data-dropdown-trigger
        aria-expanded="false"
        aria-haspopup="true"
        aria-label={`Current business: ${label}. Change business`}
      >
        <Avatar
          size="sm"
          name={active?.name ?? null}
          src={active?.logo_key ?? null}
        />
        <span class="biz-switch-text">
          <span class="biz-switch-eyebrow t-caption">Current business</span>
          <span class="biz-switch-value t-body-sm">{label}</span>
        </span>
        <span class="biz-switch-caret" aria-hidden="true">
          <Icon name="chevron" size={16} />
        </span>
      </button>

      <div class="dropdown-panel biz-switch-panel" data-dropdown-panel hidden>
        <form method="post" action="/app/businesses/switch" data-guard-submit data-busy-label="Switching…">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          {currentId ? (
            <button
              type="submit"
              name="business_id"
              value=""
              class="dropdown-item biz-switch-all"
            >
              <span class="biz-switch-all-glyph" aria-hidden="true">
                <Icon name="qr" size={18} />
              </span>
              <span class="dropdown-item-body">
                <span class="dropdown-item-label t-body-sm">All businesses</span>
                <span class="dropdown-item-note t-caption text-tertiary">
                  Every business on this account
                </span>
              </span>
            </button>
          ) : null}

          {activeList.length === 0 ? (
            <p class="dropdown-empty t-body-sm text-secondary">
              No businesses yet.
            </p>
          ) : (
            <ul class="dropdown-list">
              {activeList.map((b) => (
                <li>
                  <button
                    type="submit"
                    name="business_id"
                    value={b.id}
                    class={
                      "dropdown-item" + (b.id === currentId ? " dropdown-item-current" : "")
                    }
                    aria-current={b.id === currentId ? "true" : undefined}
                  >
                    <Avatar size="sm" name={b.name} src={b.logo_key} />
                    <span class="dropdown-item-body">
                      <span class="dropdown-item-label t-body-sm">{b.name}</span>
                      <span class="dropdown-item-note t-caption text-tertiary">
                        {businessLocation(b)} · {b.qr_count}{" "}
                        {b.qr_count === 1 ? "QR" : "QRs"}
                      </span>
                    </span>
                    {b.id === currentId ? (
                      <span class="dropdown-item-check" aria-hidden="true">
                        <Icon name="check" size={16} />
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div class="dropdown-sep" />

          <a class="dropdown-item" href="/app/businesses/new">
            <span class="biz-switch-all-glyph" aria-hidden="true">
              <Icon name="plus" size={18} />
            </span>
            <span class="dropdown-item-body">
              <span class="dropdown-item-label t-body-sm">Add Business</span>
            </span>
          </a>
          <a class="dropdown-item" href="/app/businesses">
            <span class="biz-switch-all-glyph" aria-hidden="true">
              <Icon name="settings" size={18} />
            </span>
            <span class="dropdown-item-body">
              <span class="dropdown-item-label t-body-sm">Manage Businesses</span>
            </span>
          </a>
        </form>
      </div>
    </div>
  );
};
