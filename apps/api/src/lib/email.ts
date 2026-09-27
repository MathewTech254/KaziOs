/**
 * Transactional email. Resend is used when RESEND_API_KEY is set; without it the
 * mail is logged instead, so a developer can see what would have been sent and the
 * application keeps working rather than failing a sign up because mail is down.
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "KaziOS <no-reply@resend.dev>";
const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
/** How long a reset link stays usable. Deliberately short: a link in an inbox is public. */
const RESET_WINDOW_MINUTES = 15;

export function isEmailConfigured(): boolean {
  return Boolean(RESEND_API_KEY);
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

/** Sends one message. Never throws: a failed email must not roll back a sale. */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!RESEND_API_KEY) {
    // No provider configured. Log the link so a developer can still complete the flow.
    console.log(`[mail:preview] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: MAIL_FROM, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[mail] resend rejected the message: ${res.status} ${body.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[mail] could not reach the mail provider: ${(err as Error).message}`);
    return false;
  }
}

const shell = (title: string, body: string, action?: { label: string; url: string }) => `<!doctype html>
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
  const url = `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
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
  const body = `<p>Hello ${name},</p>
    <p>Your <strong>${organizationName}</strong> workspace is ready. Add your first product, or open the point of sale and start selling.</p>`;
  return {
    to,
    subject: `Welcome to KaziOS, ${organizationName}`,
    html: shell("Your workspace is ready", body, { label: "Open KaziOS", url: APP_URL }),
    text: `Hello ${name},\n\nYour ${organizationName} workspace is ready on KaziOS: ${APP_URL}`,
  };
}
