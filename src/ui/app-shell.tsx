import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";
import { Layout } from "./layout";
import { Nav } from "./components/nav";
import { AccountMenu } from "./components/account-menu";
import { BusinessSwitcher } from "./components/business-switcher";
import { FlashToast } from "./components/flash-toast";
import type { AppUser } from "../middleware/auth";
import type { BusinessSummary } from "../db/queries";
import { hasProPlan } from "../lib/plans";

type AppShellProps = PropsWithChildren<{
  user: AppUser;
  title?: string;
  /** active top-nav key for aria-current */
  active?: "dashboard" | "new" | "settings" | "businesses" | "profile" | "stands" | "batches";
  /**
   * The user's businesses, for the context switcher. Omit on pages that don't
   * show it (e.g. onboarding) — pass an empty array to show the switcher with
   * nothing in it, so the "add a business" affordance stays reachable.
   */
  businesses?: BusinessSummary[];
  /** raw `?notice=` flash code from a POST -> redirect round trip */
  notice?: string | null;
  /**
   * Load the shared form island (client-side validation, image pickers, opening
   * hours, unsaved-changes guard) on top of the always-present UI island.
   * Set it on any page with a `[data-validate]` form. The island is a no-op
   * where its hooks are absent, so it is safe either way — but paying for it on
   * a read-only page is 6KB of nothing.
   */
  formIsland?: boolean;
  /**
   * Load the camera scanner island. Opt-in like profile.js: it is only needed on
   * the pages that can actually scan, and it is the one island that asks for a
   * hardware permission, so it must never load where it is unused.
   */
  scannerIsland?: boolean;
  /**
   * Internal path to return to after switching business.
   *
   * Defaults to the dashboard. Pages whose content stays meaningful across a
   * switch — the stands list, a business page — pass their own path, so
   * changing context does not also navigate away from what you were looking at.
   */
  switchReturnTo?: string;
}>;

/**
 * AppShell — the authenticated page wrapper. Shared by dashboard, studio,
 * qr-detail, settings, business, profile and onboarding so the signed-in surface
 * is consistent. Returns a full HTML document (doctype + Layout).
 *
 * Two pieces of context are permanently visible rather than buried in a page:
 * the account menu (who am I) in the top bar, and the business switcher (whose
 * data am I looking at) in the sub-bar. Both are plain forms and links, so the
 * whole shell works with JavaScript disabled.
 */
export const AppShell: FC<AppShellProps> = ({
  user,
  title,
  active,
  businesses,
  notice,
  formIsland,
  scannerIsland,
  switchReturnTo,
  children,
}) => {
  const currentName =
    businesses?.find((b) => b.id === user.current_business_id)?.name ?? null;
  const activeCount = businesses
    ? businesses.filter((b) => b.status === "active").length
    : undefined;
  // The Batches nav item only appears for Pro. It is a convenience, not the
  // gate: a non-Pro user who types /qrs/batches gets the feature-restriction
  // page explaining why, which is more useful than a link that was never there.
  const isPro = hasProPlan(user.plan_id);

  return (
    <>
      {raw("<!DOCTYPE html>")}
      <Layout title={title}>
        <div class="page">
          <Nav
            brandHref="/app"
            links={[
              { label: "Dashboard", href: "/app", active: active === "dashboard" },
              {
                label: "Sqanny Stands",
                href: "/qrs",
                active: active === "stands",
              },
              ...(isPro
                ? [
                    {
                      label: "Batches",
                      href: "/qrs/batches",
                      active: active === "batches",
                    },
                  ]
                : []),
              {
                label: "Businesses",
                href: "/app/businesses",
                active: active === "businesses",
              },
              {
                label: "Profile",
                href: "/app/profile",
                active: active === "profile",
              },
              { label: "Settings", href: "/app/settings", active: active === "settings" },
            ]}
            cta={{ label: "New QR", href: "/app/new" }}
            end={
              <AccountMenu
                name={user.name}
                email={user.email}
                avatarKey={user.avatar_key}
                businessCount={activeCount}
              />
            }
          />

          {businesses ? (
            <div class="context-bar">
              <div class="context-bar-inner">
                <BusinessSwitcher
                  businesses={businesses}
                  currentId={user.current_business_id}
                  currentName={currentName}
                  next={switchReturnTo}
                />
              </div>
            </div>
          ) : null}

          <main class="page-main">
            <FlashToast notice={notice} />
            {children}
          </main>
        </div>

{/* ui.js opens the account menu and business switcher, so without it the
            shell's two context controls are dead. profile.js is opt-in.

            downloads.js is NOT opt-in. Every authenticated page can carry a
            download control (a single QR's SVG, a batch ZIP, a manifest), and
            the alternative — remembering to add a script tag per page — is how a
            download silently reverts to opening in a tab. It is ~2KB and binds
            only to [data-download], so on a page with none it does nothing. */}
        <script src="/js/ui.js" defer />
        <script src="/js/downloads.js" defer />
        {formIsland ? <script src="/js/profile.js" defer /> : null}
          {scannerIsland ? <script src="/js/scanner.js" defer /> : null}
      </Layout>
    </>
  );
};
