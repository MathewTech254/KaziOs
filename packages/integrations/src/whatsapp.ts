export interface WhatsappMessage {
  to: string;
  body: string;
  type?: "text" | "template";
  template?: string;
  parameters?: Record<string, any>;
}

export interface WhatsappResult {
  messageId: string;
  status: "sent" | "failed" | "not_configured";
  error?: string;
}

export class WhatsappProvider {
  private provider: string;
  private apiKey?: string;
  private from?: string;

  constructor(config: { provider: string; apiKey?: string; from?: string }) {
    this.provider = config.provider;
    this.apiKey = config.apiKey;
    this.from = config.from;
  }

  async send(message: WhatsappMessage): Promise<WhatsappResult> {
    if (this.provider === "console") {
      console.log("\n=== WHATSAPP ===");
      console.log("From:", this.from);
      console.log("To:", message.to);
      console.log("Body:", message.body);
      console.log("=== END WHATSAPP ===\n");
      return { messageId: "console", status: "sent" };
    }

    if (!this.apiKey) {
      return { messageId: "", status: "not_configured", error: "WhatsApp provider not configured" };
    }

    return { messageId: "", status: "failed", error: `WhatsApp provider ${this.provider} not implemented` };
  }
}
