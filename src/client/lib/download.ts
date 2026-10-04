/**
 * The one place a file leaves the browser.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The reported bug: a control labelled "Download SVG" opened the SVG in a new
 * browser tab instead of downloading it, so the user had to click Download, then
 * right-click, then Save As. That happens whenever the browser is NAVIGATED to a
 * file URL — an `<a href>`, a `window.open`, a `location.assign` — because
 * navigation is ambiguous and the browser resolves it by displaying whatever the
 * content type is. An SVG is displayable, so it is displayed.
 *
 * There are exactly two ways to make a browser download instead of display:
 *
 *   1. Server side: `Content-Disposition: attachment`. Correct for files the
 *      server produces (the ZIP, the manifest, a generated SVG endpoint).
 *   2. Client side: fetch the bytes, wrap them in a Blob, make an object URL, and
 *      click a synthetic anchor carrying `download`. Correct for files built in
 *      the browser (PNG rendered from a canvas) and for server files fetched as
 *      blobs.
 *
 * Both are here. `downloadResponse` performs (1) by issuing a navigation to a
 * URL that already carries the right headers; `downloadBlob` performs (2).
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS SHARED
 * ---------------------------------------------------------------------------
 * Three islands were each carrying their own copy of the object-URL dance, with
 * three different cleanup bugs. One implementation means one set of guarantees:
 *
 *   * the anchor is removed from the DOM, not just clicked;
 *   * the object URL is revoked — and revoked AFTER the click has been processed,
 * *   * revoking synchronously races the download in some browsers and produces
 *     an empty or corrupt file;
 *   * a caller that needs the bytes (PNG generation) can ask for them without
 *     triggering a save dialog.
 */

export interface DownloadResult {
  ok: boolean;
  /** the filename that was used, so the UI can confirm it */
  filename: string;
  error?: string;
}

/** Fallback filename when the caller cannot supply one. */
const FALLBACK = "download";

/**
 * Trigger a download for an in-memory blob.
 *
 * `revokeDelayMs` exists because of a real browser race: revoking the object URL
 * in the same tick as the click can cancel the download in Chromium. Waiting a
 * beat is the standard mitigation. Not configurable in practice — the one value
 * that works is the one that works — but named so the reason survives.
 */
export function downloadBlob(
  blob: Blob,
  filename: string,
  revokeDelayMs = 1000,
): DownloadResult {
  const name = sanitizeFilename(filename) || FALLBACK;

  // Second guard: the DOM attribute is a string, so a filename with a slash or a
  // NUL cannot be used to write outside the download folder by a well-behaved
  // browser, but it also cannot round-trip to the filesystem intact.
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";

  document.body.appendChild(anchor);
  anchor.click();
  // Remove the element. A left-behind anchor is inert but accumulates — and this
  // runs once per download, and a batch export can be 2000 of them.
  anchor.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, revokeDelayMs);

  return { ok: true, filename: name };
}

/**
 * Strip anything from a filename that would not survive a round trip to disk.
 *
 * Keeps the extension. Used on every generated filename, including ones derived
 * from user input (a batch number is user-supplied and becomes a filename).
 */
export function sanitizeFilename(value: string): string {
  const base = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return base.slice(0, 180);
}

/**
 * Download a server-produced file by navigating to it.
 *
 * Only correct when the response carries `Content-Disposition: attachment` — the
 * server route is responsible for that, and this function's doc comment on each
 * call site says so. Fetching it as a blob instead would work regardless of
 * headers, but would buffer the whole archive in memory before the user sees
 * anything, which is the opposite of what you want for a large ZIP.
 *
 * `link` element rather than `location.assign` so the current page is never
 * unloaded: navigating away would lose the batch detail page the user is about
 * to want to keep looking at.
 */
export function downloadFromUrl(url: string, filename?: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  if (filename) anchor.download = sanitizeFilename(filename);
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Fetch a URL and download it as a blob.
 *
 * For server files whose headers you cannot control, or where you want the
 * download to be visibly asynchronous (a progress state on the button) without
 * leaving the page.
 *
 * Reports failure instead of throwing: a download that silently does nothing is
 * the single most confusing outcome for the user, who pressed a button and is now
 * waiting for a file that will never arrive.
 */
export async function downloadUrlAsBlob(
  url: string,
  filename: string,
  init?: RequestInit,
): Promise<DownloadResult> {
  const name = sanitizeFilename(filename) || FALLBACK;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return { ok: false, filename: name, error: "Couldn't reach the server. Check your connection and try again." };
  }

  if (!response.ok) {
    // Surface the server's own message when it sent one — it is far more useful
    // than a generic failure, and this API's errors are written to be read.
    let message = `Download failed (${response.status}). Please try again.`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body && typeof body.error === "string" && body.error) message = body.error;
    } catch {
      /* not JSON; the generic message stands */
    }
    return { ok: false, filename: name, error: message };
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    return { ok: false, filename: name, error: "The download was interrupted. Please try again." };
  }

  downloadBlob(blob, name);
  return { ok: true, filename: name };
}
