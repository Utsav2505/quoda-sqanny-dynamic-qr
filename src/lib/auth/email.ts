import type { Bindings } from "../../types";

const FROM = "Sqanny <sqanny-noreply@chetnaverse.com>";

const SUBJECT = "Your Sqanny sign-in link";

function magicLinkHtml(url: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#161618;color:#F5F5F5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="100%" style="max-width:480px;">
          <tr><td style="padding:24px 0;font-size:20px;font-weight:600;">Sign in to Sqanny</td></tr>
          <tr><td style="padding:0 0 16px;font-size:15px;line-height:1.5;color:#a1a1aa;">
            Click the button below to sign in. This link expires in 15 minutes and can be used once.
          </td></tr>
          <tr><td style="padding:8px 0 24px;">
            <a href="${url}" style="display:inline-block;background:#0A7EA4;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;">Sign in to Sqanny</a>
          </td></tr>
          <tr><td style="padding:0;font-size:13px;line-height:1.5;color:#71717a;word-break:break-all;">
            Or paste this URL into your browser:<br />${url}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/**
 * Send a magic-link email. Uses Resend when RESEND_API_KEY is configured,
 * otherwise logs the link to the console for local development. Never fails
 * silently: a Resend error throws, and the dev path warns loudly.
 */
export async function sendMagicLink(
  env: Bindings,
  email: string,
  url: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[DEV MAGIC LINK] ${email} -> ${url}`);
    console.warn(
      "[Sqanny] RESEND_API_KEY not configured — magic link logged to console instead of emailed. Set RESEND_API_KEY to send real emails.",
    );
    return;
  }

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || FROM,
        to: [email],
        subject: SUBJECT,
        html: magicLinkHtml(url),
      }),
    });
  } catch (err) {
    // Network/transport failure — surface it (never silent) so the caller can
    // tell the user the email couldn't be sent.
    console.error("[email] sendMagicLink network error:", err);
    throw new Error("sendMagicLink: could not reach the email provider.");
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `sendMagicLink: Resend responded ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }
}
