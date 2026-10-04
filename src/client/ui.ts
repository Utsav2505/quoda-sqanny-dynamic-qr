/**
 * Shared UI island: toasts, modals, and disclosure dropdowns.
 *
 * Progressive enhancement only. Every one of these surfaces is inert without
 * this file — the toast stack renders server-side toasts that dismiss on their
 * own timer only here, modals have a `[data-modal-open]` button to reveal them,
 * and the business/account dropdowns have no equivalent fallback by design
 * (their content is duplicated as plain links elsewhere in the page).
 *
 * Bundled to /js/ui.js by scripts/build-client.mjs. No dependencies.
 */

/** Escape HTML before interpolating anything into a toast. */
function esc(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const TOAST_ICON: Record<string, string> = {
  success: "check",
  danger: "close",
  neutral: "qr",
};

let stack: HTMLElement | null = null;

function toastStack(): HTMLElement | null {
  if (stack) return stack;
  stack = document.querySelector<HTMLElement>("[data-toast-stack]");
  return stack;
}

function dismiss(toast: HTMLElement): void {
  toast.hidden = true;
  const parent = toast.parentElement;
  if (parent) parent.removeChild(toast);
}

/**
 * Show a transient toast. Exposed on window so route-specific islands can
 * report the outcome of a fetch without owning a second toast system.
 */
function showToast(
  message: string,
  tone: "success" | "danger" | "neutral" = "neutral",
  title?: string,
): void {
  const host = toastStack();
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast toast-${tone}`;
  el.setAttribute("role", "status");
  el.setAttribute("data-toast", "");
  el.innerHTML =
    `<span class="toast-icon" aria-hidden="true">` +
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${TOAST_ICON[tone] === "check" ? "M20 6 9 17l-5-5" : "M18 6 6 18M6 6l12 12"}"/></svg>` +
    `</span>` +
    `<div class="toast-content">` +
    (title ? `<p class="toast-title t-ui-label">${esc(title)}</p>` : "") +
    `<div class="toast-message t-body-sm">${esc(message)}</div>` +
    `</div>` +
    `<button type="button" class="toast-close" data-toast-close aria-label="Dismiss">` +
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>` +
    `</button>`;
  host.appendChild(el);

  el.querySelector("[data-toast-close]")?.addEventListener("click", () => dismiss(el));
  // Errors linger: a failure the user has not read is a failure they will hit
  // again. Successes clear out.
  window.setTimeout(() => dismiss(el), tone === "danger" ? 9000 : 4500);
}

function initToasts(): void {
  document.querySelectorAll<HTMLElement>("[data-toast]").forEach((el) => {
    el.querySelector("[data-toast-close]")?.addEventListener("click", () => {
      const parent = el.parentElement;
      if (parent) parent.removeChild(el);
    });
    window.setTimeout(() => {
      const parent = el.parentElement;
      if (parent) parent.removeChild(el);
    }, 5000);
  });

  // `?notice=...` flashes are rendered server-side; auto-dismiss on arrival.
  // The flash is its own component (`.flash-*`, not `.toast-*`) but behaves
  // identically, so it shares this path rather than getting a second timer.
  const host = toastStack();
  if (host) {
    host.querySelectorAll("[data-toast]").forEach((el) => {
      window.setTimeout(() => {
        const parent = el.parentElement;
        if (parent) parent.removeChild(el);
      }, 5000);
    });
  }

  document.querySelectorAll<HTMLElement>(".flash").forEach((el) => {
    window.setTimeout(() => el.remove(), 6000);
    el.querySelector("[data-flash-dismiss]")?.addEventListener("click", () => {
      el.remove();
    });
  });
}

// ---------------------------------------------------------------------------
// Dropdowns (business switcher, account menu)
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function closeDropdown(root: HTMLElement): void {
  const panel = root.querySelector<HTMLElement>("[data-dropdown-panel]");
  const trigger = root.querySelector<HTMLElement>("[data-dropdown-trigger]");
  if (panel) panel.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
}

function openDropdown(root: HTMLElement): void {
  const panel = root.querySelector<HTMLElement>("[data-dropdown-panel]");
  const trigger = root.querySelector<HTMLElement>("[data-dropdown-trigger]");
  if (panel) panel.hidden = false;
  if (trigger) trigger.setAttribute("aria-expanded", "true");
}

function initDropdowns(): void {
  const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-dropdown]"));

  roots.forEach((root) => {
    const trigger = root.querySelector<HTMLElement>("[data-dropdown-trigger]");
    if (!trigger) return;

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = trigger.getAttribute("aria-expanded") === "true";
      // One menu open at a time — two stacked panels read as a broken layout.
      roots.forEach((other) => {
        if (other !== root) closeDropdown(other);
      });
      if (isOpen) closeDropdown(root);
      else openDropdown(root);
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openDropdown(root);
      const panel = root.querySelector<HTMLElement>("[data-dropdown-panel]");
      panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });

    // A click inside a form-submitting menu shouldn't also close-then-navigate
    // in a way that swallows the submit; close on click and let the form post.
    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("a[href]")) closeDropdown(root);
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    if (!target) return;
    roots.forEach((root) => {
      if (!root.contains(target)) closeDropdown(root);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    roots.forEach((root) => {
      const trigger = root.querySelector<HTMLElement>("[data-dropdown-trigger]");
      if (trigger && trigger.getAttribute("aria-expanded") === "true") {
        closeDropdown(root);
        trigger.focus();
      }
    });
  });

  // Tabbing out of an open panel should close it.
  document.addEventListener("focusin", (event) => {
    const target = event.target as Node | null;
    roots.forEach((root) => {
      if (target && !root.contains(target)) closeDropdown(root);
    });
  });
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

const modalStack: HTMLElement[] = [];

function openModal(root: HTMLElement): void {
  const panel = root.querySelector<HTMLElement>(".modal");
  if (!panel) return;
  root.hidden = false;
  document.body.classList.add("modal-open");
  modalStack.push(root);
  const target =
    panel.querySelector<HTMLElement>("[data-autofocus]") ??
    panel.querySelector<HTMLElement>(FOCUSABLE);
  if (target) target.focus();
}

function closeModal(root: HTMLElement): void {
  root.hidden = true;
  document.body.classList.remove("modal-open");
  const idx = modalStack.indexOf(root);
  if (idx !== -1) modalStack.splice(idx, 1);
  root.querySelector<HTMLElement>("[data-modal-open]")?.focus();
}

function initModals(): void {
  document.querySelectorAll<HTMLElement>("[data-modal]").forEach((root) => {
    root.querySelector("[data-modal-backdrop]")?.addEventListener("click", () => closeModal(root));
    root.querySelectorAll("[data-modal-close]").forEach((el) =>
      el.addEventListener("click", () => closeModal(root)),
    );
  });

  document.querySelectorAll<HTMLElement>("[data-modal-open]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const id = trigger.getAttribute("data-modal-open");
      if (!id) return;
      const root = document.getElementById(id);
      if (root) openModal(root);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !modalStack.length) return;
    const top = modalStack[modalStack.length - 1];
    closeModal(top);
  });

  // Focus trap: the first/last sentinels (rendered by the Modal component) cycle
  // Tab at the edges. A dialog you can tab out of is not a dialog.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !modalStack.length) return;
    const top = modalStack[modalStack.length - 1];
    const panel = top.querySelector<HTMLElement>(".modal");
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Form guards
// ---------------------------------------------------------------------------

/**
 * Prevent duplicate submissions and surface a real in-flight state.
 *
 * A double-submitted archive is two archives; a double-submitted claim is two
 * flash messages and a race the user did not intend. The button is disabled and
 * relabelled on submit, and re-enabled if the browser restores the page from
 * bfcache.
 *
 * The button that gets disabled is `event.submitter` — the one the user actually
 * pressed. The previous version always took the FIRST `button[type="submit"]` in
 * the form, which is wrong for the business switcher: its single form contains one
 * submit button per business, so pressing "Riverside Diner" would have disabled
 * "All businesses" and left the pressed row looking inert.
 */
function initSubmitGuards(): void {
  document.querySelectorAll<HTMLFormElement>("[data-guard-submit]").forEach((form) => {
    if (form.dataset.guarded === "1") return;
    form.dataset.guarded = "1";
    form.addEventListener("submit", (event) => {
      const submitter =
        (event as SubmitEvent).submitter instanceof HTMLElement
          ? ((event as SubmitEvent).submitter as HTMLElement)
          : null;
      // Fall back to the first submit button only when the browser does not
      // report a submitter (older Safari), which is the common single-button case.
      const btn =
        (submitter && submitter.matches('button[type="submit"], input[type="submit"]')
          ? submitter
          : null) ?? form.querySelector<HTMLElement>('button[type="submit"]');
      if (!btn) return;

      btn.setAttribute("aria-busy", "true");
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      else btn.setAttribute("aria-disabled", "true");

      const label = btn.querySelector(".btn-label");
      if (label) {
        btn.setAttribute("data-original-label", label.textContent || "");
        label.textContent =
          btn.getAttribute("data-busy-label") ||
          form.getAttribute("data-busy-label") ||
          "Working…";
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    sqannyToast: typeof showToast;
  }
}

window.sqannyToast = showToast;

function boot(): void {
  initToasts();
  initDropdowns();
  initModals();
  initSubmitGuards();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
