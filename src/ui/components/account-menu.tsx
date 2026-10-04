import type { FC } from "hono/jsx";
import { Icon } from "../icons";
import { Avatar } from "./avatar";

export interface AccountMenuProps {
  name: string | null;
  email: string;
  avatarKey: string | null;
  /** number of active businesses — shown as the account's business count */
  businessCount?: number;
}

/**
 * AccountMenu — "which account am I signed in as", permanently visible.
 *
 * The trigger always shows the name (or the email) so there is never a question
 * of whose session is live.
 *
 * Sign-out is a POST button rather than a link. It used to be a GET, and the
 * session cookie is SameSite=Lax — which permits cross-site top-level GET
 * navigations — so any page could sign the user out with one <img> tag. A
 * button inside this form cannot be reached that way, and it still works with
 * scripting disabled, which was the reason for using a link at all.
 */
export const AccountMenu: FC<AccountMenuProps> = ({
  name,
  email,
  avatarKey,
  businessCount,
}) => {
  const display = (name ?? "").trim() || email;

  return (
    <div class="acct" data-dropdown>
      <button
        type="button"
        class="acct-trigger"
        data-dropdown-trigger
        aria-expanded="false"
        aria-haspopup="true"
        aria-label={`Account menu for ${display}`}
      >
        <Avatar size="sm" name={display} src={avatarKey} />
        <span class="acct-trigger-text">
          <span class="acct-trigger-name t-body-sm">{display}</span>
          <span class="acct-trigger-sub t-caption text-tertiary">Personal account</span>
        </span>
        <span class="acct-caret" aria-hidden="true">
          <Icon name="chevron" size={16} />
        </span>
      </button>

      <div class="dropdown-panel acct-panel" data-dropdown-panel hidden>
        <div class="acct-head">
          <Avatar size="md" name={display} src={avatarKey} />
          <div class="acct-head-body">
            <p class="acct-head-name t-body" title={display}>
              {display}
            </p>
            <p class="acct-head-email t-caption text-tertiary" title={email}>
              {email}
            </p>
            {typeof businessCount === "number" ? (
              <p class="acct-head-meta t-caption text-tertiary">
                {businessCount} {businessCount === 1 ? "business" : "businesses"}
              </p>
            ) : null}
          </div>
        </div>

        <div class="dropdown-sep" />

        <nav class="acct-links" aria-label="Account">
          <a class="dropdown-item" href="/app/profile">
            <span class="dropdown-item-glyph" aria-hidden="true">
              <Icon name="business" size={18} />
            </span>
            <span class="dropdown-item-body">
              <span class="dropdown-item-label t-body-sm">Profile</span>
            </span>
          </a>
          <a class="dropdown-item" href="/qrs">
            <span class="dropdown-item-glyph" aria-hidden="true">
              <Icon name="qr" size={18} />
            </span>
            <span class="dropdown-item-body">
              <span class="dropdown-item-label t-body-sm">Sqanny Stands</span>
            </span>
          </a>
          <a class="dropdown-item" href="/app/businesses">
            <span class="dropdown-item-glyph" aria-hidden="true">
              <Icon name="qr" size={18} />
            </span>
            <span class="dropdown-item-body">
              <span class="dropdown-item-label t-body-sm">Businesses</span>
            </span>
          </a>
          <a class="dropdown-item" href="/app/settings">
            <span class="dropdown-item-glyph" aria-hidden="true">
              <Icon name="settings" size={18} />
            </span>
            <span class="dropdown-item-body">
              <span class="dropdown-item-label t-body-sm">Settings</span>
            </span>
          </a>
          <form method="post" action="/auth/logout" class="acct-logout-form" data-guard-submit>
            <button type="submit" class="dropdown-item dropdown-item-danger">
              <span class="dropdown-item-glyph" aria-hidden="true">
                <Icon name="logout" size={18} />
              </span>
              <span class="dropdown-item-body">
                <span class="dropdown-item-label t-body-sm">Log out</span>
              </span>
            </button>
          </form>
        </nav>
      </div>
    </div>
  );
};
