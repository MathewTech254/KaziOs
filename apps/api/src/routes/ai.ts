import { Router } from "express";
import { z } from "zod";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { FEATURE_KEYS } from "@kazios/types";
import { prisma } from "../lib/prisma";
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

      const { question } = zAsk.parse(req.body);

      // Currency comes from the shop, not the client, so a caller cannot spoof the unit.
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true },
      });
      const currency = org?.currency || "KES";

      // The user's permissions gate which write tools may execute. Read tools ignore them.
      const permissions = (req.roles || []).flatMap((r: any) => r.role?.permissions || []);
      const answer = await askBusiness(organizationId, currency, question, permissions);

      // Metered after the work is done, best-effort: an unanswered question is worse than an
      // uncounted one, so a counter failure never takes the answer away from the shop.
      await recordAiRequest(organizationId, true);

      res.json({ data: answer });
    } catch (err) {
      next(err);
    }
  }
);
