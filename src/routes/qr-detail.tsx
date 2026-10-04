import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import {
  getQrById,
  listBusinessesForUser,
  type QrRow,
} from "../db/queries";
import { getRegistryByQrCodeId } from "../db/qr-registry";
import type { QrDesign, QrFields } from "../lib/qr/types";
import {
  getBreakdown,
  getUniques,
  getScans,
  countScansForQrs,
  type ScanDetail,
} from "../lib/analytics";
import { encodeMatrix } from "../lib/qr/encoder";
import { renderSvg } from "../lib/qr/render-svg";
import { safePalette } from "../lib/qr/scannability";
import { buildPayload } from "../lib/qr/content";
import { AppShell } from "../ui/app-shell";
import { Button } from "../ui/components/button";
import { Badge } from "../ui/components/badge";
import { Stat } from "../ui/components/stat";
import { QrPreview } from "../ui/components/qr-preview";
import { Icon, type IconName } from "../ui/icons";
import { EmptyState, EmptyStateButton } from "../ui/components/empty-state";
import { Modal } from "../ui/components/modal";

export const qrDetail = new Hono<AppEnv>();
qrDetail.use("/app/*", requireAuth);

const DEFAULT_DESIGN: QrDesign = {
  fg: "#0D0D0F",
  bg: "#FFFFFF",
  moduleShape: "square",
  eyeStyle: "square",
  ecc: "M",
};

const TYPE_ICON: Record<QrRow["type"], IconName> = {
  url: "url", text: "text", wifi: "wifi", email: "email", tel: "tel", sms: "sms",
  vcard: "vcard", pdf: "pdf", menu: "menu", business: "business", appstore: "appstore", social: "social",
};

const TYPE_LABEL: Record<QrRow["type"], string> = {
  url: "Website", text: "Text", wifi: "Wi-Fi", email: "Email", tel: "Phone", sms: "SMS",
  vcard: "Contact", pdf: "PDF", menu: "Menu", business: "Business", appstore: "App", social: "Social",
};

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function renderQrImage(qr: QrRow, design: QrDesign, appUrl: string): string {
  try {
    if (qr.is_dynamic === 1 && qr.short_code) {
      const matrix = encodeMatrix(`${appUrl}/r/${qr.short_code}`, design.ecc);
      return renderSvg(matrix, safePalette(design));
    }
    const fields = safeJson<QrFields>(qr.content_json, {});
    const matrix = encodeMatrix(buildPayload(qr.type, fields), design.ecc);
    return renderSvg(matrix, safePalette(design));
  } catch {
    return "";
  }
}

/**
 * A filename-safe slug from a QR's title.
 *
 * Duplicated from the API route's own slugifier rather than exported from it: a
 * route module is not a utility module, and the two must agree on the filename —
 * so when it changes it changes in both, which is what the shared copy makes
 * obvious. Also the same transformation the server's Content-Disposition applies,
 * which is why the saved file matches the requested name.
 */
function slug(value: string): string {
  return (
    (value || "sqanny-qr")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "sqanny-qr"
  );
}

interface DetailViewProps {
  qr: QrRow;
  total: number;
  topCountry: { name: string; count: number } | null;
  topDevice: { name: string; count: number } | null;
  /** Distinct-scanner floor for the last 30 days, or null when no hash secret
   *  is configured (ip_hash is never stored in that case). */
  uniques: number | null;
  /** Individual scans, newest first, for the raw scan log. */
  scans: ScanDetail[];
  /** True when a full page was returned and older rows exist. */
  scansTruncated: boolean;
  qrSvg: string;
  printedUrl: string | null;
  /**
   * Where "Edit"/"Manage" goes, and whether Delete exists.
   *
   * A physical stand is retired, never deleted: the printed code, its owner and
   * its whole scan history survive archiving. The studio's Delete button used to
   * be offered here anyway, which raised a FOREIGN KEY error from D1 and
   * returned a bare 500. It is simply not offered for a stand, and the user is
   * sent to the stand's own screen instead.
   */
  manageHref: string;
  isStand: boolean;
  analyticsError?: boolean;
}

const DetailView: FC<DetailViewProps> = ({ qr, total, topCountry, topDevice, uniques, scans, scansTruncated, qrSvg, printedUrl, manageHref, isStand, analyticsError }) => {
  const dynamic = qr.is_dynamic === 1;
  // A dynamic code with no destination is live but not yet going anywhere.
  // Rich/hosted types always carry a /p/ destination, so this never fires for
  // them and their "destination is managed" copy stays accurate.
  const unclaimed = dynamic && !qr.destination;
  return (
    <div class="qr-detail" data-qr-id={qr.id} data-dynamic={dynamic ? "true" : "false"}>
      <nav class="qr-detail-breadcrumb">
        <a href="/app" class="qr-detail-back">
          <Icon name="chevron" size={16} class="qr-detail-back-icon" /> Dashboard
        </a>
      </nav>

      <header class="qr-detail-head">
        <div class="qr-detail-title-wrap">
          <span class="qr-detail-type-icon" aria-hidden="true"><Icon name={TYPE_ICON[qr.type]} size={22} /></span>
          <div>
            <h1 class="t-display-md">{qr.title}</h1>
            <div class="qr-detail-meta">
              <span class="t-body-sm text-secondary">{TYPE_LABEL[qr.type]}</span>
              {dynamic
                ? <Badge tone="accent" dot>Dynamic</Badge>
                : <Badge tone="neutral">Static</Badge>}
            </div>
          </div>
        </div>
        <div class="qr-detail-actions">
          <Button href={manageHref} variant="secondary" iconLeft={<Icon name="settings" size={16} />}>
            {isStand ? "Manage stand" : "Edit"}
          </Button>
          {isStand ? null : (
            <Button variant="ghost" iconLeft={<Icon name="close" size={16} />} class="qr-detail-delete" data-delete aria-label="Delete this QR code">Delete</Button>
          )}
        </div>
      </header>

      <div class="qr-detail-grid">
        {/* Left: the code + destination */}
        <aside class="qr-detail-aside stack">
          <div class="card qr-detail-code-card">
            <QrPreview svg={qrSvg} label={`QR code for ${qr.title}`} />
            <div class="qr-detail-downloads">
              {/* data-download hands this to the download island, which supplies
                  the in-flight state, the double-click guard and a real success
                  or failure message. With scripting blocked it degrades to a
                  plain link to a URL that carries `Content-Disposition:
                  attachment`, so it still downloads. */}
              <Button
                href={`/api/qr/${qr.id}.svg`}
                variant="secondary"
                iconLeft={<Icon name="download" size={16} />}
                data-download={`/api/qr/${qr.id}.svg`}
                data-download-filename={`${slug(qr.title)}.svg`}
                data-download-label="Download SVG"
                data-download-busy="Downloading…"
              >
                Download SVG
              </Button>
            </div>
          </div>

          <div class="card qr-detail-dest">
            <h2 class="t-heading-sm">{dynamic ? "Destination" : "Encoded content"}</h2>
            {dynamic ? (
              <>
                {printedUrl ? (
                  <div class="qr-detail-printed">
                    <span class="field-label">Printed code points to</span>
                    <div class="qr-detail-printed-row">
                      <code class="qr-detail-mono" id="qr-detail-printed-url">{printedUrl}</code>
                      <Button
                        variant="ghost"
                        class="qr-detail-copy"
                        data-copy={printedUrl}
                        data-copy-source="#qr-detail-printed-url"
                        iconLeft={<Icon name="copy" size={14} />}
                      >
                        Copy
                      </Button>
                    </div>
                    <p class="field-hint">
                      This never changes. Reprinting is only needed to restyle the
                      image — the destination below can be changed at any time.
                    </p>
                  </div>
                ) : null}
                {unclaimed ? (
                  <p class="qr-detail-unclaimed" role="status">
                    <Icon name="close" size={16} />
                    <span>
                      <strong>No destination set yet.</strong> Anyone who scans this
                      code right now lands on a page offering to set one. Set it
                      below and the printed code starts working — no reprinting.
                    </span>
                  </p>
                ) : null}
                {qr.type === "pdf" || ["menu", "business", "appstore", "social"].includes(qr.type) ? (
                  <p class="t-body text-secondary">
                    This is a hosted page. <a href={`/app/${qr.id}/edit`}>Edit its content</a> — the destination is managed for you.
                  </p>
                ) : (
                  <form class="qr-detail-dest-form" data-dest-form>
                    <label class="field-label" for="dest-input">
                      {unclaimed ? "Set the destination" : "Current target"}
                    </label>
                    <div class="qr-detail-dest-row">
                      <input
                        class="input"
                        id="dest-input"
                        type="url"
                        inputMode="url"
                        placeholder="https://example.com"
                        data-dest-input
                        value={qr.destination ?? ""}
                      />
                      <Button variant="primary" class="qr-detail-dest-save" data-dest-save>
                        {unclaimed ? "Set" : "Update"}
                      </Button>
                    </div>
                    <p class="field-hint" data-dest-status hidden role="status"></p>
                  </form>
                )}
              </>
            ) : (
              <p class="t-body text-secondary">Static codes embed their data directly and can't be re-targeted. Create a new code to change the content.</p>
            )}
          </div>
        </aside>

        {/* Right: analytics */}
        <section class="qr-detail-analytics stack" aria-labelledby="qd-analytics">
          <h2 class="t-heading-sm visually-hidden" id="qd-analytics">Analytics</h2>

          {analyticsError ? (
            <p class="t-body-sm text-secondary" role="status">
              Couldn't load analytics — please refresh to try again.
            </p>
          ) : null}

          <div class="qr-detail-stats">
            <Stat label="Total scans" value={String(total)} icon={<Icon name="chart" size={18} />} />
            <Stat label="Top country" value={topCountry ? topCountry.name : "—"} unit={topCountry ? `${topCountry.count}` : undefined} />
            <Stat label="Top device" value={topDevice ? capitalize(topDevice.name) : "—"} unit={topDevice ? `${topDevice.count}` : undefined} />
            {/* Unique scanners, last 30 days. The hash salt rotates daily, so
                this is a floor, not an exact lifetime count. Omitted entirely
                when no SCAN_HASH_SECRET is configured. */}
            {uniques !== null ? (
              <Stat
                label="Avg. unique scanners"
                value={String(uniques)}
                unit="per active day"
              />
            ) : null}
          </div>

          <div class="card qr-detail-chart-card">
            <div class="qr-detail-chart-head">
              <h3 class="t-heading-sm">Scans over time</h3>
              <span class="t-body-sm text-secondary">Last 30 days</span>
            </div>
            <div class="qr-chart" data-chart="daily" aria-label="Daily scans chart">
              <p class="qr-chart-empty t-body-sm text-secondary" data-chart-empty>Loading…</p>
            </div>
          </div>

          <div class="qr-detail-breakdowns">
            <div class="card">
              <h3 class="t-heading-sm">By country</h3>              <div class="qr-bars" data-chart="country">
                <p class="qr-chart-empty t-body-sm text-secondary" data-chart-empty>No scans yet.</p>
              </div>
            </div>
            <div class="card">
              <h3 class="t-heading-sm">By city</h3>
              <div class="qr-bars" data-chart="city">
                <p class="qr-chart-empty t-body-sm text-secondary" data-chart-empty>No scans yet.</p>
              </div>
            </div>
            <div class="card">
              <h3 class="t-heading-sm">By device</h3>
              <div class="qr-bars" data-chart="device">
                <p class="qr-chart-empty t-body-sm text-secondary" data-chart-empty>No scans yet.</p>
              </div>
            </div>
            <div class="card">
              <h3 class="t-heading-sm">By operating system</h3>
              <div class="qr-bars" data-chart="os">
                <p class="qr-chart-empty t-body-sm text-secondary" data-chart-empty>No scans yet.</p>
              </div>
            </div>
            <div class="card">
              <h3 class="t-heading-sm">By browser</h3>
              <div class="qr-bars" data-chart="browser">
                <p class="qr-chart-empty t-body-sm text-secondary" data-chart-empty>No scans yet.</p>
              </div>
            </div>
            <div class="card">
              <h3 class="t-heading-sm">By language</h3>
              <div class="qr-bars" data-chart="language">
                <p class="qr-chart-empty t-body-sm text-secondary" data-chart-empty>No scans yet.</p>
              </div>
            </div>
          </div>

          {/* Raw per-scan log. Server-rendered so it works with JS disabled.
              See ScanLogTable for the privacy caveats on what is shown. */}
          <ScanLogTable scans={scans} truncated={scansTruncated} />
        </section>
      </div>

      <div class="toast-stack" data-toast-stack aria-live="polite" aria-atomic="false"></div>
    </div>
  );
};

// --- Raw scan log ----------------------------------------------------------

/** Rows rendered in the table. A page of 200 is plenty; the rest is a count. */
const SCAN_PAGE_SIZE = 200;

/**
 * Per-scan table.
 *
 * Contains raw IP addresses, so it is rendered only for the authenticated
 * owner. The referer is shown as host/short-path (query strings dropped) and
 * the scanner ID is the non-reversible hash, not a second copy of the address.
 */
const ScanLogTable: FC<{ scans: ScanDetail[]; truncated: boolean }> = ({
  scans,
  truncated,
}) => {
  if (!scans.length) {
    return (
      <div class="card qr-scanlog">
        <h3 class="t-heading-sm">Scan log</h3>
        <p class="qr-chart-empty t-body-sm text-secondary" data-chart-empty>
          No scans yet. Every scan of this code is listed here.
        </p>
      </div>
    );
  }

  return (
    <div class="card qr-scanlog">
      <div class="qr-detail-chart-head">
        <h3 class="t-heading-sm">Scan log</h3>
        <span class="t-body-sm text-secondary">
          Newest first{scans.length >= SCAN_PAGE_SIZE ? ` · showing latest ${SCAN_PAGE_SIZE}` : ""}
        </span>
      </div>
      <p class="field-hint">
        Includes raw IP addresses and precise location where permission was already
        granted. This is personal data — export or delete it accordingly.
      </p>
      <div
        class="qr-scanlog-wrap"
        tabIndex={0}
        role="region"
        aria-label="Scan log table, scrollable"
      >
        <table class="qr-scanlog-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">IP</th>
              <th scope="col">Scanner ID</th>
              <th scope="col">Location</th>
              <th scope="col">Device</th>
              <th scope="col">Browser</th>
              <th scope="col">Lang</th>
              <th scope="col">Referer</th>
              <th scope="col">Screen</th>
            </tr>
          </thead>
          <tbody>
            {scans.map((s) => (
              <tr>
                <td class="qr-scanlog-when">
                  <time dateTime={new Date(s.ts).toISOString()}>{formatScanTime(s.ts)}</time>
                </td>
                <td class="qr-scanlog-mono">{s.ip ?? dash}</td>
                <td class="qr-scanlog-mono" title="Daily-rotating hash, not reversible">
                  {s.ipHash ?? dash}
                </td>
                <td>{scanLocation(s)}</td>
                <td>{scanDevice(s)}</td>
                <td>{scanBrowser(s)}</td>
                <td>{s.language ?? dash}</td>
                <td class="qr-scanlog-mono" title={s.referer ?? undefined}>
                  {s.referer ?? dash}
                </td>
                <td>{scanScreen(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const dash = "—";

/** Absolute UTC timestamp: a scan log is useless without a precise time. */
function formatScanTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  );
}

function join(parts: Array<string | null | undefined>, sep = " "): string {
  return parts.filter(Boolean).join(sep) || dash;
}

function scanLocation(s: ScanDetail): string {
  const coarse = join([s.city, s.country], ", ");
  // Precise coordinates only exist when the visitor had already granted
  // location access; fall back to the city-level fix.
  if (s.geoLat != null && s.geoLon != null) {
    const acc = s.geoAccuracyM != null ? ` ±${Math.round(s.geoAccuracyM)}m` : "";
    return `${coarse} · ${s.geoLat.toFixed(4)}, ${s.geoLon.toFixed(4)}${acc}`;
  }
  return coarse;
}

function scanDevice(s: ScanDetail): string {
  return join([s.device, s.os, s.osVersion], " ");
}

function scanBrowser(s: ScanDetail): string {
  return join([s.browser, s.browserVersion], " ");
}

function scanScreen(s: ScanDetail): string {
  if (s.screenW == null || s.screenH == null) return dash;
  const dpr = s.dpr != null && s.dpr !== 1 ? ` @${s.dpr}x` : "";
  const tz = s.timezone ? ` · ${s.timezone}` : "";
  return `${s.screenW}×${s.screenH}${dpr}${tz}`;
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function topEntry(map: Record<string, number>): { name: string; count: number } | null {
  let best: { name: string; count: number } | null = null;
  for (const [name, count] of Object.entries(map)) {
    if (!best || count > best.count) best = { name, count };
  }
  return best;
}

/**
 * Mean distinct scanners across days that saw traffic, or null when there were
 * none. Averaging only over active days stops a young QR code from reporting a
 * misleadingly low number just because it has only existed for a few days.
 */
function avgDailyUniques(daily: Array<{ day: string; count: number }>): number | null {
  const active = daily.filter((d) => d.count > 0);
  if (!active.length) return null;
  const sum = active.reduce((acc, d) => acc + d.count, 0);
  return Math.round(sum / active.length);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

qrDetail.get("/app/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const qr = await getQrById(c.env.DB, id);
  if (!qr || qr.user_id !== user.id) {
    return c.html(
      <AppShell user={user} title="Not found" active="dashboard">
        <div class="page-narrow">
          <EmptyState
            icon="close"
            title="QR code not found"
            body="It may have been deleted, or it isn't yours."
            action={<EmptyStateButton href="/app" label="Back to dashboard" />}
          />
        </div>
      </AppShell>,
      404,
    );
  }

  const businesses = await listBusinessesForUser(c.env.DB, user.id);

  // A physical stand is retired, never deleted: the printed code, its owner and
  // its whole scan history survive archiving. The studio's Delete button used to
  // be offered here anyway, which raised a FOREIGN KEY error from D1 and
  // returned a bare 500. It is simply not offered for a stand.
  const registry =
    qr.source === "registration" ? await getRegistryByQrCodeId(c.env.DB, qr.id) : null;
  const manageHref = registry ? `/qrs/${registry.id}` : `/app/${qr.id}`;

  const design = { ...DEFAULT_DESIGN, ...safeJson<Partial<QrDesign>>(qr.design_json, {}) } as QrDesign;

  // Analytics are best-effort: if the fast counters / breakdown read fails we
  // still render the QR details with zeroed analytics and an inline note.
  let total = 0;
  let topCountry: { name: string; count: number } | null = null;
  let topDevice: { name: string; count: number } | null = null;
  let uniques: number | null = null;
  let scans: ScanDetail[] = [];
  let scansTruncated = false;
  let analyticsError = false;
  try {
    // ONE source of truth for the scan total. This read the KV fast counter
    // while /qrs and the dashboard read D1, so the same QR could show two
    // different totals depending on which screen you were on — KV is
    // eventually consistent and D1 is not, so the gap was real and widened with
    // traffic.
    const [t, breakdown, u, scanRows] = await Promise.all([
      countScansForQrs(c.env.DB, [id]).then((m) => m.get(id) ?? 0),
      getBreakdown(c.env, id),
      getUniques(c.env, id, 30),
      getScans(c.env, id, SCAN_PAGE_SIZE, 0),
    ]);
    total = t;
    topCountry = topEntry(breakdown.country);
    topDevice = topEntry(breakdown.device);
    // A raw distinct count would double-count anyone who scanned on two days
    // (the salt rotates daily, so they are unlinkable). Report the average
    // distinct scanners across days that actually saw traffic, which is both
    // honest and the number people actually want. Null when no hashes exist.
    uniques = avgDailyUniques(u.daily);
    scans = scanRows;
    // A full page implies there is at least one more row behind it.
    scansTruncated = scanRows.length >= SCAN_PAGE_SIZE;
  } catch (err) {
    console.error(err);
    analyticsError = true;
  }

  const qrSvg = renderQrImage(qr, design, c.env.APP_URL);
  const printedUrl = qr.is_dynamic === 1 && qr.short_code ? `${c.env.APP_URL}/r/${qr.short_code}` : null;

  return c.html(
    // `businesses` and `active` matter here: without them the business switcher
    // disappears and no nav item is marked current, so opening a QR dropped the
    // user out of their business context and gave them no way back.
    <AppShell
      user={user}
      title={qr.title}
      active="dashboard"
      businesses={businesses}
      switchReturnTo={`/app/${qr.id}`}
    >
      <DetailView
        qr={qr}
        total={total}
        topCountry={topCountry}
        topDevice={topDevice}
        uniques={uniques}
        scans={scans}
        scansTruncated={scansTruncated}
        qrSvg={qrSvg}
        printedUrl={printedUrl}
        manageHref={manageHref}
        isStand={Boolean(registry)}
        analyticsError={analyticsError}
      />
      {/* `registry` is what makes this a stand: a claimed stand is archived or
          restored through the stand flow, never deleted, so offering Delete on
          one would let a printed code be destroyed by a different path than the
          one that created it. */}
      {registry ? null : (
        <Modal
          id="qr-delete"
          size="sm"
          title={`Delete “${qr.title}”?`}
          description="This can't be undone. Any printed codes stop pointing at this entry, and its scan history goes with it."
          footer={
            <>
              <Button variant="ghost" type="button" data-modal-close>
                Keep it
              </Button>
              <Button
                variant="secondary"
                type="button"
                data-delete-confirm
                data-busy-label="Deleting…"
              >
                Delete QR code
              </Button>
            </>
          }
        >
          <p class="field-hint" data-delete-status role="status" aria-live="polite" />
        </Modal>
      )}
      <script src="/js/charts.js" defer></script>
    </AppShell>,
  );
});
