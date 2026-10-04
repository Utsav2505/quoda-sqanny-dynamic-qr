import type { FC } from "hono/jsx";
import { Icon } from "../icons";

export interface ProgressProps {
  /** 0–100 */
  value: number;
  label: string;
  /** optional "80% complete" text at the right of the header */
  showValue?: boolean;
  class?: string;
}

/**
 * Progress — a labelled determinate meter.
 *
 * The visual bar is aria-hidden; the real value is exposed via role="progressbar"
 * so a screen reader announces both the label and the percentage. Segmented
 * blocks are decorative only (see .progress-track::before in app.css).
 */
export const Progress: FC<ProgressProps> = ({ value, label, showValue = true, class: cls }) => {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div class={["progress", cls].filter(Boolean).join(" ")}>
      <div class="progress-head">
        <span class="progress-label t-body-sm">{label}</span>
        {showValue ? (
          <span class="progress-value t-body-sm tnum">{pct}%</span>
        ) : null}
      </div>
      <div
        class="progress-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}: ${pct}% complete`}
      >
        <div class="progress-fill" style={`width:${pct}%`} />
      </div>
    </div>
  );
};

/** A checklist of what's done and what isn't. */
export const ProgressChecklist: FC<{
  items: Array<{ label: string; done: boolean }>;
}> = ({ items }) => (
  <ul class="progress-list">
    {items.map((item) => (
      <li class={"progress-item" + (item.done ? " progress-item-done" : "")}>
        <span class="progress-item-mark" aria-hidden="true">
          {item.done ? <Icon name="check" size={14} /> : <Icon name="plus" size={12} />}
        </span>
        <span class="progress-item-label t-body-sm">{item.label}</span>
        <span class="visually-hidden">{item.done ? "complete" : "not done"}</span>
      </li>
    ))}
  </ul>
);
