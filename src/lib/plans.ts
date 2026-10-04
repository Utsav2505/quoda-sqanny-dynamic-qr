import { countDynamicByUser } from "../db/queries";

export interface PlanLimits {
  dynamicCodes: number; // -1 = unlimited
  analyticsRetentionDays: number;
  logoUpload: boolean;
}

// Mirrors migrations/0001_init.sql plan seed (limits_json). Kept as a constant
// so limit checks don't need a DB round-trip on the hot path.
const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { dynamicCodes: 3, analyticsRetentionDays: 30, logoUpload: true },
  pro: { dynamicCodes: -1, analyticsRetentionDays: 365, logoUpload: true },
};

export const DEFAULT_PLAN = "free";

/** Resolve a plan's limits, falling back to the free plan for unknown ids. */
export function getLimits(planId: string): PlanLimits {
  return PLAN_LIMITS[planId] ?? PLAN_LIMITS[DEFAULT_PLAN];
}

/**
 * Whether a plan id grants Pro features.
 *
 * A FEATURE gate, not authorisation. There is no role system here and this is
 * not one: the only question asked anywhere is "does this account's plan unlock
 * batch generation", and the answer is derived from `users.plan_id` — the
 * server-side account state — never from anything the client sends.
 *
 * Deliberately a narrow allow-list rather than `planId !== "free"`. An unknown
 * or newly-added plan id must default to NOT having the feature, or a typo in a
 * migration would silently hand batch generation to every account on it.
 */
export function hasProPlan(planId: string | null | undefined): boolean {
  return planId === "pro";
}

/**
 * The minimum environment a limit check needs.
 *
 * Narrow rather than the full `Bindings` so the check can be called from a
 * service that holds a database handle but not the whole worker context — the
 * claim service is the motivating case, and requiring it to fabricate an env
 * object would have been how it ended up skipping the check entirely.
 */
export interface PlanEnv {
  DB: D1Database;
}

/**
 * Whether the user may create another dynamic QR code under their plan.
 * Unlimited (-1) plans always pass; otherwise compares the live count against
 * the plan limit.
 */
export async function canCreateDynamic(
  env: PlanEnv,
  user: { id: string; plan_id: string },
): Promise<boolean> {
  const limit = getLimits(user.plan_id).dynamicCodes;
  if (limit === -1) return true;
  const used = await countDynamicByUser(env.DB, user.id);
  return used < limit;
}
