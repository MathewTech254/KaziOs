import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "crypto";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { FEATURE_KEYS } from "@kazios/types";
import { loadConfig } from "@kazios/config";
import { prisma } from "../lib/prisma";
import { WhatsappProvider } from "@kazios/integrations";
import { assertFeature, assertWithinLimit, getEntitlements } from "../services/entitlements";
import { recordAiRequest } from "../services/usage";
import { aiAssistantEnabled, askBusiness } from "../services/aiAssistant";

/**
 * The AI assistant surface.
 *
 * Two guards, both on the server, before a single token is spent:
 *   - the plan must include the AI assistant capability, and
 *   - the business must be inside its monthly AI-request allowance.
 * The browser hiding a button stops an honest user; these stop everyone else. Every accepted
 * request is then metered, so the allowance a shop is shown is the allowance it is held to.
 */

export const aiRouter = Router();

const zAsk = z.object({
  question: z.string().min(2).max(500),
  /** Optional session id for conversation memory. Falls back to the authenticated session. */
  sessionId: z.string().optional(),
});

/** Whether the assistant is available at all: the plan allows it and a key is configured. */
aiRouter.get("/status", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const entitlements = await getEntitlements(req.organizationId!);
    const planAllows = entitlements.features.has(FEATURE_KEYS.AI_ASSISTANT);
    res.json({
      data: {
        available: planAllows && aiAssistantEnabled(),
        planAllows,
        configured: aiAssistantEnabled(),
      },
    });
  } catch (err) {
    next(err);
  }
});

aiRouter.post(
  "/ask",
  requireAuth,
  requirePermission("reports.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = req.organizationId!;

      // Capability first, then allowance. They answer different questions: the first is
      // whether AI is in the plan at all, the second is how many questions are left.
      const entitlements = await getEntitlements(organizationId);
      await assertFeature(entitlements, FEATURE_KEYS.AI_ASSISTANT, { featureName: "AI assistant" });
      await assertWithinLimit(entitlements, "ai_requests", {
        featureKey: FEATURE_KEYS.AI_ASSISTANT,
      });

      if (!aiAssistantEnabled()) {
        // The plan allows it but no key is set on the server. A clear 503 beats a vague 500.
        throw new AppError(
          503,
          "The AI assistant is not configured on this server yet. Please try again later."
        );
      }

      const { question, sessionId } = zAsk.parse(req.body);

      // Currency comes from the shop, not the client, so a caller cannot spoof the unit.
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true },
      });
      const currency = org?.currency || "KES";

      // The user's permissions gate which write tools may execute. Read tools ignore them.
      const permissions = (req.roles || []).flatMap((r: any) => r.role?.permissions || []);
      // Prefer the client-supplied session id, falling back to the authenticated session.
      const effectiveSessionId = sessionId || req.sessionId;
      const answer = await askBusiness(
        organizationId,
        currency,
        question,
        permissions,
        effectiveSessionId
      );

      // Metered after the work is done, best-effort: an unanswered question is worse than an
      // uncounted one, so a counter failure never takes the answer away from the shop.
      await recordAiRequest(organizationId, true);

      res.json({ data: answer });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * WhatsApp inbound webhook.
 *
 * Mounted by the main app at /api/v1/webhooks (unauthenticated, above rate limiters) so
 * Meta can reach it without a session. Like Paystack, it is trusted only by signature,
 * never by network position.
 *
 * Two entry points:
 *   GET  /whatsapp   - Meta's webhook subscription verification (echoes hub.challenge)
 *   POST /whatsapp   - Inbound messages and status updates from WhatsApp
 *
 * Environment:
 *   WHATSAPP_VERIFY_TOKEN - token Meta sends during verification; must match what you
 *                           entered in the Meta developer dashboard.
 *   WHATSAPP_APP_SECRET   - app secret used to verify X-Hub-Signature-256.
 */
export const whatsappWebhookRouter = Router();

function verifySignature(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  appSecret: string
): boolean {
  if (!rawBody || !signature || !appSecret) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(sigBuffer, expectedBuffer);
}

// GET: Meta's webhook verification challenge. The dashboard sends
// hub.mode=subscribe, hub.verify_token=<token>, hub.challenge=<random>.
// Answering with the challenge completes the subscription.
whatsappWebhookRouter.get("/whatsapp", (_req: Request, res: Response) => {
  const config = loadConfig();
  const mode = _req.query["hub.mode"];
  const token = _req.query["hub.verify_token"];
  const challenge = _req.query["hub.challenge"];

  const expectedToken = config.whatsapp.verifyToken;
  if (!expectedToken) {
    res
      .status(500)
      .json({ error: "WhatsApp webhook not configured: missing WHATSAPP_VERIFY_TOKEN" });
    return;
  }
  if (mode !== "subscribe" || token !== expectedToken) {
    res.status(403).json({ error: "Verification failed" });
    return;
  }
  res.status(200).send(String(challenge));
});

// POST: Inbound messages and delivery statuses from WhatsApp.
// Meta expects a 200 quickly; we acknowledge first, then process.
whatsappWebhookRouter.post("/whatsapp", async (req: Request, res: Response, next) => {
  const config = loadConfig();

  // Signature verification: without the app secret, we cannot trust the sender.
  if (!config.whatsapp.appSecret) {
    res.status(500).json({ error: "WhatsApp webhook not configured: missing WHATSAPP_APP_SECRET" });
    return;
  }
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!verifySignature((req as any).rawBody, signature, config.whatsapp.appSecret)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const body = req.body;
  if (body.object !== "whatsapp_business_account") {
    res.status(200).json({ received: true });
    return;
  }

  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const value = change.value;

        // Status updates (message delivered/read) are acknowledged but do not trigger replies.
        if (value.statuses) {
          // Delivery/read receipts are acknowledged but do not trigger replies.
          continue;
        }

        // Inbound messages: echo back via the AI assistant if configured, otherwise just log.
        const messages = value.messages ?? [];
        for (const message of messages) {
          const from = message.from; // customer's WhatsApp number
          const text = message.text?.body;

          if (!from || !text) continue;

          // Best-effort reply: route through the same assistant as the chat widget.
          // The session id is the phone number so conversations stay threaded per customer.
          try {
            const answer = await askBusiness(
              "org-webhook", // placeholder org; real pairing comes in Phase 4 shop linking
              "KES",
              text,
              [],
              `whatsapp:${from}`
            );
            const provider = new WhatsappProvider({
              provider: config.whatsapp.provider,
              apiKey: config.whatsapp.apiKey,
              from: config.whatsapp.from,
            });
            await provider.send({ to: from, body: answer.answer });
          } catch (err) {
            // Never fail a webhook because the assistant is down: Meta only cares about 200.
            console.error("WhatsApp webhook reply failed:", err);
          }
        }
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
});
