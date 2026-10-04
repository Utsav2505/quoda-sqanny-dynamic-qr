import type { FC } from "hono/jsx";
import { Icon } from "../icons";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  id: string;
  name?: string;
  label: string;
  options: SelectOption[];
  value?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
  class?: string;
  /** arbitrary data-* hooks (island binding for conditional reveals) */
  [key: `data-${string}`]: string | boolean | undefined;
}

/**
 * Select — a labeled native <select> with a custom chevron affordance.
 * Native select keeps full keyboard + screen-reader support for free.
 * Control min-height is 44px; chevron is decorative and pointer-transparent.
 */
export const Select: FC<SelectProps> = ({
  id,
  name,
  label,
  options,
  value,
  hint,
  error,
  required,
  disabled,
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
      <div class="select-wrap">
        <select
          class={error ? "select select-error" : "select"}
          id={id}
          name={name ?? id}
          required={required}
          disabled={disabled}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
          {...passthrough}
        >
          {options.map((opt) => (
            <option value={opt.value} selected={opt.value === value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        <span class="select-chevron" aria-hidden="true">
          <Icon name="chevron" size={18} />
        </span>
      </div>
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
