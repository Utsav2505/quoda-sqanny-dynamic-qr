// Scan enrichment tracker — hosted landing pages only.
//
// Loaded ONLY on a /p/:slug page whose request carried a fresh scan correlation
// cookie (the server decides this, so an ordinary page view ships no beacon at
// all). The cookie is HttpOnly: this script never reads it, it simply posts to
// the same origin, so the browser attaches the token on its own.
//
// WHAT THIS SCRIPT MUST NEVER DO
// No canvas hashing, no font enumeration, no audio or battery probing, no
// WebGL renderer strings, no navigator.plugins walk. Those are fingerprinting.
// The moment a fingerprint primitive appears in this file, it stops being
// analytics and becomes a tracker, and that line cannot be uncrossed. The
// fields below are all things a user would freely volunteer in a bug report.

interface Measurements {
  screen_w?: number;
  screen_h?: number;
  viewport_w?: number;
  viewport_h?: number;
  dpr?: number;
  color_depth?: number;
  touch_points?: number;
  timezone?: string;
  hardware_concurrency?: number;
  device_memory?: number;
  geo_lat?: number;
  geo_lon?: number;
  geo_accuracy_m?: number;
}

/** How long to wait for a position before giving up and sending without it. */
const GEO_TIMEOUT_MS = 3000;

function collect(): Measurements {
  const out: Measurements = {};
  const nav = navigator as Navigator & { deviceMemory?: number };
  const screen = window.screen;

  if (screen) {
    out.screen_w = screen.width;
    out.screen_h = screen.height;
    out.color_depth = screen.colorDepth;
  }
  out.viewport_w = window.innerWidth;
  out.viewport_h = window.innerHeight;
  out.dpr = window.devicePixelRatio;
  out.touch_points = navigator.maxTouchPoints ?? 0;

  try {
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* Intl unavailable — timezone simply stays unset */
  }
  if (typeof nav.hardwareConcurrency === "number") {
    out.hardware_concurrency = nav.hardwareConcurrency;
  }
  if (typeof nav.deviceMemory === "number") {
    out.device_memory = nav.deviceMemory;
  }
  return out;
}

/**
 * Read a position ONLY if permission was already granted.
 *
 * `navigator.permissions.query` never shows a dialog — it reports the current
 * state. Calling `getCurrentPosition` when the state is "prompt" is what causes
 * the browser to ask, so that path is deliberately never taken. A user who has
 * never been asked, or who said no, simply gets no coordinates.
 */
function withGeolocation(base: Measurements): Promise<Measurements> {
  if (!navigator.geolocation || !navigator.permissions?.query) {
    return Promise.resolve(base);
  }
  return navigator.permissions
    .query({ name: "geolocation" as PermissionName })
    .then((status) => {
      if (status.state !== "granted") return base;
      return new Promise<Measurements>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            resolve({
              ...base,
              geo_lat: pos.coords.latitude,
              geo_lon: pos.coords.longitude,
              geo_accuracy_m: pos.coords.accuracy,
            }),
          // Error or timeout: ship what we have.
          () => resolve(base),
          { enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: 600_000 },
        );
      });
    })
    .catch(() => base);
}

function send(data: Measurements): void {
  const body = JSON.stringify(data);
  // sendBeacon survives page unload, unlike fetch, and is never awaited — the
  // page is already interactive by the time this runs.
  if (navigator.sendBeacon) {
    navigator.sendBeacon(
      "/api/enrich",
      new Blob([body], { type: "application/json" }),
    );
    return;
  }
  void fetch("/api/enrich", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  }).catch(() => {
    /* analytics must never surface an error to the visitor */
  });
}

function run(): void {
  const base = collect();
  void withGeolocation(base).then(send);
}

// Idle so the measurement never competes with the page's own rendering work.
if ("requestIdleCallback" in window) {
  (window as Window & { requestIdleCallback: (cb: () => void) => void })
    .requestIdleCallback(run);
} else {
  setTimeout(run, 200);
}
