import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { Card } from "../ui/components/card";
import { Badge } from "../ui/components/badge";
import { Icon } from "../ui/icons";
import type { IconName } from "../ui/icons";
import { listQrByUser, listFolders } from "../db/queries";
import type { QrRow, FolderRow } from "../db/queries";
import { getTotals } from "../lib/analytics";
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

interface QrWithScans extends QrRow {
  scans: number;
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
  const code = qr.short_code ?? "";
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
              one you are holding. */}
          {code ? <span class="qr-item-code t-caption">{code}</span> : null}
          <span class="t-caption text-tertiary">{formatDate(qr.created_at)}</span>
        </div>

        <div class="qr-item-actions">
          <Button
            href={`/app/${qr.id}`}
            variant="ghost"
            class="qr-item-action"
            aria-label={`View ${qr.title}`}
            iconLeft={<Icon name="chart" />}
          >
            View
          </Button>
          <Button
            href={`/app/${qr.id}/edit`}
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

  let qrs: QrRow[];
  let folders: FolderRow[];
  let withScans: QrWithScans[];
  try {
    [qrs, folders] = await Promise.all([
      listQrByUser(c.env.DB, user.id),
      listFolders(c.env.DB, user.id),
    ]);

    // Live scan totals from the KV fast counters, in parallel.
    withScans = await Promise.all(
      qrs.map(async (qr) => ({ ...qr, scans: await getTotals(c.env, qr.id) })),
    );
  } catch (err) {
    console.error(err);
    return c.html(
      <AppShell user={user} title="Dashboard" active="dashboard">
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

  return c.html(
    <AppShell user={user} title="Dashboard" active="dashboard">
      <header class="dash-header">
        <div class="dash-heading">
          <h1 class="t-display-md">Your QR codes</h1>
          <p class="dash-sub t-body text-secondary">
            {isEmpty
              ? "Reliable codes that never break — start your first one."
              : `${withScans.length} code${withScans.length === 1 ? "" : "s"} working for you.`}
          </p>
        </div>
        {!isEmpty ? (
          <Button href="/app/new" iconLeft={<Icon name="plus" />}>
            New QR
          </Button>
        ) : null}
      </header>

      {isEmpty ? (
        <div class="dash-empty">
          <span class="dash-empty-glyph" aria-hidden="true">
            <Icon name="qr" size={40} />
          </span>
          <h2 class="dash-empty-title t-heading-sm">No QR codes yet</h2>
          <p class="dash-empty-text t-body text-secondary">
            Create a code once, point it anywhere, and update the destination
            forever — the printed QR never changes.
          </p>
          <Button href="/app/new" size="lg" iconLeft={<Icon name="plus" />}>
            Create your first QR
          </Button>
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
