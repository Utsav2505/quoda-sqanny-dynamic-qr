/**
 * Batch generator island.
 *
 * Progressive enhancement, like every other island in this app. The form posts to
 * the server and works with scripting disabled; this file adds only the things
 * that genuinely cannot be done without a browser:
 *
 *   - a LIVE preview, recomputed as you type, so the codes are visible before
 *     anything is created;
 *   - add/remove custom metadata rows, so the form does not need a full submit to
 *     add a field;
 *   - inline validation using the same rules the server enforces.
 *
 * It is deliberately NOT responsible for submitting the batch. That is a form POST
 * in the established pattern (`data-guard-submit` gives the button its in-flight
 * state), and reimplementing it with fetch would mean a second error-rendering
 * path and a second double-submission guard for no gain.
 *
 * The domain rules are imported from src/lib/batch.ts, so the preview is computed
 * by the same code that will generate the batch. esbuild inlines this import into
 * the bundle, which means the browser holds a copy of those rules — a copy of
 * THIS file's logic, not a re-implementation of it. If the rules change, the
 * preview changes with them.
 *
 * Bundled to /js/batch.js. No dependencies.
 */

import {
  BATCH_METADATA_MAX,
  BATCH_SIZE_MULTIPLE,
  formatSequence,
  parseSequence,
  previewBatch,
  resolveBatchNumber,
  resolveBatchSize,
  resolveBatchType,
  type BatchFieldErrors,
  type BatchMetadataField,
} from "../lib/batch";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function esc(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function formField(input: Control): HTMLElement | null {
  return (input.closest(".field") as HTMLElement) ?? input.parentElement;
}

/**
 * Show or clear one field's error, wired to aria the same way the server-rendered
 * markup does it, so a client-side error and a server-side error are announced
 * identically.
 */
function setFieldError(input: Control | null, message: string | null): void {
  if (!input) return;
  const wrap = formField(input);
  if (!wrap) return;
  const key = input.id || input.name || "field";
  const existing = wrap.querySelector<HTMLElement>(`[data-error-for="${CSS.escape(key)}"]`);

  if (!message) {
    input.removeAttribute("aria-invalid");
    input.classList.remove("input-error", "select-error", "textarea-error");
    if (existing) existing.remove();
    syncDescribedBy(input);
    return;
  }

  input.setAttribute("aria-invalid", "true");
  input.classList.add(
    input.tagName === "TEXTAREA" ? "textarea-error" : "input-error",
  );
  let el = existing;
  if (!el) {
    el = document.createElement("p");
    el.className = "field-error";
    el.setAttribute("role", "alert");
    el.id = `${key}-error`;
    el.setAttribute("data-error-for", key);
    wrap.appendChild(el);
  }
  el.textContent = message;
  syncDescribedBy(input);
}

function syncDescribedBy(input: Control): void {
  const wrap = formField(input);
  if (!wrap) return;
  const key = input.id || input.name || "field";
  const ids: string[] = [];
  const hint = wrap.querySelector<HTMLElement>(`[data-hint-for="${CSS.escape(key)}"]`);
  if (hint) ids.push(hint.id);
  const err = wrap.querySelector<HTMLElement>(`[data-error-for="${CSS.escape(key)}"]`);
  if (err) ids.push(err.id);
  if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
  else input.removeAttribute("aria-describedby");
}

// ---------------------------------------------------------------------------
// Validation — mirrors the server's rules
// ---------------------------------------------------------------------------

type Validator = (raw: string) => string | null;

const RULES: Record<string, Validator> = {
  batchType: (v) => resolveBatchType(v).error,
  batchNumber: (v) => resolveBatchNumber(v).error,
  batchSequence: (v) => {
    if (!v.trim()) return "Starting sequence is required.";
    if (parseSequence(v) === null) return "Starting sequence must be a number.";
    return null;
  },
  batchSize: (v) => resolveBatchSize(v).error,
  // Empty is allowed: a stand can be printed before anyone knows where it points.
  batchDestination: (v) => {
    if (!v.trim()) return null;
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "Enter a valid web address.";
      if (!u.hostname.includes(".")) return "Enter a valid web address.";
      return null;
    } catch {
      return "Enter a valid web address, or leave it blank.";
    }
  },
};

function validateControl(input: Control): string | null {
  const key = input.getAttribute("data-validate");
  if (!key) return null;
  const rule = RULES[key];
  if (!rule) return null;
  return rule(input.value);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Read the live form state into the shape the domain functions take. */
function readValues(form: HTMLFormElement): {
  sequenceStart: string;
  batchNumber: string;
  type: string;
  batchSize: string;
  destination: string;
  businessId: string;
  metadata: BatchMetadataField[];
} {
  const get = (name: string): string => {
    const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
    return el ? el.value : "";
  };
  return {
    sequenceStart: get("sequence_start"),
    batchNumber: get("batch_number"),
    type: get("type"),
    batchSize: get("batch_size"),
    destination: get("destination"),
    businessId: get("business_id"),
    metadata: readMetadataRows(form),
  };
}

function readMetadataRows(form: HTMLFormElement): BatchMetadataField[] {
  const rows: BatchMetadataField[] = [];
  form.querySelectorAll<HTMLElement>("[data-meta-row]").forEach((row) => {
    const name = row.querySelector<HTMLInputElement>('[data-meta="name"]')?.value ?? "";
    const value = row.querySelector<HTMLInputElement>('[data-meta="value"]')?.value ?? "";
    if (name.trim() || value.trim()) rows.push({ name, value });
  });
  return rows;
}

/**
 * Repaint the preview.
 *
 * Purely local: no record is created and no QR is generated to produce it. The
 * range shown is computed from the same `previewBatch` the server will call, so
 * what is previewed is what will be made.
 */
function renderPreview(host: HTMLElement, form: HTMLFormElement): void {
  const preview = previewBatch(readValues(form));

  if (!preview) {
    host.innerHTML =
      `<p class="t-body text-secondary" data-preview-empty>` +
      `Fill in Type, Batch No., Starting Sequence and Batch Size to see ` +
      `the codes this batch will produce.</p>`;
    return;
  }

  const sample =
    preview.sample.length > 2
      ? `<p class="field-hint">Including</p>` +
        `<ul class="batch-preview-sample">${preview.sample
          .map((s) => `<li class="tnum">${esc(s)}</li>`)
          .join("")}</ul>`
      : "";

  const digitNote = preview.crossesDigitBoundary
    ? `<p class="batch-preview-note t-body-sm" data-digit-note>` +
      `This range crosses from 3-digit to 4-digit sequences. That&rsquo;s ` +
      `supported &mdash; the codes just get longer.</p>`
    : "";

  host.innerHTML =
    `<dl class="claim-recap">` +
    row("Type", esc(preview.type)) +
    row("Batch", esc(preview.batchNumber)) +
    row("Quantity", esc(preview.quantity)) +
    `<div class="claim-recap-row">` +
    `<dt class="t-body-sm text-secondary">Generated serial range</dt>` +
    `<dd class="claim-recap-url">${esc(preview.firstSerial)} &rarr; ${esc(preview.lastSerial)}</dd>` +
    `</div>` +
    `</dl>` +
    sample +
    digitNote;
}

function row(label: string, value: string): string {
  return (
    `<div class="claim-recap-row">` +
    `<dt class="t-body-sm text-secondary">${esc(label)}</dt>` +
    `<dd class="tnum">${value}</dd>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Custom metadata rows
// ---------------------------------------------------------------------------

/**
 * Add a metadata row.
 *
 * Appended to the DOM rather than re-rendered, so the fields already typed into
 * are untouched. The no-JS form has exactly one visible row to start with; this
 * grows the list from there.
 */
function addMetaRow(
  list: HTMLElement,
  index: number,
  templateName: string,
  templateValue: string,
  removeLabel: string,
): void {
  const row = document.createElement("div");
  row.className = "batch-meta-row";
  row.setAttribute("data-meta-row", "");
  row.innerHTML =
    `<div class="field">` +
    `<label class="field-label" for="meta-name-${index}">Field Name</label>` +
    `<input class="input" id="meta-name-${index}" name="${templateName}" ` +
    `maxlength="60" placeholder="Manufacturing Line" data-meta="name">` +
    `</div>` +
    `<div class="field">` +
    `<label class="field-label" for="meta-value-${index}">Value</label>` +
    `<input class="input" id="meta-value-${index}" name="${templateValue}" ` +
    `maxlength="1000" placeholder="L02" data-meta="value">` +
    `</div>` +
    `<div class="field batch-meta-remove">` +
    `<span class="field-label" aria-hidden="true">Remove</span>` +
    `<button type="button" class="btn btn-secondary" data-meta-remove ` +
    `aria-label="${esc(removeLabel)}"><span class="btn-label">Remove</span></button>` +
    `</div>`;

  list.appendChild(row);
  reindexMetaRows(list);
  row.querySelector<HTMLInputElement>('[data-meta="name"]')?.focus();
}

/**
 * Renumber the row inputs.
 *
 * Necessary because the labels use `for="meta-name-N"`. After a removal the ids
 * would otherwise be sparse and out of step with what the eye expects, and a
 * sparse sequence of duplicate-free ids is fine — but leaving them out of step
 * makes the DOM confusing to debug and breaks any future code that assumes
 * row N is id N.
 */
function reindexMetaRows(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>("[data-meta-row]").forEach((row, i) => {
    const name = row.querySelector<HTMLInputElement>('[data-meta="name"]');
    const value = row.querySelector<HTMLInputElement>('[data-meta="value"]');
    const labelName = row.querySelector<HTMLLabelElement>("label[for]");
    const labelValue = row.querySelectorAll<HTMLLabelElement>("label[for]")[1];
    if (name) {
      name.id = `meta-name-${i}`;
      if (labelName) labelName.setAttribute("for", name.id);
    }
    if (value) {
      value.id = `meta-value-${i}`;
      if (labelValue) labelValue.setAttribute("for", value.id);
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function initBatchGenerator(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>("[data-batch-form]");
  const preview = root.querySelector<HTMLElement>("[data-batch-preview]");
  const metaList = root.querySelector<HTMLElement>("[data-meta-list]");
  const addButton = root.querySelector<HTMLButtonElement>("[data-meta-add]");
  const counter = root.querySelector<HTMLElement>("[data-meta-count]");
  if (!form || !preview) return;

  const maxMeta = Number(root.getAttribute("data-metadata-max") ?? BATCH_METADATA_MAX);
  // The server enforces the same cap; this only keeps the UI honest about it.
  const multiple = BATCH_SIZE_MULTIPLE;

  // --- Live preview ---------------------------------------------------------
  const repaint = (): void => renderPreview(preview, form);
  form.addEventListener("input", repaint);
  form.addEventListener("change", repaint);
  repaint();

  // --- Inline validation ----------------------------------------------------
  // Blur first, then live once touched: do not scold someone mid-first-keystroke.
  form.querySelectorAll<Control>("[data-validate]").forEach((input) => {
    input.addEventListener("blur", () => {
      input.dataset.touched = "1";
      setFieldError(input, validateControl(input));
    });
    input.addEventListener("input", () => {
      if (input.dataset.touched === "1") setFieldError(input, validateControl(input));
    });
  });

  // --- Custom fields -------------------------------------------------------
  if (metaList && addButton) {
    addButton.addEventListener("click", () => {
      const rows = metaList.querySelectorAll("[data-meta-row]").length;
      // Guard in the client as well as the server: a button that does nothing
      // when disabled is worse than one that explains itself, and this keeps the
      // disabled state honest rather than decorative.
      if (rows >= maxMeta) {
        setMetaError(`You've reached the maximum number of custom fields (${maxMeta}).`);
        return;
      }
      setMetaError(null);
      // The first row ships disabled so the no-JS form still submits exactly one
      // (empty) pair; once the island takes over, every row is editable.
      metaList.querySelectorAll<HTMLInputElement>("[data-meta]").forEach((el) => {
        el.disabled = false;
      });
      addMetaRow(
        metaList,
        rows,
        'meta_name[]',
        'meta_value[]',
        `Remove custom field ${rows + 1}`,
      );
      updateMetaCounter(metaList, counter, maxMeta);
    });

    metaList.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const remove = target?.closest<HTMLElement>("[data-meta-remove]");
      if (!remove || !metaList.contains(remove)) return;
      const row = remove.closest<HTMLElement>("[data-meta-row]");
      if (!row) return;

      // Always leave one row in place: a form with zero inputs for a field pair
      // looks broken, and the server-side reader already treats a blank row as
      // "no metadata".
      const rows = metaList.querySelectorAll("[data-meta-row]");
      if (rows.length <= 1) {
        const name = row.querySelector<HTMLInputElement>('[data-meta="name"]');
        const value = row.querySelector<HTMLInputElement>('[data-meta="value"]');
        if (name) name.value = "";
        if (value) value.value = "";
        setMetaError(null);
        repaint();
        return;
      }

      row.remove();
      reindexMetaRows(metaList);
      setMetaError(null);
      updateMetaCounter(metaList, counter, maxMeta);
      repaint();
    });
  }

  // Clear a stale metadata error as soon as the user edits anything.
  form.addEventListener("input", () => setMetaError(null));

  // --- Block an invalid submit before the round trip -----------------------
  // The server validates everything anyway. This exists so the user is told
  // which field is wrong immediately, and so an invalid form does not navigate
  // away and back.
  form.addEventListener("submit", (event) => {
    const problems: string[] = [];
    form.querySelectorAll<Control>("[data-validate]").forEach((input) => {
      const message = validateControl(input);
      setFieldError(input, message);
      if (message) problems.push(message);
    });

    const values = readValues(form);
    const metaErrors = validateMetadataRows(metaList);
    if (metaErrors) {
      setMetaError(metaErrors);
      problems.push(metaErrors);
    }

    if (problems.length) {
      event.preventDefault();
      // Move focus to the first thing that needs attention, so a keyboard or
      // screen-reader user is not left wondering why nothing happened.
      const firstError = form.querySelector<Control>('[aria-invalid="true"]');
      firstError?.focus();
      return;
    }

    // A last sanity check on the composed range. Catches the case where every
    // individual field is valid but the combination is not — e.g. a start so
    // large the end overflows.
    if (!previewBatch(values)) {
      event.preventDefault();
      setMetaError("Those values don't produce a valid range. Check the starting sequence and batch size.");
    }
  });

  // Keep the visible counter in step with reality.
  updateMetaCounter(metaList, counter, maxMeta);

  // Expose the multiple-of-9 rule on the size field for the island's own hint,
  // so the two never quote different numbers.
  const sizeInput = form.querySelector<HTMLInputElement>('[name="batch_size"]');
  if (sizeInput) sizeInput.setAttribute("data-multiple", String(multiple));
}

function setMetaError(message: string | null): void {
  const existing = document.querySelector<HTMLElement>("[data-meta-error]");
  if (!message) {
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    existing.textContent = message;
    return;
  }
  const el = document.createElement("p");
  el.className = "field-error";
  el.setAttribute("role", "alert");
  el.setAttribute("data-meta-error", "");
  el.textContent = message;
  document.querySelector("[data-meta-list]")?.after(el);
}

function validateMetadataRows(metaList: HTMLElement | null): string | null {
  if (!metaList) return null;
  let count = 0;
  for (const row of metaList.querySelectorAll<HTMLElement>("[data-meta-row]")) {
    const name = row.querySelector<HTMLInputElement>('[data-meta="name"]')?.value.trim() ?? "";
    const value = row.querySelector<HTMLInputElement>('[data-meta="value"]')?.value.trim() ?? "";
    if (!name && !value) continue;
    count++;
    if (!name) return "Every custom field needs a name.";
    if (!value) return `"${name}" needs a value.`;
  }
  if (count > BATCH_METADATA_MAX) {
    return `You've reached the maximum number of custom fields (${BATCH_METADATA_MAX}).`;
  }
  return null;
}

function updateMetaCounter(
  metaList: HTMLElement | null,
  counter: HTMLElement | null,
  max: number,
): void {
  if (!metaList || !counter) return;
  let count = 0;
  for (const row of metaList.querySelectorAll<HTMLElement>("[data-meta-row]")) {
    const name = row.querySelector<HTMLInputElement>('[data-meta="name"]')?.value.trim() ?? "";
    const value = row.querySelector<HTMLInputElement>('[data-meta="value"]')?.value.trim() ?? "";
    if (name || value) count++;
  }
  counter.textContent = `${count} of ${max} custom fields`;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll<HTMLElement>("[data-batch-generator]").forEach(initBatchGenerator);
  });
} else {
  document.querySelectorAll<HTMLElement>("[data-batch-generator]").forEach(initBatchGenerator);
}
