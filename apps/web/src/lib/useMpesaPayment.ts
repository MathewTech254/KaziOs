import { useCallback, useRef, useState } from "react";
import { api, getApiError } from "./api";

export type MpesaStage =
  "IDLE" | "STARTING" | "AWAITING_CUSTOMER" | "VERIFYING" | "SUCCESS" | "FAILED";

export interface MpesaConfirmResult {
  status: string;
  settled: boolean;
  reference?: string;
  /**
   * Server triage for a PENDING answer: `true` means asking again may still
   * learn something, `false` means this row can never resolve (its prompt
   * never reached Safaricom). Only an explicit `false` ends the polling —
   * an undecided Safaricom keeps the cashier waiting, not failing.
   */
  retryable?: boolean;
  message: string;
  invoice?: {
    invoiceNumber: string;
    status: string;
    paidAmount: number;
    total: number;
    currency: string;
  } | null;
}

/**
 * Drives one M-PESA payment from the till. The browser's only job is to send
 * the phone number, show the prompt's progress, and keep asking the server
 * what Safaricom decided. The answer to "did they pay" always comes from the
 * server's own `stkQuery`, keyed on the CheckoutRequestID stored at push
 * time — a cashier cannot mark a sale paid by clicking a button, and no
 * browser can settle anything by claiming it happened in the console.
 */
export function useMpesaPayment() {
  const [stage, setStage] = useState<MpesaStage>("IDLE");
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");
  const [result, setResult] = useState<MpesaConfirmResult | null>(null);
  const cancelled = useRef(false);

  const reset = useCallback(() => {
    cancelled.current = false;
    setStage("IDLE");
    setError("");
    setReference("");
    setResult(null);
  }, []);

  /**
   * Polls the server for the truth. Spaced past the server's own 4-second
   * query window so every poll is a real question rather than an answer from
   * the throttle, and bounded to just over a 60-second STK prompt so a
   * declined, cancelled or expired prompt ends in a clear message instead of
   * an endless spinner.
   */
  const confirm = useCallback(async (target: string): Promise<boolean> => {
    setStage("VERIFYING");
    for (let attempt = 0; attempt < 15; attempt++) {
      if (cancelled.current) return false;
      try {
        const res = await api.post<{ data: MpesaConfirmResult }>("/pos/mpesa/confirm", {
          reference: target,
        });
        const data = res.data.data;
        if (data.status === "SUCCESS") {
          setResult(data);
          setStage("SUCCESS");
          return true;
        }
        if (data.status === "FAILED") {
          setResult(data);
          setStage("FAILED");
          setError(
            data.message ||
              "The M-PESA payment did not go through. No money has been taken; take payment another way."
          );
          return false;
        }
        // PENDING from a row that can never resolve: asking again cannot
        // change it, so the reason is surfaced rather than spun on.
        if (data.retryable === false) {
          setResult(data);
          setStage("FAILED");
          setError(data.message);
          return false;
        }
        // Anything else is a real wait: Safaricom has not decided yet, or
        // could not be asked. Both are the same patience from here.
      } catch (err) {
        // A wrong rail, an amount mismatch, a lost configuration — shown as
        // the server worded it. None of them are fixed by asking again, so
        // the loop ends with the sentence a cashier can act on.
        setResult(null);
        setStage("FAILED");
        setError(getApiError(err));
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 4500));
    }
    setStage("FAILED");
    setError(
      "M-PESA has not answered within the usual window. Check the invoice before taking payment another way."
    );
    return false;
  }, []);

  /**
   * Opens the prompt on the customer's phone, then polls until Safaricom
   * decides. Returns true only when the server reports the money settled.
   */
  const startMpesaPayment = useCallback(
    async (invoiceId: string, phone: string): Promise<boolean> => {
      cancelled.current = false;
      setError("");
      setResult(null);
      setStage("STARTING");
      try {
        const res = await api.post<{ data: { reference: string; customerMessage: string } }>(
          `/pos/sales/${invoiceId}/mpesa`,
          { phone }
        );
        const opened = res.data.data;
        setReference(opened.reference);
        setStage("AWAITING_CUSTOMER");
        if (cancelled.current) return false;
        return await confirm(opened.reference);
      } catch (err) {
        setStage("FAILED");
        setError(getApiError(err));
        return false;
      }
    },
    [confirm]
  );

  const cancel = useCallback(() => {
    cancelled.current = true;
  }, []);

  return { stage, error, reference, result, startMpesaPayment, reset, cancel };
}
