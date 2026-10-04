/**
 * Profile completeness.
 *
 * Purely advisory — nothing here gates access. It exists so the UI can nudge a
 * user toward a useful profile (and so support can tell "barely set up" from
 * "fully configured" without opening a record).
 *
 * Scoring is a weighted checklist rather than "how many fields are non-empty",
 * so an account with a name, a business, and a location reads as genuinely
 * usable even with no social links. Optional extras only add a small slice.
 */

import { parseHours } from "./business";

export interface CompletenessBusiness {
  address?: string | null;
  city?: string | null;
  website?: string | null;
  logo_key?: string | null;
  instagram_url?: string | null;
  facebook_url?: string | null;
  hours_json?: string | null;
}

export interface CompletenessInput {
  name?: string | null;
  phone?: string | null;
  /** 0 when the user has no business at all. */
  businessCount?: number;
  primaryBusiness?: CompletenessBusiness | null;
}

export interface CompletenessCheck {
  label: string;
  done: boolean;
  /** the single most useful thing to do next, when this check is incomplete */
  action: string;
  /** where [Complete Profile] / the action hint should send the user */
  href: string;
}

export interface Completeness {
  percent: number;
  checks: CompletenessCheck[];
  /** the first incomplete check — the most useful single prompt */
  next: CompletenessCheck | null;
}

const filled = (v: unknown): boolean =>
  typeof v === "string" ? v.trim().length > 0 : v != null;

const EDIT_BUSINESS = "/app/businesses";

export function computeCompleteness(input: CompletenessInput): Completeness {
  const b = input.primaryBusiness ?? null;
  const hasBusiness = (input.businessCount ?? 0) > 0 && b != null;

  // Account-level checks first, then the business, then business extras. The
  // order is the prompt order: it reads as "finish the thing in front of you".
  const checks: CompletenessCheck[] = [
    {
      label: "Add your name",
      done: filled(input.name),
      action: "Add your name",
      href: "/app/profile",
    },
    {
      label: "Add a phone number",
      done: filled(input.phone),
      action: "Add a phone number",
      href: "/app/profile",
    },
    {
      label: "Create a business",
      done: hasBusiness,
      action: "Create your first business",
      href: hasBusiness ? EDIT_BUSINESS : "/app/businesses/new",
    },
  ];

  // With no business yet, the optional business extras would just be noise
  // stacked on top of "create a business". Stop at the business step.
  if (!hasBusiness || !b) {
    const done = checks.filter((c) => c.done).length;
    return {
      percent: Math.round((done / checks.length) * 100),
      checks,
      next: checks.find((c) => !c.done) ?? null,
    };
  }

  checks.push(
    {
      label: "Add your business address",
      done: filled(b.address) || filled(b.city),
      action: "Add your business address",
      href: EDIT_BUSINESS,
    },
    {
      label: "Add your business website",
      done: filled(b.website),
      action: "Add your business website",
      href: EDIT_BUSINESS,
    },
    {
      label: "Add business hours",
      done: Object.keys(parseHours(b.hours_json)).length > 0,
      action: "Add your business hours",
      href: EDIT_BUSINESS,
    },
    {
      label: "Add a business logo",
      done: filled(b.logo_key),
      action: "Add a business logo",
      href: EDIT_BUSINESS,
    },
    {
      label: "Add social links",
      done: filled(b.instagram_url) || filled(b.facebook_url),
      action: "Link your Instagram or Facebook",
      href: EDIT_BUSINESS,
    },
  );

  const done = checks.filter((c) => c.done).length;
  return {
    percent: Math.round((done / checks.length) * 100),
    checks,
    next: checks.find((c) => !c.done) ?? null,
  };
}
