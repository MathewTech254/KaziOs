export interface SmsOptions {
  to: string;
  message: string;
  from?: string;
}

export interface SmsResult {
  messageId: string;
  status: "sent" | "failed";
  error?: string;
}

export class SmsProvider {
  constructor(private provider: string) {}

  async send(options: SmsOptions): Promise<SmsResult> {
    if (this.provider === "console") {
      console.log("\n=== SMS ===");
      console.log("To:", options.to);
      console.log("Message:", options.message);
      console.log("=== END SMS ===\n");
      return { messageId: "console", status: "sent" };
    }
    throw new Error(`SMS provider "${this.provider}" not configured`);
  }
}
