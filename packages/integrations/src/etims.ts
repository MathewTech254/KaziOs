import { readJson } from "./http";

interface EtimResponseBody {
  message?: string;
  access_token?: string;
  data?: { id?: string; receiptId?: string; status?: string };
}

export interface EtimSubmission {
  id: string;
  organizationId: string;
  invoiceId?: string;
  creditNoteId?: string;
  receiptId?: string;
  status: EtimStatus;
  providerRef?: string;
  requestData: Record<string, any>;
  responseData?: Record<string, any>;
  errors?: string;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
  submittedAt?: Date;
}

export type EtimStatus = "PENDING" | "SUBMITTED" | "ACCEPTED" | "REJECTED" | "FAILED" | "RETRYING";

export interface EtimProvider {
  healthCheck(): Promise<EtimHealthResult>;
  submitInvoice(invoice: EtimInvoicePayload): Promise<EtimSubmissionResult>;
  submitCreditNote(creditNote: EtimCreditNotePayload): Promise<EtimSubmissionResult>;
  submitReceipt(receipt: EtimReceiptPayload): Promise<EtimSubmissionResult>;
  queryStatus(providerRef: string): Promise<EtimStatus>;
}

export interface EtimSubmissionResult {
  status: EtimStatus;
  providerRef?: string;
  errors?: string;
}

export interface EtimHealthResult {
  status: "healthy" | "degraded" | "unhealthy";
  provider: string;
  message?: string;
}

export interface EtimInvoicePayload {
  organizationId: string;
  invoiceId: string;
  invoicerTIN: string;
  invoicerName: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  customerName: string;
  customerTIN?: string;
  items: Array<{
    itemCode: string;
    itemName: string;
    unitPrice: number;
    quantity: number;
    taxRate: number;
    taxAmount: number;
    totalAmount: number;
  }>;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  currency: string;
}

export interface EtimCreditNotePayload {
  organizationId: string;
  creditNoteId: string;
  invoiceNumber: string;
  creditNoteNumber: string;
  issueDate: string;
  reason: string;
  items: Array<{
    itemCode: string;
    itemName: string;
    quantity: number;
    unitPrice: number;
    taxAmount: number;
    totalAmount: number;
  }>;
  grandTotal: number;
  currency: string;
}

export interface EtimReceiptPayload {
  organizationId: string;
  receiptId: string;
  receiptNumber: string;
  paymentId: string;
  amount: number;
  paymentDate: string;
  paymentMethod: string;
  customerName: string;
  currency: string;
}

export class EtimProviderNotConfiguredError extends Error {
  constructor() {
    super("eTIMS provider is not configured. Set ETIMS_API_URL, ETIMS_CLIENT_ID, and ETIMS_CLIENT_SECRET.");
    this.name = "EtimProviderNotConfiguredError";
  }
}

export class StubEtimProvider implements EtimProvider {
  async healthCheck(): Promise<EtimHealthResult> {
    return {
      status: "unhealthy",
      provider: "etims",
      message: "eTIMS provider is not configured",
    };
  }

  async submitInvoice(_invoice: EtimInvoicePayload): Promise<EtimSubmissionResult> {
    throw new EtimProviderNotConfiguredError();
  }

  async submitCreditNote(_creditNote: EtimCreditNotePayload): Promise<EtimSubmissionResult> {
    throw new EtimProviderNotConfiguredError();
  }

  async submitReceipt(_receipt: EtimReceiptPayload): Promise<EtimSubmissionResult> {
    throw new EtimProviderNotConfiguredError();
  }

  async queryStatus(_providerRef: string): Promise<EtimStatus> {
    throw new EtimProviderNotConfiguredError();
  }
}

export class EtimProviderImpl implements EtimProvider {
  private apiUrl: string;
  private clientId: string;
  private clientSecret: string;

  constructor(config: { apiUrl: string; clientId: string; clientSecret: string }) {
    if (!config.apiUrl || !config.clientId || !config.clientSecret) {
      throw new EtimProviderNotConfiguredError();
    }
    this.apiUrl = config.apiUrl;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
  }

  async healthCheck(): Promise<EtimHealthResult> {
    try {
      const token = await this.getAccessToken();
      const response = await fetch(`${this.apiUrl}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        return { status: "healthy", provider: "etims" };
      }
      return { status: "degraded", provider: "etims", message: `HTTP ${response.status}` };
    } catch (error) {
      return { status: "unhealthy", provider: "etims", message: String(error) };
    }
  }

  async submitInvoice(invoice: EtimInvoicePayload): Promise<EtimSubmissionResult> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.apiUrl}/invoices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        invoiceNo: invoice.invoiceNumber,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        customerName: invoice.customerName,
        customerTIN: invoice.customerTIN,
        items: invoice.items,
        subTotal: invoice.subtotal,
        taxTotal: invoice.taxTotal,
        grandTotal: invoice.grandTotal,
        currency: invoice.currency,
      }),
    });

    const data = await readJson<EtimResponseBody>(response);

    if (!response.ok) {
      return {
        status: "REJECTED",
        errors: data.message || JSON.stringify(data),
      };
    }

    return {
      status: "ACCEPTED",
      providerRef: data.data?.id || data.data?.receiptId,
    };
  }

  async submitCreditNote(_creditNote: EtimCreditNotePayload): Promise<EtimSubmissionResult> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.apiUrl}/credit-notes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(_creditNote),
    });

    const data = await readJson<EtimResponseBody>(response);

    if (!response.ok) {
      return { status: "REJECTED", errors: data.message || JSON.stringify(data) };
    }

    return { status: "ACCEPTED", providerRef: data.data?.id };
  }

  async submitReceipt(_receipt: EtimReceiptPayload): Promise<EtimSubmissionResult> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.apiUrl}/receipts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(_receipt),
    });

    const data = await readJson<EtimResponseBody>(response);

    if (!response.ok) {
      return { status: "REJECTED", errors: data.message || JSON.stringify(data) };
    }

    return { status: "ACCEPTED", providerRef: data.data?.id };
  }

  async queryStatus(providerRef: string): Promise<EtimStatus> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.apiUrl}/submissions/${providerRef}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      return "FAILED";
    }

    const data = await readJson<EtimResponseBody>(response);
    const statusMap: Record<string, EtimStatus> = {
      accepted: "ACCEPTED",
      rejected: "REJECTED",
      submitted: "SUBMITTED",
      failed: "FAILED",
    };

    const status = data.data?.status;
    return (status ? statusMap[status] : undefined) || "PENDING";
  }

  private async getAccessToken(): Promise<string> {
    const response = await fetch(`${this.apiUrl}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        grantType: "client_credentials",
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to authenticate with eTIMS");
    }

    const data = await readJson<EtimResponseBody>(response);
    if (!data.access_token) {
      throw new Error("eTIMS did not return an access token");
    }
    return data.access_token;
  }
}

export function createEtimProvider(config: {
  apiUrl?: string;
  clientId?: string;
  clientSecret?: string;
}): EtimProvider {
  if (config.apiUrl && config.clientId && config.clientSecret) {
    return new EtimProviderImpl(config as { apiUrl: string; clientId: string; clientSecret: string });
  }
  return new StubEtimProvider();
}
