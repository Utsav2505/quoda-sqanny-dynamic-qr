/**
 * Download island.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES
 * ---------------------------------------------------------------------------
 * A control labelled "Download SVG" opened the SVG in a new browser tab. The user
 * had to click Download, then right-click, then Save As — three steps for
 * something labelled as one.
 *
 * The cause was two-fold, and fixing only one would have left it broken half the
 * time:
 *
 *   1. The server served the SVG with `Content-Disposition: inline`, so a
 *      navigation DISPLAYED it instead of downloading it.
 *   2. The control was a plain `<a href>`, so there was nowhere to put a
 *      "Downloading…" state, no way to prevent a double-click, and no way to
 *      report a failure.
 *
 * The server header is fixed at the source (see routes/api/qr.ts and
 * routes/batches.tsx). This island covers the rest: real state, real failure
 * reporting, and no double submissions.
 *
 * ---------------------------------------------------------------------------
 * TWO MODES, AND WHY
 * ---------------------------------------------------------------------------
 * `fetch` (default) — pulls the bytes, so the button can show progress, report a
 * server error, and say "downloaded" or explain what went wrong. Used for the
 * small files where that reliability is worth the round trip.
 *
 * `navigate` — hands the URL to the browser's own downloader, which streams to
 * disk without buffering in page memory. Used for the batch ZIP, which can be tens
 * of megabytes; buffering that to report a toast would be a worse experience than
 * not getting a toast. The `attachment` header makes the browser save it without
 * leaving the page.
 *
 * ---------------------------------------------------------------------------
 * MARKUP CONTRACT
 * ---------------------------------------------------------------------------
 *   [data-download]                     an <a> or <button> that downloads a file
 *   data-download-filename="x.svg"      the filename to save as
 *   data-download-mode="navigate"       stream instead of buffering
 *   data-download-label="Download SVG"  the restored label after a busy state
 *   data-download-busy="Downloading…"   the in-flight label
 *
 * Progressive enhancement: with scripting blocked these are ordinary links to URLs
 * that carry `Content-Disposition: attachment`, so they still download.
 *
 * Bundled to /js/downloads.js. No dependencies.
 */

import { downloadBlob, downloadFromUrl, sanitizeFilename } from "./lib/download";

function busyLabel(button: HTMLElement): string {
  return (
    button.getAttribute("data-download-busy") ||
    `Downloading${button.getAttribute("data-download-filename") || ""}…`
  );
}

function restLabel(button: HTMLElement): string {
  const explicit = button.getAttribute("data-download-label");
  if (explicit) return explicit;
  const label = button.querySelector(".btn-label");
  return label?.textContent?.trim() || "Download";
}

/**
 * Put a control into its in-flight state.
 *
 * `aria-busy` is what announces the state to a screen reader; `disabled` is what
 * stops the second click. Both, because neither alone is sufficient — a disabled
 * button is silent, and a busy button that still fires is a double submission.
 *
 * Applied to an <a> as `aria-disabled` + a click guard, since an anchor cannot be
 * disabled and intercepting only the click would still allow middle-click and
 * "open in new tab", which for a download URL means a tab that immediately closes.
 */
function setBusy(button: HTMLElement, busy: boolean): void {
  const label = button.querySelector(".btn-label");
  const isAnchor = button.tagName === "A";

  if (busy) {
    if (button.getAttribute("data-download-idle-label") === null && label) {
      button.setAttribute("data-download-idle-label", restLabel(button));
    }
    button.setAttribute("aria-busy", "true");
    if (isAnchor) {
      button.setAttribute("aria-disabled", "true");
      button.classList.add("is-busy");
    } else {
      (button as HTMLButtonElement).disabled = true;
    }
    if (label) label.textContent = busyLabel(button);
    return;
  }

  button.removeAttribute("aria-busy");
  if (isAnchor) {
    button.removeAttribute("aria-disabled");
    button.classList.remove("is-busy");
  } else {
    (button as HTMLButtonElement).disabled = false;
  }
  if (label) label.textContent = button.getAttribute("data-download-idle-label") ?? restLabel(button);
  button.removeAttribute("data-download-idle-label");
}

function notify(message: string, tone: "success" | "danger"): void {
  const toast = (window as unknown as { sqannyToast?: (m: string, t: "success" | "danger" | "neutral", title?: string) => void })
    .sqannyToast;
  if (toast) toast(message, tone);
}

function initDownload(button: HTMLElement): void {
  if (button.dataset.downloadBound === "1") return;
  button.dataset.downloadBound = "1";

  const url = button.getAttribute("data-download") || button.getAttribute("href") || "";
  if (!url) return;
  const filename = sanitizeFilename(
    button.getAttribute("data-download-filename") || url.split("/").pop() || "download",
  );
  const mode = button.getAttribute("data-download-mode") === "navigate" ? "navigate" : "fetch";

  button.addEventListener("click", async (event) => {
    // A second click while one is in flight must do nothing.
    if (button.getAttribute("aria-busy") === "true") {
      event.preventDefault();
      return;
    }
    // Let the user open it in a new tab if they explicitly asked to.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

    event.preventDefault();
    setBusy(button, true);

    if (mode === "navigate") {
      // Streamed by the browser's downloader. No completion signal, so no success
      // toast: claiming "downloaded" when the browser then reports a failure is
      // worse than staying quiet.
      downloadFromUrl(url, filename);
      window.setTimeout(() => setBusy(button, false), 600);
      return;
    }

    try {
      const response = await fetch(url, { headers: { accept: "*/*" } });
      if (!response.ok) {
        let message = `Couldn't download the ${filename}. Please try again.`;
        try {
          const body = (await response.json()) as { error?: string };
          if (body && typeof body.error === "string" && body.error) message = body.error;
        } catch {
          /* not JSON — the generic message stands */
        }
        setBusy(button, false);
        notify(message, "danger");
        return;
      }

      const blob = await response.blob();
      downloadBlob(blob, filename);
      setBusy(button, false);
      notify(`${filename} downloaded.`, "success");
    } catch {
      setBusy(button, false);
      notify(
        `Couldn't download the ${filename}. Check your connection and try again.`,
        "danger",
      );
    }
  });
}

function boot(): void {
  document.querySelectorAll<HTMLElement>("[data-download], a[download]").forEach(initDownload);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
