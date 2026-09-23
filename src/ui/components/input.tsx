import type { FC } from "hono/jsx";

export interface InputProps {
  id: string;
  name?: string;
  label: string;
  type?: "text" | "email" | "tel" | "url" | "password" | "search" | "number";
  value?: string;
  placeholder?: string;
  /** helper text shown beneath the control */
  hint?: string;
  /** error message; sets aria-invalid and styles the field as errored */
  error?: string;
  required?: boolean;
  disabled?: boolean;
  autocomplete?: string;
  inputmode?: "text" | "email" | "tel" | "url" | "numeric" | "search" | "none";
  /** visually hide the label while keeping it for screen readers */
  hideLabel?: boolean;
  class?: string;
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
  autocomplete,
  inputmode,
  hideLabel,
  class: cls,
}) => {
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
        class={error ? "text-input input-error" : "text-input"}
        id={id}
        name={name ?? id}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autocomplete={autocomplete}
        inputmode={inputmode}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
      />
      {hint && !error ? (
        <p class="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p class="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};
