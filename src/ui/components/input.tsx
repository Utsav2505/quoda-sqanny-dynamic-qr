import type { FC } from "hono/jsx";

export interface InputProps {
  id: string;
  name?: string;
  label: string;
  type?: "text" | "email" | "tel" | "url" | "password" | "search" | "number" | "time";
  value?: string;
  placeholder?: string;
  /** helper text shown beneath the control */
  hint?: string;
  /** error message; sets aria-invalid and styles the field as errored */
  error?: string;
  required?: boolean;
  disabled?: boolean;
  maxlength?: number;
  autocomplete?: string;
  inputmode?: "text" | "email" | "tel" | "url" | "numeric" | "search" | "none";
  /** visually hide the label while keeping it for screen readers */
  hideLabel?: boolean;
  class?: string;
  /**
   * Standard HTML input attributes not named above (autocapitalize, spellcheck,
   * pattern, enterkeyhint, …) plus arbitrary data-* / aria-* hooks for island
   * binding.
   *
   * Widened from `data-*` only because real forms need the standard attributes
   * and hard-coding each one into this component's prop list is how you end up
   * with two spellings of the same attribute across the app. Typed as
   * `string | boolean | number | undefined` so callers can pass an attribute
   * either way.
   */
  [key: string]: unknown;
}

/**
 * Input — a labeled text field. Label is always present (visible or sr-only).
 * Control min-height is 44px (token-driven). Hint/error are wired via
 * aria-describedby; error sets aria-invalid.
 */
export const Input: FC<InputProps> = ({
  id,
  name,
  label,
  type = "text",
  value,
  placeholder,
  hint,
  error,
  required,
  disabled,
  maxlength,
  autocomplete,
  inputmode,
  hideLabel,
  class: cls,
  ...rest
}) => {
  // Everything not destructured above is forwarded to the <input>. The declared
  // props above are excluded by the destructure, so this cannot clobber `class`
  // or `value` by accident.
  const passthrough = rest as Record<string, string | boolean | number | undefined>;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div class={cls ? `field ${cls}` : "field"}>
      <label class={hideLabel ? "field-label visually-hidden" : "field-label"} for={id}>
        {label}
        {required ? (
          <span class="field-required" aria-hidden="true">
            {" *"}
          </span>
        ) : null}
      </label>
      <input
        class={error ? "input input-error" : "input"}
        id={id}
        name={name ?? id}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        maxlength={maxlength}
        autocomplete={autocomplete}
        inputmode={inputmode}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
        {...passthrough}
      />
      {hint && !error ? (
        <p class="field-hint" id={hintId} data-hint-for={id}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p class="field-error" id={errorId} data-error-for={id} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};
