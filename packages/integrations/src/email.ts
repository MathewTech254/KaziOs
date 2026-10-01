export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  attachments?: {
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }[];
}

export interface EmailProvider {
  send(options: EmailOptions): Promise<EmailResult>;
}

export interface EmailResult {
  messageId: string;
  status: "sent" | "failed";
  error?: string;
}

export class ConsoleEmailProvider implements EmailProvider {
  async send(options: EmailOptions): Promise<EmailResult> {
    console.log("\n=== EMAIL ===");
    console.log("To:", options.to);
    console.log("Subject:", options.subject);
    console.log("Body:", options.html);
    console.log("=== END EMAIL ===\n");
    return { messageId: "console", status: "sent" };
  }
}

export class SendgridEmailProvider implements EmailProvider {
  private apiKey: string;
  private from: string;
  private fromName: string;

  constructor(config: { apiKey: string; from: string; fromName: string }) {
    this.apiKey = config.apiKey;
    this.from = config.from;
    this.fromName = config.fromName;
  }

  async send(options: EmailOptions): Promise<EmailResult> {
    // Required lazily so an installation that never configures SendGrid does not have
    // to have the SDK installed at all.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(this.apiKey);

    try {
      const result = await sgMail.send({
        to: options.to,
        from: { email: this.from, name: this.fromName },
        subject: options.subject,
        html: options.html,
        text: options.text,
        attachments: options.attachments?.map(a => ({
          filename: a.filename,
          content: a.content.toString("base64"),
          type: a.contentType,
        })),
      });

      return {
        messageId: result[0]?.headers?.["x-message-id"] || "sent",
        status: "sent",
      };
    } catch (error) {
      return {
        messageId: "",
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

export function createEmailProvider(config: {
  provider: string;
  apiKey?: string;
  from: string;
  fromName: string;
}): EmailProvider {
  if (config.provider === "sendgrid" && config.apiKey) {
    return new SendgridEmailProvider({
      apiKey: config.apiKey,
      from: config.from,
      fromName: config.fromName,
    });
  }
  if (config.provider === "smtp" && config.apiKey) {
    return new ConsoleEmailProvider();
  }
  return new ConsoleEmailProvider();
}

export function renderInvoiceEmail(invoice: {
  invoiceNumber: string;
  customerName: string;
  total: number;
  currency: string;
  dueDate: string;
}): string {
  return `
    <html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <h2>Invoice ${invoice.invoiceNumber}</h2>
      <p>Dear ${invoice.customerName},</p>
      <p>Please find attached your invoice <strong>${invoice.invoiceNumber}</strong> for ${invoice.currency} ${invoice.total} due on ${invoice.dueDate}.</p>
      <p>You can pay this invoice using the payment link below.</p>
      <p><a href="#" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Pay Now</a></p>
      <p>If you have already made the payment, please disregard this email.</p>
      <p>Thank you,<br/>KaziOS</p>
    </body>
    </html>
  `;
}

export function renderPasswordResetEmail(data: { name: string; resetUrl: string }): string {
  return `
    <html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <h2>Password Reset</h2>
      <p>Hello ${data.name},</p>
      <p>You requested a password reset. Click the button below to reset your password:</p>
      <p><a href="${data.resetUrl}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a></p>
      <p>This link will expire in 24 hours.</p>
      <p>If you did not request this, please ignore this email.</p>
      <p>KaziOS Security Team</p>
    </body>
    </html>
  `;
}

export function renderVerificationEmail(data: { name: string; verificationUrl: string }): string {
  return `
    <html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <h2>Verify Your Email</h2>
      <p>Hello ${data.name},</p>
      <p>Thank you for registering with KaziOS. Please verify your email by clicking the button below:</p>
      <p><a href="${data.verificationUrl}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Verify Email</a></p>
      <p>If you did not create an account, please ignore this email.</p>
      <p>KaziOS Team</p>
    </body>
    </html>
  `;
}

export function renderWelcomeEmail(data: { name: string; organizationName: string }): string {
  return `
    <html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <h2>Welcome to KaziOS!</h2>
      <p>Hello ${data.name},</p>
      <p>Welcome to KaziOS. Your organization "<strong>${data.organizationName}</strong>" is ready to use.</p>
      <p>You can start by setting up your profile, adding products, and creating your first invoice.</p>
      <p><a href="#" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Open Dashboard</a></p>
      <p>KaziOS Team</p>
    </body>
    </html>
  `;
}
