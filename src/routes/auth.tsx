import { Hono } from "hono";
import { raw } from "hono/html";
import type { FC, PropsWithChildren, Child } from "hono/jsx";
import type { AppEnv } from "../middleware/auth";
import { Layout } from "../ui/layout";
import { Button } from "../ui/components/button";
import { Input } from "../ui/components/input";
import { Icon } from "../ui/icons";
import { issueMagicLink, verifyMagicLink } from "../lib/auth/magic-link";
import { startSession, endSession, SESSION_COOKIE } from "../lib/auth/session";
import { getUserById } from "../db/queries";

export const auth = new Hono<AppEnv>();

/**
 * AuthShell — the focused, signed-out page frame. Uses Layout (not AppShell)
 * because there is no authenticated user yet: a calm, centered single column
 * with the brand wordmark above the card. No top nav, no footer — nothing to
 * pull attention from the one action on the page.
 */
const AuthShell: FC<
  PropsWithChildren<{ title: string; icon?: Child }>
> = ({ title, icon, children }) => (
  <>
    {raw("<!DOCTYPE html>")}
    <Layout title={title}>
      <main class="auth">
        <a class="auth-brand" href="/" aria-label="Sqanny home">
          <span class="auth-brandmark" aria-hidden="true">
            <Icon name="qr" size={22} />
          </span>
          <span class="auth-wordmark">quoda</span>
        </a>
        <div class="auth-card">
          {icon ? (
            <span class="auth-card-icon" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          {children}
        </div>
      </main>
    </Layout>
  </>
);

/** Basic shape check — kept permissive; verification happens via the link. */
function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

// ---------------------------------------------------------------------------
// GET /login — calm centered email form (passwordless magic link).
// ---------------------------------------------------------------------------

auth.get("/login", (c) =>
  c.html(
    <AuthShell title="Sign in" icon={<Icon name="link" size={24} />}>
      <h1 class="auth-title t-heading-sm">Sign in to Sqanny</h1>
      <p class="auth-lead t-body text-secondary">
        Enter your email and we will send you a secure sign-in link. No
        password to remember — the link is all you need.
      </p>
      <form class="auth-form" method="post" action="/login">
        <Input
          id="email"
          name="email"
          label="Email address"
          type="email"
          placeholder="you@example.com"
          autocomplete="email"
          inputmode="email"
          required
        />
        <Button type="submit" block iconLeft={<Icon name="link" />}>
          Send sign-in link
        </Button>
      </form>
      <p class="auth-fineprint t-caption text-tertiary">
        The link expires in 15 minutes and can be used once.
      </p>
    </AuthShell>,
  ),
);

// ---------------------------------------------------------------------------
// POST /login — issue the magic link, render "Check your inbox".
// ---------------------------------------------------------------------------

auth.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim().toLowerCase();

  if (!looksLikeEmail(email)) {
    return c.html(
      <AuthShell title="Sign in" icon={<Icon name="link" size={24} />}>
        <h1 class="auth-title t-heading-sm">Sign in to Sqanny</h1>
        <p class="auth-lead t-body text-secondary">
          Enter your email and we will send you a secure sign-in link. No
          password to remember — the link is all you need.
        </p>
        <form class="auth-form" method="post" action="/login">
          <Input
            id="email"
            name="email"
            label="Email address"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            inputmode="email"
            value={email}
            error="Enter a valid email address."
            required
          />
          <Button type="submit" block iconLeft={<Icon name="link" />}>
            Send sign-in link
          </Button>
        </form>
        <p class="auth-fineprint t-caption text-tertiary">
          The link expires in 15 minutes and can be used once.
        </p>
      </AuthShell>,
    );
  }

  await issueMagicLink(c.env, email, c.req.query("next"));

  // In local dev (no RESEND key) the link is printed to the server console by
  // sendMagicLink — tell the developer so they can grab it without an inbox.
  const devMode = !c.env.RESEND_API_KEY;

  return c.html(
    <AuthShell title="Check your inbox" icon={<Icon name="email" size={24} />}>
      <h1 class="auth-title t-heading-sm">Check your inbox</h1>
      <p class="auth-lead t-body text-secondary">
        We sent a sign-in link to <strong class="auth-email">{email}</strong>.
        Open it on this device to continue. It expires in 15 minutes.
      </p>
      {devMode ? (
        <div class="auth-devnote" role="note">
          <p class="t-body-sm">
            <strong>Local dev:</strong> no email provider is configured, so the
            sign-in link was printed to your server console. Copy the line that
            starts with <code class="auth-code">[DEV MAGIC LINK]</code> and open
            the URL.
          </p>
        </div>
      ) : null}
      <Button href="/login" variant="secondary" block>
        Use a different email
      </Button>
      <p class="auth-fineprint t-caption text-tertiary">
        Did not get it? Check spam, or request a new link.
      </p>
    </AuthShell>,
  );
});

// ---------------------------------------------------------------------------
// GET /auth/verify — consume the token, start a session, route the user.
// ---------------------------------------------------------------------------

auth.get("/auth/verify", async (c) => {
  const token = c.req.query("token") ?? "";
  const result = token ? await verifyMagicLink(c.env, token) : null;

  if (!result) {
    return c.html(
      <AuthShell title="Link expired" icon={<Icon name="close" size={24} />}>
        <h1 class="auth-title t-heading-sm">This link is no longer valid</h1>
        <p class="auth-lead t-body text-secondary">
          Sign-in links expire after 15 minutes and can only be used once. Ask
          for a fresh link and you will be back in moments.
        </p>
        <Button href="/login" block iconLeft={<Icon name="link" />}>
          Request a new link
        </Button>
      </AuthShell>,
      400,
    );
  }

  const setCookie = await startSession(
    c.env,
    result.userId,
    c.req.header("user-agent") ?? null,
  );
  c.header("Set-Cookie", setCookie);

  const user = await getUserById(c.env.DB, result.userId);
  // A captured return path wins, but only for a user who has finished
  // onboarding — otherwise the "next" would drop them into a page that assumes
  // a completed profile.
  const onboarded = !user || user.onboarded_at !== null;
  const destination = result.nextPath && onboarded
    ? result.nextPath
    : user && user.onboarded_at === null
      ? "/onboarding"
      : "/app";
  return c.redirect(destination, 302);
});

// ---------------------------------------------------------------------------
  // /auth/logout - destroy the session, clear the cookie, go home.
  // ---------------------------------------------------------------------------
  
  /**
   * POST /auth/logout - destroy the session, clear the cookie, go home.
   *
   * POST, not GET. The session cookie is `SameSite=Lax`, which deliberately
   * permits cross-site top-level GET navigations - so a GET logout could be
   * triggered from any page with a single `<img src="/auth/logout">`, silently
   * signing the visitor out. A POST is not covered by that exception, so this can
   * no longer be reached cross-site. The GET below exists only to explain that.
   *
   * 303, not 302: after a state change the browser must follow up with a GET, and
   * a 302 leaves the client free to repeat the POST at the target. The cookie is
   * already dead by then, so the difference is cosmetic — but the correct status
   * costs nothing and removes the question entirely.
   */
  auth.post("/auth/logout", async (c) => {
    const cleared = await endSession(c.env, c.req.raw);
    c.header("Set-Cookie", cleared);
    return c.redirect("/", 303);
  });

/**
   * GET /auth/logout - an explanation, not a logout.
   *
   * Still ends the session would be worse than the small CSRF surface, so it does
   * not: this page renders a POST form and changes nothing on its own. Someone who
   * followed an old bookmark or an already-open tab gets a clear choice instead of
   * either a silent sign-out or a dead link.
   */
  auth.get("/auth/logout", (c) =>
    c.html(
      <AuthShell title="Sign out" icon={<Icon name="logout" size={24} />}>
        <h1 class="auth-title t-heading-sm">Sign out of Sqanny?</h1>
        <p class="auth-lead t-body text-secondary">
          Signing out ends this session on this device.
        </p>
        <form method="post" action="/auth/logout" data-guard-submit>
          <Button type="submit" block iconLeft={<Icon name="logout" />}>
            Sign out
          </Button>
        </form>
      <Button href="/app" variant="ghost" block>
        Stay signed in
      </Button>
    </AuthShell>,
  ),
);
