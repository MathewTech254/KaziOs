import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  describeStkFailure,
  isMpesaEnabled,
  MpesaError,
  normalizeMsisdn,
  stkPush,
  stkQuery,
} from "../lib/mpesa";
import { settleCardPayment } from "../lib/cardPayments";

/**
 * M-PESA STK Push at the till — the second payment rail for POS sales.
 *
 * This mirrors `services/mpesaBilling` deliberately rather than generalising
 * it: the billing half charges subscriptions and activates plans, this half
 * collects invoices and marks them paid, and forcing them through one
 * abstraction is how a change for one silently breaks the other. The shared
 * rules, restated here:
 *
 *   `startMpesaPosPayment` only opens: it writes a PENDING CardPayment row
 *   (provider "MPESA") and sends the prompt to the customer's phone.
 *   `confirmMpesaPosPayment` asks Safaricom what really happened (`stkQuery`,
 *   keyed on the CheckoutRequestID we stored) and only then settles the
 *   invoice through the same `settleCardPayment` path the card rail uses, so
 *   the paid-amount arithmetic has exactly one implementation. Daraja
 *   callbacks carry no signature, so the query *is* the verification.
 *
 * What is charged: the invoice's OUTSTANDING balance (`total − paidAmount`),
 * never a figure from the browser. After the paid-amount fix in the checkout
 * route, the cash part of a split sale is already in `paidAmount`, so a
 * KES 700-cash / KES 300-M-PESA sale pushes for 300 — and a second prompt on
 * a fully paid invoice is refused rather than charged again.
 *
 * M-PESA has no subunit: the outstanding balance must be a whole number of
 * shillings. A figure like KES 99.50 is refused by name with the exact amount
 * shown, never rounded — charging a different number than the invoice states
 * is the substitution this system must never permit.
 */

/** See `mpesaBilling.QUERY_SPACING_MS`: same window, same reasoning. */
const QUERY_SPACING_MS = 4_000;
const lastQueryAt = new Map<string, number>();

/**
 * Clears the spacing window. Only tests need this: they run back-to-back in
 * milliseconds, where a wall-clock window would leak from one case into the
 * next, while real sessions are minutes apart.
 */
export function resetMpesaPosQueryThrottle(): void {
  lastQueryAt.clear();
}

/** A reference a cashier can read out if a payment is ever disputed. */
function newMpesaReference(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[^A-Za-z0-9]/g, "")}-MPESA-${randomUUID().slice(0, 8)}`;
}

/**
 * Where Safaricom posts the STK result for a till push.
 *
 * Same rule as billing: the default is this server's own webhook, which is
 * HTTPS in production. Locally it is not, and without a tunnel the push would
 * be refused by Daraja — so `null` here means "no usable callback" and the
 * caller fails with an actionable sentence before any row is written. Nothing
 * is lost by having no callback even when one *is* configured: a callback can
 * only ever trigger a query, and `confirmMpesaPosPayment` runs that same
 * query whether the callback arrived or not.
 */
function posCallbackUrl(): string | null {
  const explicit = process.env.MPESA_CALLBACK_URL?.trim();
  const api = (process.env.API_URL || "http://localhost:4000").replace(/\/+$/, "");
  const url = explicit ? explicit : `${api}/api/v1/webhooks/mpesa`;
  return url.startsWith("https://") ? url : null;
}

/** MpesaError already carries the truth; this gives it a stable machine code. */
function mpesaAppError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof MpesaError) {
    const status = err.status === 400 ? 400 : err.status === 503 ? 503 : 502;
    const code =
      status === 400
        ? "MPESA_REJECTED"
        : status === 503
          ? "MPESA_NOT_CONFIGURED"
          : "MPESA_UNAVAILABLE";
    return new AppError(status, status === 400 ? err.message : `${context}: ${err.message}`, code);
  }
  return new AppError(502, `${context}: M-PESA could not be reached`, "MPESA_UNAVAILABLE");
}

export interface MpesaPosOpenResult {
  reference: string;
  checkoutRequestId: string;
  amountCents: number;
  currency: string;
  phone: string;
  customerMessage: string;
}

/**
 * Opens an M-PESA payment for a POS sale: the invoice's outstanding balance,
 * a PENDING row, and the STK prompt sent to the customer's phone.
 *
 * Nothing about the invoice changes here — the sale already exists (stock
 * has moved and the sale is on the books); it turns paid only when Safaricom
 * says the money moved.
 */
export async function startMpesaPosPayment(input: {
  invoiceId: string;
  organizationId: string;
  phone: string;
}): Promise<MpesaPosOpenResult> {
  if (!isMpesaEnabled()) {
    throw new AppError(
      503,
      "M-PESA payments are not configured on this terminal",
      "MPESA_NOT_CONFIGURED"
    );
  }

  const phone = normalizeMsisdn(input.phone);
  if (!phone) {
    throw new AppError(
      400,
      "Enter a valid Kenyan phone number (e.g. 0712345678)",
      "MPESA_PHONE_INVALID"
    );
  }

  // Checked before any row is written: failing here with an actionable
  // sentence beats Daraja's own opaque 400 minutes later (see docs/MPESA.md —
  // an ngrok or cloudflared tunnel works locally).
  const callbackUrl = posCallbackUrl();
  if (!callbackUrl) {
    throw new AppError(
      400,
      "Safaricom only accepts HTTPS callback URLs. Set MPESA_CALLBACK_URL to your public HTTPS endpoint (docs/MPESA.md explains, an ngrok tunnel works locally).",
      "MPESA_CALLBACK_UNSAFE"
    );
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: {
      id: true,
      invoiceNumber: true,
      total: true,
      paidAmount: true,
      currency: true,
      status: true,
    },
  });
  if (!invoice) throw new AppError(404, "Invoice not found");
  if (invoice.status === "VOID" || invoice.status === "CANCELLED") {
    throw new AppError(400, "This sale has been cancelled and cannot be paid");
  }

  const currency = (invoice.currency || "KES").toUpperCase();
  if (currency !== "KES") {
    throw new AppError(
      400,
      "M-PESA only collects Kenyan shillings. Take this sale in another way.",
      "MPESA_CURRENCY"
    );
  }

  // What Safaricom will be asked for: the balance still owed, in integer
  // cents, derived from the stored invoice — never from anything the browser
  // said. This is what makes a split sale work: the cash tender is already in
  // paidAmount, so only the remainder is pushed.
  const outstandingCents =
    Math.round(invoice.total * 100) - Math.round(Number(invoice.paidAmount || 0) * 100);
  if (outstandingCents <= 0) {
    throw new AppError(400, "This sale is already fully paid", "INVOICE_ALREADY_PAID");
  }
  if (outstandingCents % 100 !== 0) {
    throw new AppError(
      400,
      `The balance on ${invoice.invoiceNumber} is ${(outstandingCents / 100).toFixed(2)} KES. M-PESA collects whole shillings — take the ${(outstandingCents % 100) / 100} shilling part by cash or adjust the sale.`,
      "MPESA_NOT_WHOLE_SHILLINGS"
    );
  }
  const amountShillings = outstandingCents / 100;

  // A repeat tap reuses the prompt already in flight for this balance, so two
  // taps cannot push two charges for one sale.
  let row = await prisma.cardPayment.findFirst({
    where: { invoiceId: invoice.id, provider: "MPESA", status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  if (row && row.amountCents !== outstandingCents) {
    // The balance changed since this prompt was opened (a tender was added or
    // the sale was edited); pushing it now would charge the old number. The
    // row is kept as the record of the attempt, never silently retargeted.
    await prisma.cardPayment
      .update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          failureReason: "Superseded: the balance on the sale changed",
        },
      })
      .catch(() => undefined);
    row = null;
  }
  if (row?.providerRef) {
    return {
      reference: row.reference,
      checkoutRequestId: row.providerRef,
      amountCents: row.amountCents,
      currency: row.currency,
      phone,
      customerMessage: "Check your phone for the M-PESA prompt",
    };
  }

  const reference = row?.reference ?? newMpesaReference(invoice.invoiceNumber);
  let paymentId = row?.id;
  if (!paymentId) {
    const created = await prisma.cardPayment.create({
      data: {
        reference,
        invoiceId: invoice.id,
        organizationId: input.organizationId,
        amountCents: outstandingCents,
        currency,
        email: phone,
        provider: "MPESA",
        status: "PENDING",
      },
    });
    paymentId = created.id;
  }

  try {
    const push = await stkPush({
      phone,
      amountShillings,
      reference,
      callbackUrl,
    });

    await prisma.cardPayment.update({
      where: { id: paymentId },
      data: { providerRef: push.checkoutRequestId },
    });

    return {
      reference,
      checkoutRequestId: push.checkoutRequestId,
      amountCents: outstandingCents,
      currency,
      phone,
      customerMessage: push.customerMessage,
    };
  } catch (err) {
    // The prompt was never accepted, so nothing was charged. The row is kept
    // as failed rather than deleted: the attempt itself is worth knowing about.
    await prisma.cardPayment
      .update({
        where: { id: paymentId },
        data: {
          status: "FAILED",
          failureReason: err instanceof Error ? err.message : "The M-PESA prompt could not be sent",
        },
      })
      .catch(() => undefined);

    throw mpesaAppError(err, "The M-PESA payment could not be started");
  }
}

export interface MpesaPosConfirmResult {
  status: string;
  settled: boolean;
  reference?: string;
  amountCents?: number;
  currency?: string;
  /** Set when no verdict was obtained — the caller should simply ask again. */
  retryable?: boolean;
  message: string;
}

/**
 * Settles a POS payment after asking Safaricom what really happened.
 *
 * The mirror of `confirmMpesaCheckout` and of `confirmCardPayment`: the
 * browser only says "I might have paid", and only `stkQuery` — keyed on the
 * CheckoutRequestID stored at push time — decides. The verdict, whichever way
 * it goes, either settles the invoice through `settleCardPayment` (the one
 * place paid amounts move) or marks the row failed with Safaricom's own
 * reason.
 */
export async function confirmMpesaPosPayment(reference: string): Promise<MpesaPosConfirmResult> {
  const record = await prisma.cardPayment.findUnique({ where: { reference } });
  if (!record) throw new AppError(404, "Payment not found");
  if (record.provider !== "MPESA") {
    // A card reference pressed against this route, or the reverse. The two
    // rails never settle each other's rows.
    throw new AppError(
      409,
      "This payment belongs to the other payment method. Confirm it the way it was opened.",
      "WRONG_PAYMENT_RAIL"
    );
  }

  if (record.status === "SUCCESS") {
    return {
      status: "SUCCESS",
      settled: true,
      reference,
      amountCents: record.amountCents,
      currency: record.currency,
      message: "This payment was already applied.",
    };
  }

  const checkoutRequestId = record.providerRef;
  if (!checkoutRequestId) {
    // The push never reached Safaricom (the row was marked FAILED at open
    // time), so there is nothing to ask about and nothing has been charged.
    return {
      status: record.status,
      settled: false,
      // Not retryable: the prompt never reached Safaricom, so no future
      // question can ever change this answer. The till stops polling here.
      retryable: false,
      reference,
      message:
        "This M-PESA payment was never sent to the phone, so nothing has been charged. Start the payment again.",
    };
  }

  // The poll and a returning cashier arrive together; only one of them earns a
  // trip to Daraja per spacing window. The others are answered from the
  // window — PENDING, because nothing has been learned either way.
  const lastAsk = lastQueryAt.get(checkoutRequestId);
  if (lastAsk !== undefined && Date.now() - lastAsk < QUERY_SPACING_MS) {
    return {
      status: "PENDING",
      settled: false,
      retryable: true,
      message: "M-PESA is still being asked about this payment. The check continues in a moment.",
    };
  }

  let result;
  try {
    lastQueryAt.set(checkoutRequestId, Date.now());
    result = await stkQuery(checkoutRequestId);
  } catch (err) {
    // A missing configuration is a real fact about this server and stays an
    // error. Everything else means no verdict exists: nothing has changed and
    // the answer says so plainly instead of being dressed up as a rejection.
    if (err instanceof MpesaError && err.status === 503) {
      throw mpesaAppError(err, "The payment has not been confirmed yet");
    }
    return {
      status: "PENDING",
      settled: false,
      retryable: true,
      message:
        "M-PESA has not answered yet (Safaricom is busy or unreachable). Nothing has been charged; we will ask again in a moment.",
    };
  }

  if (result.state === "PENDING") {
    return {
      status: "PENDING",
      settled: false,
      message:
        "M-PESA has not decided this payment yet. Enter the PIN on the phone if the prompt is still showing, then check again in a moment.",
    };
  }

  // A verdict, whichever way it went, ends the spacing: the next confirm has
  // nothing left to ask about except the row's own state.
  lastQueryAt.delete(checkoutRequestId);

  if (result.state === "FAILED") {
    const reason = describeStkFailure(result.resultCode, result.resultDesc);
    await prisma.cardPayment
      .update({
        where: { reference },
        data: { status: "FAILED", failureReason: reason },
      })
      .catch(() => undefined);

    return { status: "FAILED", settled: false, reference, message: reason };
  }

  // Safaricom says the push succeeded. The amount it reports is checked when
  // it reports one; when the query carries no metadata (Daraja's query often
  // does not), the CheckoutRequestID is itself the binding — it names the one
  // push we opened with this exact balance, so success on that key is success
  // for this amount.
  if (
    record.currency.toUpperCase() !== "KES" ||
    (result.amountShillings != null && result.amountShillings * 100 !== record.amountCents)
  ) {
    throw new AppError(
      409,
      "The amount M-PESA confirmed does not match this sale. The payment has been left unapplied; please check it before retrying.",
      "AMOUNT_MISMATCH"
    );
  }

  // The receipt is the permanent record of the charge; without metadata from
  // the query, the CheckoutRequestID — the key everything joined on until now —
  // remains the reference.
  await settleCardPayment(
    reference,
    {
      providerRef: result.receipt ?? checkoutRequestId,
      paidAt: result.paidAt ? new Date(result.paidAt) : new Date(),
    },
    "success"
  );

  return {
    status: "SUCCESS",
    settled: true,
    reference,
    amountCents: record.amountCents,
    currency: record.currency,
    message: "Payment received.",
  };
}
