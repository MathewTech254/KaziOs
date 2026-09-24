import * as crypto from "crypto";
import { readJson } from "./http";

export interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  provider: PaymentProviderType;
  status: PaymentIntentStatus;
  metadata: Record<string, any>;
  redirectUrl?: string;
  clientSecret?: string;
}

export type PaymentProviderType = "PAYSTACK" | "MPESA" | "BANK" | "MANUAL" | "CASH";
export type PaymentIntentStatus = "PENDING" | "SUCCESS" | "FAILED" | "CANCELLED";

export interface PaymentProvider {
  initializePayment(intent: PaymentIntentRequest): Promise<PaymentIntentResponse>;
  verifyPayment(reference: string): Promise<PaymentVerificationResult>;
  createRefund(transactionRef: string, amount?: number): Promise<PaymentRefundResult>;
  verifyWebhookSignature(payload: string, signature: string): boolean;
}

export interface PaymentIntentRequest {
  amount: number;
  currency: string;
  reference: string;
  customerEmail?: string;
  customerName?: string;
  metadata?: Record<string, any>;
  callbackUrl?: string;
  channels?: string[];
}

export interface PaymentIntentResponse {
  status: "success" | "failed";
  message: string;
  data?: {
    authorizationUrl?: string;
    accessCode?: string;
    reference?: string;
  };
}

export interface PaymentVerificationResult {
  status: PaymentIntentStatus;
  amount: number;
  currency: string;
  reference: string;
  message?: string;
  customerEmail?: string;
  channel?: string;
  transactionDate?: Date;
  providerRef?: string;
  metadata?: Record<string, any>;
}

export interface PaymentRefundResult {
  status: "success" | "failed";
  message: string;
  data?: {
    reference?: string;
    amount?: number;
  };
}

interface PaystackInitializeBody {
  status?: boolean;
  message?: string;
  data?: {
    authorization_url?: string;
    access_code?: string;
    reference?: string;
  };
}

interface PaystackVerifyBody {
  status?: boolean;
  message?: string;
  data: {
    status: string;
    amount: number;
    currency?: string;
    reference: string;
    customer?: { email?: string };
    channel?: string;
    transaction_date?: string;
    id?: number;
    metadata?: Record<string, any>;
  };
}

interface PaystackRefundBody {
  status?: boolean;
  message?: string;
  data?: { reference?: string; amount?: number };
}

export class StubPaymentProvider implements PaymentProvider {
  constructor(private providerType: PaymentProviderType) {}

  async initializePayment(_req: PaymentIntentRequest): Promise<PaymentIntentResponse> {
    throw new PaymentProviderNotConfiguredError(this.providerType);
  }

  async verifyPayment(_reference: string): Promise<PaymentVerificationResult> {
    throw new PaymentProviderNotConfiguredError(this.providerType);
  }

  async createRefund(_transactionRef: string, _amount?: number): Promise<PaymentRefundResult> {
    throw new PaymentProviderNotConfiguredError(this.providerType);
  }

  verifyWebhookSignature(_payload: string, _signature: string): boolean {
    return false;
  }
}

export class PaymentProviderNotConfiguredError extends Error {
  constructor(public providerType: PaymentProviderType) {
    super(`${providerType} payment provider is not configured. Set the required environment variables.`);
    this.name = "PaymentProviderNotConfiguredError";
  }
}

export class PaystackProvider implements PaymentProvider {
  private secretKey: string;
  private webhookSecret: string;
  private baseUrl = "https://api.paystack.co";

  constructor(config: { secretKey: string; webhookSecret: string }) {
    if (!config.secretKey || !config.webhookSecret) {
      throw new PaymentProviderNotConfiguredError("PAYSTACK");
    }
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret;
  }

  async initializePayment(req: PaymentIntentRequest): Promise<PaymentIntentResponse> {
    const response = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: req.amount,
        currency: req.currency,
        email: req.customerEmail,
        reference: req.reference,
        metadata: req.metadata,
        callback_url: req.callbackUrl,
        channels: req.channels,
      }),
    });

    const data = await readJson<PaystackInitializeBody>(response);

    if (!response.ok || data.status === false) {
      return { status: "failed", message: data.message || "Payment initialization failed" };
    }

    return {
      status: "success",
      message: data.message || "Payment initialized",
      data: {
        authorizationUrl: data.data?.authorization_url,
        accessCode: data.data?.access_code,
        reference: data.data?.reference,
      },
    };
  }

  async verifyPayment(reference: string): Promise<PaymentVerificationResult> {
    const response = await fetch(`${this.baseUrl}/transaction/verify/${reference}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    const data = await readJson<PaystackVerifyBody>(response);

    if (!response.ok || data.status === false) {
      return {
        status: "FAILED",
        amount: 0,
        currency: "NGN",
        reference,
        message: data.message || "Verification failed",
      };
    }

    const txn = data.data;
    return {
      status: this.mapPaystackStatus(txn.status),
      amount: txn.amount,
      currency: txn.currency || "NGN",
      reference: txn.reference,
      customerEmail: txn.customer?.email,
      channel: txn.channel,
      transactionDate: txn.transaction_date ? new Date(txn.transaction_date) : undefined,
      providerRef: txn.id?.toString(),
      metadata: txn.metadata,
    };
  }

  async createRefund(transactionRef: string, amount?: number): Promise<PaymentRefundResult> {
    const body: any = {};
    if (amount) body.amount = amount;

    const response = await fetch(`${this.baseUrl}/refund`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transaction: transactionRef,
        ...body,
      }),
    });

    const data = await readJson<PaystackRefundBody>(response);

    if (!response.ok || data.status === false) {
      return { status: "failed", message: data.message || "Refund failed" };
    }

    return {
      status: "success",
      message: data.message || "Refund processed",
      data: {
        reference: data.data?.reference,
        amount: data.data?.amount,
      },
    };
  }

  verifyWebhookSignature(payload: string, signature: string): boolean {
    const hmac = crypto.createHmac("sha512", this.webhookSecret);
    hmac.update(payload);
    const expected = hmac.digest("hex");
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  private mapPaystackStatus(status: string): PaymentIntentStatus {
    switch (status) {
      case "success":
        return "SUCCESS";
      case "failed":
        return "FAILED";
      case "pending":
        return "PENDING";
      case "abandoned":
        return "CANCELLED";
      default:
        return "PENDING";
    }
  }
}
