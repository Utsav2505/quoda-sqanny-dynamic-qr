import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { Layout } from "../ui/layout";
import { Button } from "../ui/components/button";
import { Icon } from "../ui/icons";
import { normalizeUrl } from "../lib/validate";

/**
 * The page a scanner lands on when a dynamic code has no destination yet.
 *
 * Rendered in place of the 302 by routes/redirect.tsx, so the printed code
 * never changes: /r/<code> either redirects (configured) or shows this
 * (not configured). That single-URL property is the whole point of a dynamic
 * code, so there is deliberately no separate /claim/<code> route.
 *
 * The form is a plain HTML POST so it works with JavaScript disabled and needs
 * no client island. On success the handler redirects back to /r/<code>, which
 * now performs the 302 — so the visitor is forwarded by the same path every
 * future scan takes.
 *
 * `signedIn` is "this code is yours AND you may set its destination", not "you
 * hold a session". Those are different questions and conflating them is what
 * made this page offer a form that the handler would refuse. `signedInElsewhere`
 * covers the third case: a signed-in visitor looking at somebody else's
 * unconfigured code, who gets an explanation rather than a dead end and never
 * learns who owns it.
 */
export const ClaimPage: FC<{
  title: string;
  code: string;
  signedIn: boolean;
  email: string | null;
  /** True when the viewer is signed in but this code is not theirs to change. */
  signedInElsewhere?: boolean;
  /** Short machine key for the error banner, or null when there is no error. */
  error: ClaimError | null;
}> = ({ title, code, signedIn, email, signedInElsewhere, error }) => (
  <>
    {raw("<!DOCTYPE html>")}
    <Layout title={`Set destination — ${title}`} bare>
      <main class="claim">
        <div class="claim-card card">
          <span class="claim-card-icon" aria-hidden="true">
            <Icon name="qr" size={22} />
          </span>

          <h1 class="t-heading-sm claim-title">{title}</h1>
          <p class="claim-lead t-body text-secondary">
            This code hasn't been given a destination yet. Set one now and every
            scan from here on goes straight there.
          </p>

          {error ? (
            <p class="claim-error t-body-sm" role="alert">
              {CLAIM_ERRORS[error]}
            </p>
          ) : null}

          {signedIn ? (
            <form class="claim-form" method="post" action={`/r/${encodeURIComponent(code)}/claim`} data-guard-submit>
              <div class="field">
                <label class="field-label" for="claim-url">Destination URL</label>
                <input
                  class="input"
                  id="claim-url"
                  name="url"
                  type="url"
                  required
                  inputMode="url"
                  placeholder="https://example.com/menu"
                  autocomplete="url"
                />
                <p class="field-hint">
                  Must be a full <code>http</code> or <code>https</code> address.
                  {email ? ` Setting it as ${email}.` : ""}
                </p>
              </div>
              <Button type="submit" variant="primary" block>
                Set destination
              </Button>
            </form>
          ) : signedInElsewhere ? (
            <div class="claim-cta">
              <Button href="/qrs" variant="primary" block iconLeft={<Icon name="qr" size={16} />}>
                Go to your Sqanny Stands
              </Button>
              <p class="field-hint claim-note">
                You can only change the destination on codes that belong to your
                account. This one is already connected elsewhere.
              </p>
            </div>
          ) : (
            <div class="claim-cta">
              <Button
                href={`/login?next=${encodeURIComponent(`/r/${code}`)}`}
                variant="primary"
                block
                iconLeft={<Icon name="link" size={16} />}
              >
                Sign in to set the destination
              </Button>
              <p class="field-hint claim-note">
                You need an account so we can record who set this. It takes one
                email and no password.
              </p>
            </div>
          )}
        </div>
      </main>
    </Layout>
  </>
);

export type ClaimError =
  | "invalid-url"
  | "already-set"
  | "not-found"
  | "not-dynamic"
  | "not-owner"
  | "managed-elsewhere"
  | "rate-limited";

export const CLAIM_ERRORS: Record<ClaimError, string> = {
  "invalid-url": "That doesn't look like a valid web address. Enter a full http:// or https:// URL.",
  "already-set": "Someone set this code's destination a moment ago. Taking you there now.",
  "not-found": "We couldn't find that QR code.",
  "not-dynamic": "That code isn't a dynamic code, so its destination can't be changed.",
  "not-owner": "You can only set the destination on your own QR codes. This one belongs to another account.",
  "managed-elsewhere":
    "This is a Sqanny Stand. Its destination is set from your Sqanny Stands page, where you can see everything it points to.",
  "rate-limited": "Too many attempts from your connection. Please try again shortly.",
};

/**
 * Strictly validate a destination offered by a scanner.
 *
 * Delegates the parse to the one shared URL policy in lib/validate, which owns
 * the scheme allow-list, the host requirement and the canonical output shape.
 * There used to be a second, looser implementation here that accepted any host
 * (including a bare `localhost` with no dot) and disagreed with the claim flow
 * about what a legal destination is — so the same input could be accepted by one
 * route and rejected by the other.
 *
 * Stricter than the owner's own studio input, because this is a semi-anonymous
 * public write whose result becomes a 302 target for every future visitor. Only
 * http/https survive: accepting `javascript:` or `data:` here would turn the
 * redirect into a same-origin script injection.
 */
export function normalizeClaimUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  return normalizeUrl(s);
}
