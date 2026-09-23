import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { Card } from "../ui/components/card";
import { Badge } from "../ui/components/badge";
import { Icon } from "../ui/icons";
import { getLimits } from "../lib/plans";
import { countDynamicByUser } from "../db/queries";

export const settings = new Hono<AppEnv>();
settings.use("/app/*", requireAuth);

/** Plan id -> display name. Falls back to a title-cased id for unknowns. */
function planName(planId: string): string {
  if (planId === "free") return "Free";
  if (planId === "pro") return "Pro";
  return planId.charAt(0).toUpperCase() + planId.slice(1);
}

settings.get("/app/settings", async (c) => {
  const user = c.get("user")!;
  const limits = getLimits(user.plan_id);
  const dynamicUsed = await countDynamicByUser(c.env.DB, user.id);

  const dynamicLimitText =
    limits.dynamicCodes === -1 ? "Unlimited" : String(limits.dynamicCodes);
  const retentionText = `${limits.analyticsRetentionDays} days`;

  return c.html(
    <AppShell user={user} title="Settings" active="settings">
      <header class="settings-header">
        <h1 class="t-display-md">Settings</h1>
        <p class="settings-sub t-body text-secondary">
          Your account, plan, and preferences.
        </p>
      </header>

      <div class="settings-grid">
        {/* Account */}
        <Card title="Account">
          <dl class="settings-defs">
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">Email</dt>
              <dd class="settings-def-value t-body">{user.email}</dd>
            </div>
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">
                Sign-in method
              </dt>
              <dd class="settings-def-value t-body">
                Passwordless email link
              </dd>
            </div>
          </dl>
        </Card>

        {/* Plan */}
        <Card
          title="Plan"
          actions={<Badge tone="green">{planName(user.plan_id)}</Badge>}
        >
          <dl class="settings-defs">
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">
                Dynamic codes
              </dt>
              <dd class="settings-def-value t-body tnum">
                {dynamicUsed} of {dynamicLimitText}
              </dd>
            </div>
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">
                Analytics retention
              </dt>
              <dd class="settings-def-value t-body tnum">{retentionText}</dd>
            </div>
            <div class="settings-def">
              <dt class="settings-def-label t-body-sm text-secondary">
                Logo upload
              </dt>
              <dd class="settings-def-value t-body">
                {limits.logoUpload ? "Included" : "Not included"}
              </dd>
            </div>
          </dl>

          <div class="settings-upgrade">
            <Button variant="secondary" disabled aria-label="Upgrade to Pro — coming in Sqanny Cloud">
              Upgrade to Pro — Coming in Cloud
            </Button>
            <p class="settings-upgrade-note t-caption text-tertiary">
              Self-hosted Sqanny is fully featured. Managed Pro plans arrive with
              Sqanny Cloud.
            </p>
          </div>
        </Card>

        {/* Appearance */}
        <Card title="Appearance">
          <p class="settings-theme-hint t-body text-secondary">
            Switch between light and dark with the
            <span class="settings-theme-glyph" aria-hidden="true">
              <Icon name="sun" size={16} />
              <Icon name="moon" size={16} />
            </span>
            theme toggle in the top navigation. Your choice is remembered on this
            device.
          </p>
        </Card>

        {/* Session */}
        <Card title="Session">
          <p class="settings-signout-text t-body text-secondary">
            Signed in as {user.email}.
          </p>
          <Button
            href="/auth/logout"
            variant="secondary"
            iconLeft={<Icon name="logout" />}
          >
            Sign out
          </Button>
        </Card>
      </div>
    </AppShell>,
  );
});
