/**
 * Profile + business form island: inline validation, conditional fields, and
 * image pickers.
 *
 * Progressive enhancement. Each behaviour here has a working no-JS path:
 *  - validation -> the server re-validates every POST and re-renders the field
 *    with its error; these rules are the same ones, run early
 *  - category -> `other` reveal is pre-computed server-side, so a reload shows
 *    the right field without JS
 *  - hours "closed" -> the time inputs are never disabled server-side, only
 *    dimmed, so a no-JS post still round-trips
 *  - image pickers -> the <input type="file"> posts directly to the form, which
 *    accepts multipart; JS only adds the instant preview and the R2 pre-upload
 *
 * Bundled to /js/profile.js. No dependencies.
 */

/** Same limits as src/lib/validate.ts. */
const MAX = {
  name: 80,
  businessName: 120,
  customCategory: 60,
  phone: 24,
  email: 254,
  url: 500,
  description: 1000,
};

const EMAIL_RE = /^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/;

function isPhone(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > MAX.phone) return false;
  if (!/^[+()\-.\s\d]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function isUrl(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > MAX.url) return false;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * Per-field validators, keyed by the input's `data-validate`.
 * Returns an error string, or null when the field is fine.
 */
const RULES: Record<string, (raw: string) => string | null> = {
  name: (v) => {
    if (!v.trim()) return "Name is required.";
    if (v.trim().length > MAX.name) return `Name must be ${MAX.name} characters or fewer.`;
    return null;
  },
  businessName: (v) => {
    if (!v.trim()) return "Business name is required.";
    if (v.trim().length > MAX.businessName)
      return `Business name must be ${MAX.businessName} characters or fewer.`;
    return null;
  },
  required: (v) => (v.trim() ? null : "This field is required."),
  email: (v) => (!v.trim() ? null : EMAIL_RE.test(v.trim()) ? null : "Enter a valid email address."),
  phone: (v) => (!v.trim() ? null : isPhone(v) ? null : "Enter a valid phone number (7–15 digits)."),
  url: (v) => (!v.trim() ? null : isUrl(v) ? null : "Enter a valid web address (e.g. example.com)."),
  customCategory: (v) => {
    if (v.trim().length > MAX.customCategory)
      return `Category must be ${MAX.customCategory} characters or fewer.`;
    return null;
  },
  description: (v) =>
    v.trim().length > MAX.description
      ? `Description must be ${MAX.description} characters or fewer.`
      : null,
};

// ---------------------------------------------------------------------------
// Inline validation
// ---------------------------------------------------------------------------

/** Any control we can hang a hint/error under. */
type FieldControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function fieldWrapper(input: FieldControl): HTMLElement {
  return (input.closest(".field") as HTMLElement) ?? input.parentElement!;
}

function showError(input: FieldControl, message: string | null): void {
  const wrap = fieldWrapper(input);
  const id = input.id || input.name || "field";
  let el = wrap.querySelector<HTMLElement>(`[data-error-for="${CSS.escape(id)}"]`);

  if (!message) {
    input.removeAttribute("aria-invalid");
    input.classList.remove("input-error", "select-error", "textarea-error");
    if (el) el.remove();
    // Re-link aria-describedby without the error node.
    syncDescribedBy(input);
    return;
  }

  input.setAttribute("aria-invalid", "true");
  input.classList.add(
    input.tagName === "TEXTAREA" ? "textarea-error" : "input-error",
  );

  if (!el) {
    el = document.createElement("p");
    el.className = "field-error";
    el.setAttribute("role", "alert");
    el.id = `${id}-error`;
    el.setAttribute("data-error-for", id);
    wrap.appendChild(el);
  }
  el.textContent = message;
  syncDescribedBy(input);
}

/** Keep aria-describedby pointing at the hint and, when present, the error. */
function syncDescribedBy(input: FieldControl): void {
  const wrap = fieldWrapper(input);
  const id = input.id || input.name || "field";
  const ids: string[] = [];
  const hint = wrap.querySelector<HTMLElement>(`[data-hint-for="${CSS.escape(id)}"]`);
  if (hint) ids.push(hint.id);
  const err = wrap.querySelector<HTMLElement>(`[data-error-for="${CSS.escape(id)}"]`);
  if (err) ids.push(err.id);
  if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
  else input.removeAttribute("aria-describedby");
}

/** Seed a hint with a stable id so the client can wire aria-describedby. */
function tagHints(scope: ParentNode): void {
  scope.querySelectorAll<HTMLElement>(".field-hint").forEach((hint) => {
    if (hint.id) return;
    const control = hint.parentElement?.querySelector<HTMLElement>("[id]");
    if (!control?.id) return;
    hint.id = `${control.id}-hint`;
    hint.setAttribute("data-hint-for", control.id);
  });
}

function validateInput(input: HTMLInputElement | HTMLTextAreaElement): string | null {
  const rule = input.getAttribute("data-validate");
  if (!rule) return null;
  const fn = RULES[rule];
  if (!fn) return null;
  if (input.getAttribute("data-when") && !isFieldActive(input)) return null;
  return fn(input.value);
}

/** A field with `data-when="<condition>"` only applies inside its condition. */
function isFieldActive(input: HTMLElement): boolean {
  const cond = input.getAttribute("data-when");
  if (!cond) return true;
  const [name, expected] = cond.split("=");
  const control = document.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[name="${name}"]`,
  );
  return control ? control.value === expected : true;
}

function initValidation(): void {
  document.querySelectorAll<HTMLElement>("[data-validate]").forEach((input) => {
    const el = input as HTMLInputElement;

    // Validate on blur (don't yell while someone is still typing the first
    // character), then live once the field has been touched.
    el.addEventListener("blur", () => {
      el.dataset.touched = "1";
      showError(el, validateInput(el));
    });
    el.addEventListener("input", () => {
      if (el.dataset.touched === "1") showError(el, validateInput(el));
    });
  });

  // Re-check dependent fields when a condition source changes (e.g. picking
  // "Other" turns custom category on, picking it again must clear its error).
  document.querySelectorAll<HTMLElement>("[data-when-source]").forEach((src) => {
    src.addEventListener("change", () => {
      document.querySelectorAll<HTMLElement>("[data-when]").forEach((dep) => {
        if (dep.getAttribute("data-when")?.startsWith(`${src.getAttribute("name")}=`)) {
          showError(dep as HTMLInputElement, validateInput(dep as HTMLInputElement));
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Custom category reveal
// ---------------------------------------------------------------------------

function initCategoryReveal(): void {
  const select = document.querySelector<HTMLSelectElement>("[data-category-select]");
  if (!select) return;
  const apply = (): void => {
    const wrap = document.querySelector<HTMLElement>("[data-custom-category]");
    if (!wrap) return;
    const isOther = select.value === "other";
    wrap.hidden = !isOther;
    const input = wrap.querySelector<HTMLInputElement>("input");
    if (input) {
      input.required = isOther;
      input.disabled = !isOther;
      if (!isOther) {
        input.value = "";
        showError(input, null);
      }
    }
  };
  select.addEventListener("change", apply);
  apply();
}

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

function initHours(): void {
  document.querySelectorAll<HTMLInputElement>("[data-hours-closed]").forEach((box) => {
    const row = box.closest<HTMLElement>("[data-hours-row]");
    if (!row) return;
    const apply = (): void => {
      row.classList.toggle("hours-closed", box.checked);
      row.querySelectorAll<HTMLInputElement>('input[type="time"]').forEach((t) => {
        // Not `disabled` — a disabled input is not submitted, so a closed day
        // would lose its stored times. Dim it and ignore it server-side.
        t.readOnly = box.checked;
        t.classList.toggle("input-muted", box.checked);
      });
    };
    box.addEventListener("change", apply);
    apply();
  });
}

// ---------------------------------------------------------------------------
// Image pickers (avatar / logo)
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 1_000_000;

function initPickers(): void {
  document.querySelectorAll<HTMLElement>("[data-picker]").forEach((root) => {
    const fileInput = root.querySelector<HTMLInputElement>('input[type="file"]');
    const keyInput = root.querySelector<HTMLInputElement>("[data-picker-key]");
    const removeBtn = root.querySelector<HTMLElement>("[data-picker-remove]");
    const stage = root.querySelector<HTMLElement>("[data-picker-stage]");
    const status = root.querySelector<HTMLElement>("[data-picker-status]");
    const existing = root.getAttribute("data-picker-src") || "";
    // Where the object is filed in R2, and how we call it in user-facing copy.
    // Avatar and logo are separate namespaces server-side, and
    // `ownsKey` re-checks the prefix on submit — so a mismatched scope would
    // silently discard the upload.
    const scope = root.getAttribute("data-picker-scope") === "logo" ? "logo" : "avatar";
    const noun = scope === "avatar" ? "Image" : "Logo";
    let objectUrl: string | null = null;

    const setStatus = (message: string, tone: "ok" | "err" | "busy" = "ok"): void => {
      if (!status) return;
      status.textContent = message;
      status.className = `picker-status picker-status-${tone}`;
    };

    const setBusy = (busy: boolean): void => {
      root.classList.toggle("picker-busy", busy);
      if (fileInput) fileInput.disabled = busy;
      if (removeBtn) removeBtn.setAttribute("aria-disabled", busy ? "true" : "false");
    };

    const render = (src: string | null): void => {
      if (!stage) return;
      stage.innerHTML = "";
      if (src) {
        const img = document.createElement("img");
        img.className = "picker-preview-img";
        img.alt = "";
        img.src = src;
        img.addEventListener("error", () => {
          img.remove();
          stage.classList.remove("picker-stage-has-image");
        });
        stage.appendChild(img);
        stage.classList.add("picker-stage-has-image");
      } else {
        stage.textContent = stage.getAttribute("data-picker-initials") || "";
        stage.classList.remove("picker-stage-has-image");
      }
    };

    fileInput?.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) {
        setStatus("Choose an image file (PNG, JPG, WebP, GIF or SVG).", "err");
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setStatus(`${noun} must be 1MB or smaller.`, "err");
        return;
      }
      setStatus("Uploading…", "busy");
      setBusy(true);

      const reader = new FileReader();
      reader.onerror = () => {
        setStatus("Could not read that file. Please try again.", "err");
        setBusy(false);
      };
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        render(dataUrl);
        fetch(`/api/upload?scope=${scope}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: dataUrl, contentType: file.type }),
        })
          .then(async (res) => {
            const json = (await res.json()) as {
              ok?: boolean;
              key?: string;
              error?: string;
            };
            if (!res.ok || !json.ok || !json.key) {
              throw new Error(json.error || "Upload failed. Please try again.");
            }
            return json.key;
          })
          .then((key) => {
            if (keyInput) keyInput.value = key;
            root.setAttribute("data-picker-src", key);
            setStatus("Ready to save.", "ok");
            setBusy(false);
            if (removeBtn) removeBtn.hidden = false;
          })
          .catch((err: Error) => {
            render(existing);
            setStatus(err.message || "Upload failed. Please try again.", "err");
            setBusy(false);
          });
      };
      reader.readAsDataURL(file);
    });

    removeBtn?.addEventListener("click", () => {
      if (keyInput) keyInput.value = "";
      if (fileInput) fileInput.value = "";
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      root.removeAttribute("data-picker-src");
      render(null);
      removeBtn.hidden = true;
      setStatus(`${noun} removed. Save to keep this change.`, "ok");
    });

    // Reveal the "Remove" affordance only when there is something to remove.
    if (removeBtn && !existing) removeBtn.hidden = true;
    if (stage && !existing) render(null);
  });
}

// ---------------------------------------------------------------------------
// Unsaved-changes guard
// ---------------------------------------------------------------------------

function initDirtyGuard(): void {
  document.querySelectorAll<HTMLFormElement>("[data-dirty-guard]").forEach((form) => {
    let dirty = false;
    form.addEventListener("input", () => {
      dirty = true;
    });
    form.addEventListener("submit", () => {
      dirty = false;
    });
    window.addEventListener("beforeunload", (event) => {
      if (!dirty) return;
      event.preventDefault();
      // Browsers ignore custom text here; the confirmation is the point.
      event.returnValue = "";
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot(): void {
  document.querySelectorAll<FieldControl>("[data-validate]").forEach((input) => {
    input.setAttribute("data-hint-for", input.id || input.name || "");
  });
  tagHints(document);
  initValidation();
  initCategoryReveal();
  initHours();
  initPickers();
  initDirtyGuard();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
