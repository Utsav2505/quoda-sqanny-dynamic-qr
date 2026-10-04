// The camera scanner island.
//
// Design decision that shapes this whole file: THE CAMERA IS ONLY AN INPUT
// METHOD. When a code is decoded it is written into the same form field a human
// would have typed into, and that form is submitted normally. Nothing downstream
// of the decode is JavaScript-dependent, so the camera adds a faster way in
// without adding a second implementation of the flow — which is the failure
// mode section 31 of the spec is asking us to avoid. With scripting off, the
// manual field below is the whole interface and the flow is unchanged.
//
// Privacy: the video never leaves the device. Frames are drawn to an offscreen
// canvas, decoded in-page, and the stream is stopped the moment a code is found.

import jsQR from "jsqr";

// The serial decoder is imported from the shared domain lib rather than
// reimplemented here. The camera uses it only to skip a pointless submit; the
// server re-validates with the very same function before anything is looked up,
// so the two entry points cannot drift into disagreeing about what a valid
// stand looks like. This island is a client bundle, so it must reach a module
// that has no server-only imports.
import { serialFromPayload } from "../lib/qr-registration";

// Re-exported under the island's own name so there is exactly one decoder with
// two aliases, and a test can assert the server and the camera are literally
// running the same function rather than two copies that look alike.
export { serialFromPayload as serialFrom } from "../lib/qr-registration";

/**
 * Scanner states, mirroring the ones the spec enumerates. `data-scanner-state`
 * on the root is what the CSS and the tests read, so the visual state and the
 * machine state can never drift apart.
 */
type ScannerState =
  | "idle"
  | "initializing"
  | "scanning"
  | "success"
  | "invalid"
  | "error"
  | "permission-denied"
  | "unavailable";

const COPY: Record<ScannerState, { title: string; hint: string }> = {
  idle: {
    title: "Point your camera at the QR code.",
    hint: "The code is on the Sqanny Stand you want to connect.",
  },
  initializing: {
    title: "Starting camera…",
    hint: "Allow camera access if your browser asks.",
  },
  scanning: {
    title: "Point your camera at the QR code.",
    hint: "Hold it steady until the code is recognised.",
  },
  success: {
    title: "QR detected",
    hint: "Reading the code…",
  },
  invalid: {
    title: "That's not a Sqanny QR code.",
    hint: "Point at the code printed on your stand, or type the code printed underneath it.",
  },
  error: {
    title: "Camera unavailable",
    hint: "Something stopped the camera from starting. Enter the code manually instead.",
  },
  "permission-denied": {
    title: "Camera access is blocked.",
    hint: "Allow camera access in your browser settings, or enter the QR code manually.",
  },
  unavailable: {
    title: "Camera unavailable",
    hint: "This device has no camera we can use. Enter the QR code manually.",
  },
};

function setState(root: HTMLElement, state: ScannerState): void {
  root.dataset.scannerState = state;
  const { title, hint } = COPY[state];
  for (const el of root.querySelectorAll<HTMLElement>("[data-scan-title]")) {
    el.textContent = title;
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-scan-hint]")) {
    el.textContent = hint;
  }
  // Screen readers get the same change as sighted users, and it is a live
  // region so a state change is announced rather than silently swapped.
  const live = root.querySelector<HTMLElement>("[data-scan-live]");
  if (live) live.textContent = `${title} ${hint}`;
}

/**
 * Pull a serial out of whatever the camera decoded.
 *
 * Deliberately NOT reimplemented here: this is the same function the server
 * uses to validate the submission, imported from the shared domain lib. The
 * check is only a pre-filter to save a pointless submit — the server re-validates
 * the serial and is the only thing that decides whether the code exists and who
 * owns it.
 */


export function initScanner(root: HTMLElement): void {
  // NOTE the two distinct hooks. `data-scan-manual` is the BUTTON that asks for
  // the fallback; `data-scan-manual-panel` is the container it reveals. These
  // used to share one attribute, which meant the first match in document order
  // (the button) was treated as the panel — so the panel was never revealed and
  // the manual input was unreachable. One attribute, one meaning.
  const el = {
    video: root.querySelector<HTMLVideoElement>("[data-scan-video]"),
    input: root.querySelector<HTMLInputElement>("[data-scan-input]"),
    form: root.querySelector<HTMLFormElement>("[data-scan-form]"),
    panel: root.querySelector<HTMLElement>("[data-scan-manual-panel]"),
  };

  setState(root, "idle");
  if (!el.video || !el.input || !el.form) return;

  // Bind to non-null locals. TypeScript's narrowing from the guard above does
  // not carry into the closures below, and re-asserting in each one would be
  // noise that hides the real invariant: if we got here, all three exist.
  const video: HTMLVideoElement = el.video;
  const input: HTMLInputElement = el.input;
  const form: HTMLFormElement = el.form;
  const panel: HTMLElement | null = el.panel;

  let stream: MediaStream | null = null;
  let raf = 0;

  // Every start() claims a ticket. Any async continuation that resumes after a
  // newer start (or after a teardown) sees a stale ticket and bails instead of
  // resurrecting a stream the user already dismissed. This is what makes
  // "press retry after fixing camera permissions" safe.
  let ticket = 0;

  // Reused across frames rather than allocated per frame; decoding a 480px
  // frame 60 times a second should not also produce 60 canvases a second.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // --- lifecycle ------------------------------------------------------------

  /**
   * Tear the camera down but leave the page able to start again.
   *
   * This is deliberately NOT the same as giving up. Permission-denied and
   * invalid-QR are recoverable: the user may enable the camera in settings, or
   * simply retake the photo, so the start button has to keep working. An
   * earlier version set a sticky `stopped` flag here, which meant one tab-switch
   * or one denied prompt permanently disabled the camera for the rest of the
   * visit.
   */
  function stopStream(): void {
    ticket++;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    video.srcObject = null;
  }

  function showManual(): void {
    if (panel) panel.hidden = false;
    focusManual();
  }

  function focusManual(): void {
    panel?.querySelector<HTMLInputElement>("[data-scan-input], input")?.focus();
  }

  /** Every failure path funnels here so the user is never trapped. */
  function fail(state: "permission-denied" | "unavailable" | "error"): void {
    stopStream();
    setState(root, state);
    showManual();
  }

  // --- decoding -------------------------------------------------------------

  function accept(serial: string): void {
    // Stop FIRST, then submit. Section 6 asks for this explicitly: continuing
    // to scan would fire a second submit for the same frame and could start a
    // second claim for a QR the first submit is already claiming.
    stopStream();
    setState(root, "success");
    input.value = serial;
    form.submit();
  }

  function tick(): void {
    if (!stream) return;
    if (video.readyState === video.HAVE_CURRENT_DATA && video.videoWidth > 0 && ctx) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      // A downscaled copy is plenty for a 6-glyph serial and keeps the
      // per-frame cost low enough to hold 60fps on a phone.
      const scale = Math.min(1, 480 / Math.max(w, h));
      const cw = Math.max(1, Math.floor(w * scale));
      const ch = Math.max(1, Math.floor(h * scale));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      ctx.drawImage(video, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch);
      const found = jsQR(data.data, cw, ch, { inversionAttempts: "dontInvert" });
      if (found?.data) {
        const serial = serialFromPayload(found.data);
        if (serial) {
          accept(serial);
          return;
        }
        // A QR, but not one of ours. Say so in place, and keep the camera
        // startable so a retake is one click away. Reporting this as
        // "camera unavailable" was actively misleading: the camera worked
        // fine, the code was just the wrong kind.
        stopStream();
        setState(root, "invalid");
        showManual();
        return;
      }
    }
    raf = requestAnimationFrame(tick);
  }

  // --- start ----------------------------------------------------------------

  async function start(): Promise<void> {
    stopStream();
    const mine = ++ticket;
    setState(root, "initializing");

    if (!navigator.mediaDevices?.getUserMedia) {
      fail("unavailable");
      return;
    }

    let acquired: MediaStream;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (err) {
      // Distinguish "you said no" from "there isn't one", because the fix the
      // user needs is completely different for each.
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        fail("permission-denied");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        fail("unavailable");
      } else {
        fail("error");
      }
      return;
    }

    // The user hit a fallback (or left the tab) while the permission prompt was
    // up. Release the camera immediately rather than attaching a stream nobody
    // is watching.
    if (mine !== ticket) {
      for (const t of acquired.getTracks()) t.stop();
      return;
    }

    stream = acquired;
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    try {
      await video.play();
    } catch {
      if (mine !== ticket) return;
      fail("error");
      return;
    }
    if (mine !== ticket) return;
    setState(root, "scanning");
    raf = requestAnimationFrame(tick);
  }

  // --- wiring ---------------------------------------------------------------

  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-scan-start]")) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      // Starting the camera reveals the manual field too, so the escape hatch
      // is on screen from the first frame rather than hidden behind a failure.
      if (panel) panel.hidden = false;
      void start();
    });
  }
  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-scan-manual]")) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      stopStream();
      showManual();
    });
  }
  // Stop the camera whenever the page goes away, or the indicator light stays on
  // after the user has moved on. This only releases the hardware; the button
  // still works if they come back to the tab.
  window.addEventListener("pagehide", stopStream);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopStream();
  });
}

export function boot(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-scanner]")) {
    initScanner(el);
  }
}

// `typeof document` rather than a bare check so importing this module in a
// Node test does not throw at import time.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}
