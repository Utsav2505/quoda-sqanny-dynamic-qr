import { createMiddleware } from "hono/factory";
import type { Bindings } from "../types";
import { getUserFromRequest } from "../lib/auth/session";

export interface AppUser {
  id: string;
  email: string;
  plan_id: string;
  role: string;
  onboarded_at: number | null;
}

export interface Variables {
  user: AppUser | null;
}

/** App-typed Hono generic — use `new Hono<AppEnv>()` for routes that read the user. */
export type AppEnv = { Bindings: Bindings; Variables: Variables };

/** Populate c.get("user") with the current user or null. Never redirects. */
export const loadUser = createMiddleware<AppEnv>(async (c, next) => {
  c.set("user", await getUserFromRequest(c.env, c.req.raw));
  await next();
});

/** Guard: requires a logged-in user, else redirects to /login. Sets c.get("user"). */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const user = await getUserFromRequest(c.env, c.req.raw);
  if (!user) return c.redirect("/login", 302);
  c.set("user", user);
  await next();
});

/** Guard: requires a logged-in admin user. Sets c.get("user"). */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = await getUserFromRequest(c.env, c.req.raw);
  if (!user) return c.redirect("/login", 302);
  if (user.role !== "admin") return c.text("Forbidden", 403);
  c.set("user", user);
  await next();
});
