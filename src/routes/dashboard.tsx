import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { EmptyStateButton } from "../ui/components/empty-state";
import { Card } from "../ui/components/card";
import { Badge } from "../ui/components/badge";
import { Icon } from "../ui/icons";
import type { IconName } from "../ui/icons";
import { listQrByUserScoped, listBusinessesForUser, listFolders, getBusinessForUser, countUnassignedQrByUser, countDynamicByUser, type QrListRow, type FolderRow } from "../db/queries";
import { countScansForQrs } from "../lib/analytics";
import type { QrType } from "../types";

export const dashboard = new Hono<AppEnv>();
dashboard.use("/app/*", requireAuth);

// Human label + icon per QR type. Type values are also valid icon names.
const TYPE_LABEL: Record<QrType, string> = {
  url: "URL",
  text: "Text",
  wifi: "Wi-Fi",
  email: "Email",
  tel: "Phone",
  sms: "SMS",
  vcard: "vCard",
  pdf: "PDF",
  menu: "Menu",
  business: "Business",
  appstore: "App store",
  social: "Social",
};

/** Format an epoch-ms timestamp as a short, stable UTC date (e.g. "Jun 7, 2026"). */
function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

interface QrWithScans extends QrListRow {
  scans: number;
}

/**
 * Where a QR is managed.
 *
 * ONE rule, one function. A physical Sqanny Stand is managed at
 * `/qrs/<registryId>` — it has a permanent serial, an archive lifecycle and a
 * business scope that the studio knows nothing about. A studio code is managed in
 * the studio. Deciding this per call site is what previously gave a single stand
 * two different "Edit" buttons pointing at two different editors, with no way to
 * tell which one was authoritative.
 */
export function manageHref(qr: { id: string; registry_id?: string | null }): string {
  return qr.registry_id ? `/qrs/${qr.registry_id}` : `/app/${qr.id}`;
}

/** One QR in the list — a Card with title, badges, scan total, date, actions. */
const QrListItem: FC<{ qr: QrWithScans }> = ({ qr }) => {
  const typeLabel = TYPE_LABEL[qr.type] ?? qr.type;
  const typeIcon = qr.type as IconName;
  const dynamic = qr.is_dynamic === 1;
  // A dynamic code with no destination is live but leads nowhere yet. It must
  // never sit unnoticed beside a configured code that looks identical — that
  // ambiguity is how an owner ends up setting the destination on the wrong
  // QR, or scanning one and wondering why it never changed.
  const unclaimed = dynamic && !qr.destination;
  const isStand = Boolean(qr.registry_id);
  const code = qr.short_code ?? "";
  const href = manageHref(qr);
  const search = `${qr.title} ${typeLabel} ${code}`.toLowerCase();

  return (
    <div class="qr-item-wrap" data-search={search}>
      <Card class="qr-item">
        <div class="qr-item-row">
        <span class="qr-item-glyph" aria-hidden="true">
          <Icon name={typeIcon} size={20} />
        </span>

        <div class="qr-item-main">
          <h3 class="qr-item-title t-body">{qr.title}</h3>
          <div class="qr-item-badges">
            <Badge tone="neutral" icon={<Icon name={typeIcon} />}>
              {typeLabel}
            </Badge>
            {dynamic ? (
              <Badge tone="success" dot>
                Dynamic
              </Badge>
            ) : (
              <Badge tone="neutral">Static</Badge>
            )}
            {/* A stand is not just another dynamic code: it is a physical asset
                with a permanent serial, and it has its own screen. Labelling it
                is what stops someone hunting through the studio for it. */}
            {isStand ? <Badge tone="accent">Sqanny Stand</Badge> : null}
            {unclaimed ? <Badge tone="warning" dot>No destination yet</Badge> : null}
          </div>
        </div>

        <div class="qr-item-scans">
          <span class="qr-item-scans-value tnum t-heading-sm">{qr.scans}</span>
          <span class="qr-item-scans-label t-caption text-tertiary">
            {qr.scans === 1 ? "scan" : "scans"}
          </span>
        </div>

        <div class="qr-item-meta">
          {/* The short code identifies the printed label. Two codes can easily
              share a title, and the code is the only thing that tells you which
              one you are holding. A stand is identified by its SERIAL instead,
              which is the code actually printed on it. */}
          {isStand && qr.registry_id ? (
            <a class="qr-item-code t-caption" href={href}>
              View stand
            </a>
          ) : null}
          {code ? <span class="qr-item-code t-caption">{code}</span> : null}
          <span class="t-caption text-tertiary">{formatDate(qr.created_at)}</span>
        </div>

        <div class="qr-item-actions">
          <Button
            href={href}
            variant="ghost"
            class="qr-item-action"
            aria-label={`View ${qr.title}`}
            iconLeft={<Icon name="chart" />}
          >
            View
          </Button>
          <Button
            href={href}
            variant="secondary"
            class="qr-item-action"
            aria-label={`Edit ${qr.title}`}
            iconLeft={<Icon name="settings" />}
          >
            Edit
          </Button>
        </div>
        </div>
      </Card>
    </div>
  );
};

/** Client-side search filter — hides list items whose data-search misses. */
const SEARCH_FILTER = `(function(){
  var input=document.getElementById('qr-search');
  if(!input)return;
  var empty=document.getElementById('qr-search-empty');
  function apply(){
    var q=input.value.trim().toLowerCase();
    var items=document.querySelectorAll('[data-search]');
    var shown=0;
    items.forEach(function(el){
      var hit=!q||el.getAttribute('data-search').indexOf(q)!==-1;
      el.hidden=!hit;
      if(hit)shown++;
    });
    if(empty)empty.hidden=shown!==0;
  }
  input.addEventListener('input',apply);
})();`;

dashboard.get("/app", async (c) => {
  const user = c.get("user")!;

  // The scope is whatever the switcher set, but it is re-verified here. A stale
  // or hand-edited `current_business_id` — a business since archived, or a row
  // that somehow points elsewhere — must degrade to the wide view rather than
  // render another tenant's names and counts. The status check matters as much
  // as the membership check: archiving a business is a statement that it is no
  // longer a context to work in, and the switcher only ever offers active ones.
  const requestedScope = user.current_business_id;
  const requested = requestedScope
    ? await getBusinessForUser(c.env.DB, requestedScope, user.id)
    : null;
  const scope = requested?.status === "active" ? requestedScope : null;

  let qrs: QrListRow[];
  let folders: FolderRow[];
  let withScans: QrWithScans[];
  const businesses = await listBusinessesForUser(c.env.DB, user.id);
  try {
    [qrs, folders] = await Promise.all([
      listQrByUserScoped(c.env.DB, user.id, scope),
      listFolders(c.env.DB, user.id),
    ]);

    // Scan totals in ONE grouped query, not one KV read per code.
    //
    // The per-code `getTotals` fan-out cost a network round trip for every row,
    // so the dashboard's latency grew with the size of the account — the exact
    // shape that punishes the paying customer. One aggregate, keyed in memory.
    //
    // D1 is the source of truth here for the same reason it is on /qrs: mixing
    // the eventually-consistent KV counter with the D1 counts used elsewhere is
    // what made the same QR show two different totals on two screens.
    const totals = await countScansForQrs(c.env.DB, qrs.map((q) => q.id));
    withScans = qrs.map((qr) => ({ ...qr, scans: totals.get(qr.id) ?? 0 }));
  } catch (err) {
    console.error(err);
    return c.html(
      <AppShell
        user={user}
        title="Dashboard"
        active="dashboard"
        businesses={businesses}
        notice={c.req.query("notice")}
      >
        <div class="dash-empty">
          <h2 class="dash-empty-title t-heading-sm">Couldn't load your codes</h2>
          <p class="dash-empty-text t-body text-secondary">
            Something went wrong loading your dashboard. Please refresh.
          </p>
        </div>
      </AppShell>,
      500,
    );
  }

  // Group by folder for display. "Ungrouped" collects folder-less codes.
  const folderById = new Map<string, FolderRow>(folders.map((f) => [f.id, f]));
  const grouped = new Map<string, QrWithScans[]>();
  for (const qr of withScans) {
    const key = qr.folder_id && folderById.has(qr.folder_id) ? qr.folder_id : "__none__";
    const list = grouped.get(key) ?? [];
    list.push(qr);
    grouped.set(key, list);
  }
  // Render order: real folders (creation order) first, then ungrouped.
  const sections: Array<{ id: string; name: string | null; items: QrWithScans[] }> = [];
  for (const f of folders) {
    const items = grouped.get(f.id);
    if (items && items.length) sections.push({ id: f.id, name: f.name, items });
  }
  const ungrouped = grouped.get("__none__");
  if (ungrouped && ungrouped.length) {
    sections.push({
      id: "__none__",
      name: folders.length ? "Ungrouped" : null,
      items: ungrouped,
    });
  }

  const isEmpty = withScans.length === 0;
  const scopedBusiness = scope
    ? businesses.find((b) => b.id === scope) ?? null
    : null;
  const businessCount = businesses.filter((b) => b.status === "active").length;

  // An empty *scoped* view is a different situation from an empty account, and
  // it needs different copy: the account may be full of codes, they're just not
  // this business's. Saying "No QR codes yet" there would be a lie.
  const elsewhere = scope
    ? await countUnassignedQrByUser(c.env.DB, user.id) > 0 ||
      businesses.some((b) => b.id !== scope && b.status === "active")
    : false;

  return c.html(
    <AppShell
      user={{ ...user, current_business_id: scope }}
      title={scopedBusiness ? `${scopedBusiness.name}` : "Dashboard"}
      active="dashboard"
      businesses={businesses}
      notice={c.req.query("notice")}
    >
      <header class="dash-header">
        <div class="dash-heading">
          <h1 class="t-display-md">
            {scopedBusiness ? scopedBusiness.name : "Your QR codes"}
          </h1>
          <p class="dash-sub t-body text-secondary">
            {isEmpty
              ? scopedBusiness
                ? "This business has no codes yet."
                : "Reliable codes that never break — start your first one."
              : `${withScans.length} code${withScans.length === 1 ? "" : "s"} working for you.`}
          </p>
        </div>
        {!isEmpty ? (
          <div class="dash-header-actions">
            {/* Claiming an already-printed stand is a peer of "new QR", not a
                sub-feature of it: the code exists, the user just needs to
                connect it. Offered on every dashboard, including the empty one
                below, because a stand can arrive before its first digital code. */}
            <Button href="/qrs/claim" iconLeft={<Icon name="qr" size={16} />}>
              Claim a printed stand
            </Button>
            <Button href="/app/new" iconLeft={<Icon name="plus" />}>
              New QR
            </Button>
          </div>
        ) : null}
      </header>

      {isEmpty ? (
        <div class="dash-empty">
          <span class="dash-empty-glyph" aria-hidden="true">
            <Icon name={scopedBusiness ? "business" : "qr"} size={40} />
          </span>
          <h2 class="dash-empty-title t-heading-sm">
            {scopedBusiness
              ? `No codes for ${scopedBusiness.name} yet`
              : "No QR codes yet"}
          </h2>
          <p class="dash-empty-text t-body text-secondary">
            {scopedBusiness
              ? "Codes connected to this business will show up here, with their scan counts."
              : "Create a code once, point it anywhere, and update the destination forever — the printed QR never changes."}
          </p>
          <div class="dash-empty-actions">
            {scopedBusiness && elsewhere ? (
              <form method="post" action="/app/businesses/switch">
                <input type="hidden" name="business_id" value="" />
                <input type="hidden" name="next" value="/app" />
                <button class="btn btn-secondary btn-lg" type="submit">
                  <span class="btn-label">View all businesses</span>
                </button>
              </form>
            ) : null}
            {/* A business is never a prerequisite for a QR. Offering it here as
                a lower-emphasis sibling keeps the fast path — print a code —
                one click away, and matches the onboarding's "business or later". */}
            <Button href="/app/new" size="lg" iconLeft={<Icon name="plus" />}>
              Create your first QR
            </Button>
            <Button
              href="/qrs/claim"
              size="lg"
              variant="secondary"
              iconLeft={<Icon name="qr" size={16} />}
            >
              Connect a printed stand
            </Button>
            {!scopedBusiness && businessCount === 0 ? (
              <EmptyStateButton
                href="/app/businesses/new"
                label="Add a business"
                icon="business"
                variant="secondary"
              />
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div class="dash-toolbar">
            <div class="dash-search field">
              <label class="visually-hidden" for="qr-search">
                Search your QR codes
              </label>
              <input
                class="input"
                id="qr-search"
                type="search"
                inputmode="search"
                autocomplete="off"
                placeholder="Search by title or type…"
                aria-label="Search your QR codes"
              />
            </div>
          </div>

          <div class="dash-list">
            {sections.map((section) => (
              <section class="dash-section">
                {section.name ? (
                  <h2 class="dash-section-title t-body-sm text-secondary">
                    {section.name}
                  </h2>
                ) : null}
                <div class="dash-section-items">
                  {section.items.map((qr) => (
                    <QrListItem qr={qr} />
                  ))}
                </div>
              </section>
            ))}

            <p
              class="dash-empty-search t-body text-secondary"
              id="qr-search-empty"
              hidden
            >
              No codes match your search.
            </p>
          </div>

          <script dangerouslySetInnerHTML={{ __html: SEARCH_FILTER }} />
        </>
      )}
    </AppShell>,
  );
});
