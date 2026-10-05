/**
 * Transactional email. The provider is read from the shared config so the same
 * EMAIL_PROVIDER / EMAIL_API_KEY / EMAIL_FROM settings drive every sending path. When
 * no provider is configured the message is logged instead of sent, so a developer can
 * still complete the flow and the app never fails a sign-up because mail is unavailable.
 */
import { loadConfig } from "@kazios/config";

interface EmailSettings {
  provider: string;
  apiKey: string;
  from: string;
  fromName: string;
  appUrl: string;
}

function settings(): EmailSettings {
  let provider = "console";
  let apiKey = "";
  let from = "";
  let fromName = "KaziOS";
  let appUrl = "http://localhost:3000";
  try {
    const config = loadConfig();
    provider = config.email.provider || "console";
    apiKey = config.email.apiKey || "";
    from = config.email.from || "";
    fromName = config.email.fromName || "KaziOS";
  } catch {
    // A missing config must not take the server down; fall through to console.
  }
  appUrl = (process.env.APP_URL || appUrl).replace(/\/+$/, "");
  return { provider, apiKey, from, fromName, appUrl };
}

/** How long a reset link stays usable. Deliberately short: a link in an inbox is public. */
const RESET_WINDOW_MINUTES = 15;

export function isEmailConfigured(): boolean {
  const { provider, apiKey } = settings();
  return provider !== "console" && Boolean(apiKey);
}

export function resetWindowMinutes(): number {
  return RESET_WINDOW_MINUTES;
}

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const isResend = (provider: string) => provider === "resend";

export interface MailCheck {
  ok: boolean;
  provider: string;
  sender: string;
  detail: string;
}

/**
 * Checks that the mail credentials actually work by asking the provider, without sending
 * anything. This turns "the email did not arrive" into a specific, actionable answer
 * instead of a silent no-op.
 */
export async function checkMailConfiguration(): Promise<MailCheck> {
  const s = settings();
  const sender = senderAddress(s);

  if (!isResend(s.provider)) {
    return {
      ok: false,
      provider: s.provider,
      sender,
      detail:
        "Email is set to console mode. Emails are printed to the API log, not delivered. Set EMAIL_PROVIDER=resend to send real mail.",
    };
  }
  if (!s.apiKey) {
    return {
      ok: false,
      provider: s.provider,
      sender,
      detail: "EMAIL_API_KEY is empty. Add a key from resend.com/api-keys.",
    };
  }

  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${s.apiKey}` },
    });
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      return {
        ok: false,
        provider: s.provider,
        sender,
        detail:
          "The Resend API key was rejected. It is invalid or revoked. Create a new key at resend.com/api-keys.",
      };
    }
    return {
      ok: true,
      provider: s.provider,
      sender,
      detail: "Resend accepted the API key. Emails will be delivered.",
    };
  } catch (err) {
    return {
      ok: false,
      provider: s.provider,
      sender,
      detail: `Could not reach Resend: ${(err as Error).message}`,
    };
  }
}

/**
 * The address the mail is sent from. A domain that has not been verified with the
 * provider is rejected outright, so the default names a provider that is always allowed
 * to send rather than a made-up domain that would silently fail for every real user.
 */
function senderAddress(s: EmailSettings): string {
  const from = s.from && s.from !== "no-reply@kazios.test" ? s.from : "onboarding@resend.dev";
  const name = s.fromName || "KaziOS";
  return name ? `${name} <${from}>` : from;
}

/** Sends one message. Never throws: a failed email must not roll back a sale. */
export async function sendMail(mail: Mail): Promise<boolean> {
  const s = settings();

  if (!isResend(s.provider) || !s.apiKey) {
    // No provider configured. Log the link so a developer can still complete the flow.
    console.log(`[mail:preview] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({
        from: senderAddress(s),
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[mail] resend rejected the message: ${res.status} ${body.slice(0, 300)}`);
      if (res.status === 401 || res.status === 400) {
        // A dead or mistyped key fails identically for every user, so say so plainly
        // instead of letting a silent console line look like a delivered email.
        console.error(
          "[mail] the Resend API key was rejected. Generate a new key at resend.com/api-keys " +
            "and set EMAIL_API_KEY in .env. Until then, reset links are only printed here."
        );
      }
      return false;
    }
    console.log(`[mail] sent "${mail.subject}" to ${mail.to}`);
    return true;
  } catch (err) {
    console.error(`[mail] could not reach the mail provider: ${(err as Error).message}`);
    return false;
  }
}

const shell = (
  title: string,
  body: string,
  action?: { label: string; url: string }
) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;padding:32px">
      <tr><td>
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#b45309">KaziOS</p>
        <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${title}</h1>
        <div style="font-size:15px;line-height:1.6;color:#44403c">${body}</div>
        ${
          action
            ? `<p style="margin:28px 0"><a href="${action.url}" style="display:inline-block;background:#1c1917;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">${action.label}</a></p>
               <p style="margin:0;font-size:12px;color:#78716c;word-break:break-all">${action.url}</p>`
            : ""
        }
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

export function passwordResetEmail(to: string, name: string, token: string): Mail {
  const url = `${settings().appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const body = `<p>Hello ${name},</p>
    <p>Someone asked to reset the password for your KaziOS account. Use the button below to choose a new one.</p>
    <p>This link works once and expires in ${RESET_WINDOW_MINUTES} minutes. If this was not you, ignore this message and nothing changes.</p>`;
  return {
    to,
    subject: "Reset your KaziOS password",
    html: shell("Reset your password", body, { label: "Choose a new password", url }),
    text: `Hello ${name},\n\nReset your KaziOS password: ${url}\n\nThe link works once and expires in ${RESET_WINDOW_MINUTES} minutes. If this was not you, ignore this message.`,
  };
}

export function passwordChangedEmail(to: string, name: string): Mail {
  const body = `<p>Hello ${name},</p>
    <p>Your KaziOS password was just changed. Every other session has been signed out.</p>
    <p>If you did not do this, reset your password immediately and contact your administrator.</p>`;
  return {
    to,
    subject: "Your KaziOS password was changed",
    html: shell("Your password was changed", body),
    text: `Hello ${name},\n\nYour KaziOS password was just changed and every other session was signed out.\nIf this was not you, reset your password immediately.`,
  };
}

export function welcomeEmail(to: string, name: string, organizationName: string): Mail {
  const appUrl = settings().appUrl;
  const body = `<p>Hello ${name},</p>
    <p>Your <strong>${organizationName}</strong> workspace is ready. Add your first product, or open the point of sale and start selling.</p>`;
  return {
    to,
    subject: `Welcome to KaziOS, ${organizationName}`,
    html: shell("Your workspace is ready", body, { label: "Open KaziOS", url: appUrl }),
    text: `Hello ${name},\n\nYour ${organizationName} workspace is ready on KaziOS: ${appUrl}`,
  };
}

/**
 * One billing announcement as an email: a payment that failed, a plan that activated,
 * a subscription that expired. The same words as the in-app notification, because a
 * customer who is not looking at the app still needs to know their card was declined.
 */
export function billingNoticeEmail(input: {
  to: string;
  name: string;
  subject: string;
  paragraph: string;
  /** Where "Open billing" should go, as an app path such as "/settings?tab=billing". */
  link?: string;
}): Mail {
  const url = `${settings().appUrl}${input.link ?? "/settings?tab=billing"}`;
  const body = `<p>Hello ${input.name},</p><p>${input.paragraph}</p>`;
  return {
    to: input.to,
    subject: input.subject,
    html: shell(input.subject, body, { label: "Open billing", url }),
    text: `Hello ${input.name},\n\n${input.paragraph}\n\n${url}`,
  };
}
