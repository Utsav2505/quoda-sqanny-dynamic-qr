// Charts island — fetches analytics and renders a daily line chart + country/
// device/os/browser/language bars as inline SVG, token-colored via currentColor.
// Dependency-free.

interface AnalyticsResponse {
  ok: boolean;
  total: number;
  daily: Array<{ day: string; count: number }>;
  breakdown: {
    country: Record<string, number>;
    device: Record<string, number>;
    os?: Record<string, number>;
    browser?: Record<string, number>;
    language?: Record<string, number>;
    city?: Array<{ name: string; count: number }>;
  };
  uniques?: { total: number; daily: Array<{ day: string; count: number }> };
  error?: string;
}

const NS = "http://www.w3.org/2000/svg";

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function init(): void {
  const root = document.querySelector<HTMLElement>(".qr-detail");
  if (!root) return;
  const qrId = root.getAttribute("data-qr-id");
  if (!qrId) return;

  void load(qrId, root);
  wireDestinationEdit(qrId, root);
  wireDelete(qrId, root);
  wireCopy(root);
}

// --- Copy the permanent printed URL -----------------------------------------

/**
 * The printed URL is the thing an owner needs when they are holding a physical
 * label and wondering which dashboard entry it belongs to. Copying it beats
 * transcribing it, so wire it up without requiring a library.
 *
 * Three details this gets right that the obvious version does not:
 *  1. Only the LABEL is swapped (`span.btn-label`), never `textContent`. These
 *     buttons carry an icon; `textContent = "Copied"` would delete the icon and
 *     the button would stay wrong for the rest of the session.
 *  2. If the clipboard is unavailable the user is told how to recover, and the
 *     text is SELECTED for them. Saying "Press Cmd-C" while nothing is selected
 *     copies nothing — the failure mode is the exact one the hint is for.
 *  3. Re-clicking restarts the revert timer instead of stacking one, so three
 *     quick taps do not flash "Copied" and blank out after a single 2s.
 */
function wireCopy(root: HTMLElement): void {
  const btn = root.querySelector<HTMLElement>("[data-copy]");
  if (!btn) return;
  const label = btn.querySelector<HTMLElement>(".btn-label") ?? btn;
  const original = label.textContent ?? "";
  const revertAfter = 2000;
  // cmd on Apple hardware, ctrl everywhere else — "Press Cmd-C" on Windows is
  // advice that cannot work.
  const accel = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent)
    ? "Cmd"
    : "Ctrl";
  let revertTimer = 0;

  const say = (text: string, ms: number): void => {
    label.textContent = text;
    window.clearTimeout(revertTimer);
    revertTimer = window.setTimeout(() => {
      label.textContent = original;
    }, ms);
  };

  btn.addEventListener("click", async () => {
    const value = btn.getAttribute("data-copy") ?? "";

    // Select the source text up front. If the write below throws, the user can
    // recover with the accelerator; if it succeeds, the selection is invisible.
    const sourceSel = btn.getAttribute("data-copy-source");
    const source = sourceSel ? root.querySelector<HTMLElement>(sourceSel) : null;
    if (source) {
      const range = document.createRange();
      range.selectNodeContents(source);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    try {
      await navigator.clipboard.writeText(value);
      say("Copied", revertAfter);
    } catch {
      // Blocked by an insecure context or a denied permission. Not fatal, and not
      // worth a modal: say what to press and leave the selection in place.
      say(`Press ${accel}+C`, 4000);
    }
  });
}

// --- Inline destination edit (dynamic codes) -------------------------------

function wireDestinationEdit(qrId: string, root: HTMLElement): void {
  const form = root.querySelector<HTMLElement>("[data-dest-form]");
  if (!form) return;
  const input = form.querySelector<HTMLInputElement>("[data-dest-input]");
  const status = form.querySelector<HTMLElement>("[data-dest-status]");
  const saveBtn = form.querySelector<HTMLElement>("[data-dest-save]")?.closest(".btn");

  async function submit(): Promise<void> {
    if (!input) return;
    const dest = input.value.trim();
    if (!dest) {
      setStatus("Enter a destination URL.", true);
      return;
    }
    try {
      const res = await fetch(`/api/qr/${qrId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destination: dest }),
      });
      const data = (await res.json()) as { ok: boolean; qr?: { destination: string }; error?: string };
      if (data.ok) {
        if (data.qr?.destination) input.value = data.qr.destination;
        setStatus("Destination updated. The printed code is unchanged.", false);
      } else {
        setStatus(data.error || "Couldn't update the destination.", true);
      }
    } catch {
      setStatus("Couldn't update. Check your connection.", true);
    }
  }

  function setStatus(msg: string, error: boolean): void {
    if (!status) return;
    status.textContent = msg;
    status.hidden = false;
    status.setAttribute("data-error", error ? "true" : "false");
  }

  saveBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    void submit();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
}

// --- Delete ---------------------------------------------------------------

/**
 * Delete, behind a real in-app confirmation.
 *
 * This was `confirm()` + `alert()`. Three problems, all of them the kind a user
 * only notices when it goes wrong:
 *  - `alert()`/`confirm()` are unstyled, block the whole main thread, and iOS
 *    Safari has a long-standing double-tap bug in `confirm`. The app already has
 *    a Modal component with a focus trap and Escape handling, so use it.
 *  - There was no in-flight state, so a second tap re-armed the request. The
 *    confirm button now disables and relabels itself for the round trip.
 *  - A failed delete reported the reason in a modal the user had to dismiss,
 *    then left the page looking unchanged. It now says what went wrong in place
 *    and leaves the dialog open so the retry is one click away.
 */
function wireDelete(qrId: string, root: HTMLElement): void {
  const trigger = root.querySelector<HTMLElement>("[data-delete]");
  // The dialog is a SIBLING of `.qr-detail` (one per page, unique id), so it is
  // deliberately looked up on the document — a `root.querySelector` here would
  // silently return null and the Delete button would do nothing at all.
  const dialog = document.querySelector<HTMLElement>('[data-modal][id="qr-delete"]');
  const confirmBtn = dialog?.querySelector<HTMLElement>("[data-delete-confirm]");
  if (!trigger || !dialog || !confirmBtn) return;

  const status = dialog.querySelector<HTMLElement>("[data-delete-status]");
  const label = confirmBtn.querySelector<HTMLElement>(".btn-label") ?? confirmBtn;
  const idle = label.textContent ?? "Delete QR code";
  const toast = (window as unknown as {
    sqannyToast?: (m: string, t: "success" | "danger" | "neutral", title?: string) => void;
  }).sqannyToast;

  const setBusy = (busy: boolean): void => {
    if (confirmBtn instanceof HTMLButtonElement) confirmBtn.disabled = busy;
    confirmBtn.setAttribute("aria-busy", busy ? "true" : "false");
    label.textContent = busy
      ? confirmBtn.getAttribute("data-busy-label") || "Deleting…"
      : idle;
  };

  const fail = (message: string): void => {
    setBusy(false);
    if (status) status.textContent = message;
    toast?.(message, "danger", "Couldn't delete");
  };

  confirmBtn.addEventListener("click", async () => {
    if (confirmBtn instanceof HTMLButtonElement && confirmBtn.disabled) return;
    setBusy(true);
    if (status) status.textContent = "";

    let body: { ok: boolean; error?: string };
    try {
      const res = await fetch(`/api/qr/${qrId}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
      });
      body = (await res.json()) as { ok: boolean; error?: string };
    } catch {
      // Offline, DNS failure, connection reset — the request may not have
      // reached the server at all, so say that rather than implying it failed.
      fail("Couldn't reach Sqanny. Check your connection and try again.");
      return;
    }

    if (body.ok) {
      // The entry is gone; there is nothing left to show it on.
      toast?.("The QR code was deleted.", "success");
      location.href = "/app";
      return;
    }
    fail(body.error || "Couldn't delete this QR code.");
  });
}

async function load(qrId: string, root: HTMLElement): Promise<void> {
  let data: AnalyticsResponse;
  try {
    const res = await fetch(`/api/qr/${qrId}/analytics`, { headers: { accept: "application/json" } });
    data = (await res.json()) as AnalyticsResponse;
  } catch {
    markError(root, "Couldn't load analytics.");
    return;
  }
  if (!data.ok) {
    markError(root, data.error || "Couldn't load analytics.");
    return;
  }

  renderDaily(root.querySelector<HTMLElement>('[data-chart="daily"]'), data.daily);
  renderBars(root.querySelector<HTMLElement>('[data-chart="country"]'), data.breakdown.country, "country");
  renderBars(root.querySelector<HTMLElement>('[data-chart="device"]'), data.breakdown.device, "plain");
  renderBars(root.querySelector<HTMLElement>('[data-chart="os"]'), data.breakdown.os ?? {}, "plain");
  renderBars(root.querySelector<HTMLElement>('[data-chart="browser"]'), data.breakdown.browser ?? {}, "plain");
  renderBars(root.querySelector<HTMLElement>('[data-chart="language"]'), data.breakdown.language ?? {}, "plain");
  renderCity(root.querySelector<HTMLElement>('[data-chart="city"]'), data.breakdown.city ?? []);
}

function markError(root: HTMLElement, msg: string): void {
  root.querySelectorAll<HTMLElement>("[data-chart-empty]").forEach((p) => {
    p.textContent = msg;
    p.hidden = false;
  });
}

// --- Daily line chart ------------------------------------------------------

function renderDaily(host: HTMLElement | null, daily: Array<{ day: string; count: number }>): void {
  if (!host) return;
  const empty = host.querySelector<HTMLElement>("[data-chart-empty]");

  // Build a continuous 30-day window so gaps read as zero, not missing.
  const series = fill30(daily);
  const max = Math.max(1, ...series.map((d) => d.count));
  const hasData = series.some((d) => d.count > 0);

  if (!hasData) {
    if (empty) {
      empty.textContent = "No scans yet. Share your code to see activity here.";
      empty.hidden = false;
    }
    return;
  }
  if (empty) empty.hidden = true;

  const W = 640;
  const H = 200;
  const padX = 8;
  const padY = 16;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const n = series.length;
  const step = n > 1 ? innerW / (n - 1) : 0;

  const x = (i: number) => padX + i * step;
  const y = (v: number) => padY + innerH - (v / max) * innerH;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "qr-chart-svg",
    role: "img",
    "aria-label": `Daily scans over the last ${n} days, peak ${max}`,
    preserveAspectRatio: "none",
  });

  // Baseline.
  svg.appendChild(el("line", { x1: padX, y1: padY + innerH, x2: W - padX, y2: padY + innerH, class: "qr-chart-axis" }));

  // Area fill under the line.
  let areaD = `M ${x(0)} ${y(series[0].count)}`;
  for (let i = 1; i < n; i++) areaD += ` L ${x(i)} ${y(series[i].count)}`;
  areaD += ` L ${x(n - 1)} ${padY + innerH} L ${x(0)} ${padY + innerH} Z`;
  svg.appendChild(el("path", { d: areaD, class: "qr-chart-area" }));

  // Line path.
  let lineD = `M ${x(0)} ${y(series[0].count)}`;
  for (let i = 1; i < n; i++) lineD += ` L ${x(i)} ${y(series[i].count)}`;
  svg.appendChild(el("path", { d: lineD, class: "qr-chart-line" }));

  // Endpoint dot.
  svg.appendChild(el("circle", { cx: x(n - 1), cy: y(series[n - 1].count), r: 3, class: "qr-chart-dot" }));

  host.appendChild(svg);

  // Min/max labels.
  const labels = document.createElement("div");
  labels.className = "qr-chart-labels";
  labels.innerHTML =
    `<span class="t-caption text-secondary">${series[0].day.slice(5)}</span>` +
    `<span class="t-caption text-secondary">peak ${max}</span>` +
    `<span class="t-caption text-secondary">${series[n - 1].day.slice(5)}</span>`;
  host.appendChild(labels);
}

function fill30(daily: Array<{ day: string; count: number }>): Array<{ day: string; count: number }> {
  const map = new Map(daily.map((d) => [d.day, d.count]));
  const out: Array<{ day: string; count: number }> = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: map.get(key) ?? 0 });
  }
  return out;
}

// --- Horizontal bars (country / device) ------------------------------------

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", GB: "United Kingdom", TR: "Türkiye", DE: "Germany",
  FR: "France", CA: "Canada", AU: "Australia", IN: "India", JP: "Japan",
  BR: "Brazil", ES: "Spain", IT: "Italy", NL: "Netherlands",
};

function labelFor(key: string, kind: "country" | "plain"): string {
  if (key === "unknown" || key === "") return "Unknown";
  if (kind === "country") return COUNTRY_NAMES[key] ?? key;
  // Only title-case values that arrive entirely lowercased. Device dimensions
  // are a mix of "mobile"/"android" and "iOS"/"macOS"/"Chrome OS", and blindly
  // capitalising would render "iOS" as "IOS" and "macOS" as "MacOS".
  if (key !== key.toLowerCase()) return key;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function renderBars(
  host: HTMLElement | null,
  map: Record<string, number>,
  kind: "country" | "plain",
): void {
  if (!host) return;
  const empty = host.querySelector<HTMLElement>("[data-chart-empty]");
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!entries.length) {
    if (empty) {
      empty.textContent = "No data yet.";
      empty.hidden = false;
    }
    return;
  }
  if (empty) empty.hidden = true;

  const max = Math.max(1, ...entries.map(([, v]) => v));
  for (const [key, value] of entries) {
    const row = document.createElement("div");
    row.className = "qr-bar-row";
    const pct = Math.round((value / max) * 100);
    row.innerHTML =
      `<span class="qr-bar-label t-body-sm">${escapeHtml(labelFor(key, kind))}</span>` +
      `<span class="qr-bar-track"><span class="qr-bar-fill" style="width:${pct}%"></span></span>` +
      `<span class="qr-bar-value t-body-sm tnum">${value}</span>`;
    host.appendChild(row);
  }
}

/**
 * Top cities. Rendered through the same bar idiom as every other dimension —
 * cities are unbounded in cardinality but the server already caps them at six.
 */
function renderCity(
  host: HTMLElement | null,
  cities: Array<{ name: string; count: number }>,
): void {
  if (!host) return;
  const map: Record<string, number> = {};
  for (const c of cities) map[c.name] = c.count;
  renderBars(host, map, "plain");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
