import type { FC } from "hono/jsx";

export interface TextareaProps {
  id: string;
  name?: string;
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  maxlength?: number;
  hideLabel?: boolean;
  class?: string;
  /** arbitrary data-* hooks (island binding for inline validation) */
  [key: `data-${string}`]: string | boolean | undefined;
}

/**
 * Textarea — a labeled multi-line field sharing the input visual language.
 * Min-height meets the 44px touch target; resizes vertically only.
 */
export const Textarea: FC<TextareaProps> = ({
  id,
  name,
  label,
  value,
  placeholder,
  hint,
  error,
  rows = 4,
  required,
  disabled,
  maxlength,
  hideLabel,
  class: cls,
  ...rest
}) => {
  const passthrough = rest as Record<string, string | boolean | undefined>;
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
      <textarea
        class={error ? "textarea textarea-error" : "textarea"}
        id={id}
        name={name ?? id}
        rows={rows}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        maxlength={maxlength}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
        {...passthrough}
      >
        {value}
      </textarea>
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
