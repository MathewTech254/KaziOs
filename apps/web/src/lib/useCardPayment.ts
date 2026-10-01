import { useCallback, useRef, useState } from "react";
import { api, getApiError } from "./api";

export type CardStage =
  "IDLE" | "STARTING" | "AWAITING_CUSTOMER" | "VERIFYING" | "SUCCESS" | "FAILED";

export interface CardPaymentResult {
  reference: string;
  status: string;
  settled: boolean;
  invoice?: {
    invoiceNumber: string;
    status: string;
    paidAmount: number;
    total: number;
    currency: string;
  } | null;
  message: string;
}

/**
 * Drives one card payment from the till. The browser's only job is to show Paystack's
 * popup and report that the customer came back. The answer to "did they pay" always
 * comes from the server, which checks with Paystack directly, so a cashier cannot mark a
 * card paid by clicking a button, and a customer cannot mark it paid from the console.
 */
export function useCardPayment() {
  const [stage, setStage] = useState<CardStage>("IDLE");
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");
  const [result, setResult] = useState<CardPaymentResult | null>(null);
  const cancelled = useRef(false);

  const reset = useCallback(() => {
    cancelled.current = false;
    setStage("IDLE");
    setError("");
    setReference("");
    setResult(null);
  }, []);

  /** Asks the server to open a payment for this sale, then shows Paystack's popup. */
  const startCardPayment = useCallback(
    async (invoiceId: string, email: string): Promise<boolean> => {
      cancelled.current = false;
      setError("");
      setStage("STARTING");
      try {
        const res = await api.post<{ data: { reference: string; authorizationUrl: string } }>(
          "/card-payments/initialize",
          { invoiceId, email }
        );
        const { reference: newReference, authorizationUrl } = res.data.data;
        setReference(newReference);

        // Paystack's own secure page collects the card. No card data ever touches this app.
        const popup = window.open(authorizationUrl, "kazios_card_payment", "width=520,height=680");
        if (!popup) {
          setStage("FAILED");
          setError("The payment window was blocked. Allow pop-ups for this site and try again.");
          return false;
        }
        popup.focus();
        setStage("AWAITING_CUSTOMER");

        // The popup closing is only a hint. The real answer is fetched below.
        await new Promise<void>(resolve => {
          const check = window.setInterval(() => {
            if (popup.closed) {
              window.clearInterval(check);
              resolve();
            }
          }, 500);
        });

        if (cancelled.current) return false;
        return await verify(newReference);
      } catch (err) {
        setStage("FAILED");
        setError(getApiError(err));
        return false;
      }
    },
    // verify is defined below and is stable for the life of this hook.
    []
  );

  /**
   * Polls the server for the truth. A webhook may not have arrived yet on a slow
   * connection, so the server asks Paystack directly. Bounded so a card that is declined
   * or abandoned ends in a clear message rather than an endless spinner.
   */
  const verify = useCallback(async (target: string): Promise<boolean> => {
    setStage("VERIFYING");
    for (let attempt = 0; attempt < 20; attempt++) {
      if (cancelled.current) return false;
      try {
        const res = await api.post<{ data: CardPaymentResult }>("/card-payments/confirm", {
          reference: target,
        });
        const data = res.data.data;
        if (data.status === "SUCCESS") {
          setResult(data);
          setStage("SUCCESS");
          return true;
        }
        if (["failed", "abandoned", "reversed"].includes(data.status)) {
          setResult(data);
          setStage("FAILED");
          setError(
            "The card payment did not go through. No money has been taken; take payment another way."
          );
          return false;
        }
      } catch (err) {
        setError(getApiError(err));
        setStage("FAILED");
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    setStage("FAILED");
    setError("The payment is taking longer than expected. Check the invoice before trying again.");
    return false;
  }, []);

  const cancel = useCallback(() => {
    cancelled.current = true;
  }, []);

  return { stage, error, reference, result, startCardPayment, reset, cancel };
}
