import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib";
import { FEATURE_CATEGORIES, UNLIMITED } from "@kazios/types";

export const planRouter = Router();

/**
 * The public plan catalogue, read straight from the database.
 *
 * Nothing here is hardcoded. A plan's name, price, features and limits are all rows, so an
 * administrator can re-price a plan or retire one without a deployment, and the pricing
 * page cannot drift from what the API will actually enforce.
 *
 * This route is unauthenticated on purpose: the pricing page has to be readable by
 * somebody deciding whether to sign up, and it exposes nothing a customer could not be
 * told. It returns the catalogue, never anybody's subscription.
 */

/** The shape the pricing page renders. Derived entirely from stored rows. */
export async function buildCatalogue() {
  const plans = await prisma.plan.findMany({
    where: { status: "ACTIVE", visibility: "PUBLIC" },
    include: {
      prices: { where: { isActive: true } },
      features: { include: { feature: true } },
      limits: true,
    },
    orderBy: { sortOrder: "asc" },
  });

  return plans.map(plan => ({
    key: plan.key,
    name: plan.name,
    description: plan.description,
    highlight: plan.highlight,
    isFree: plan.isFree,
    isDefault: plan.isDefault,
    trialDays: plan.trialDays,
    visibility: plan.visibility,
    yearlyPerMonthCents: plan.yearlyPerMonthCents,
    prices: plan.prices.map(price => ({
      interval: price.interval,
      amountCents: price.amountCents,
      currency: price.currency,
    })),

    // Only features the system can actually enforce are advertised. A capability that
    // exists in the catalogue but has no screen a customer can reach yet is left out,
    // because listing it would be selling something that cannot be bought and used.
    features: plan.features
      .filter(grant => grant.feature.available)
      .map(grant => ({
        key: grant.feature.key,
        name: grant.feature.name,
        description: grant.feature.description,
        category: grant.feature.category,
      })),

    limits: plan.limits.map(limit => ({
      key: limit.key,
      // null rather than -1 across the wire: "unlimited" is a different thing from a
      // negative allowance, and a client rendering the raw value would show "-1".
      value: limit.value === UNLIMITED ? null : limit.value,
      unlimited: limit.value === UNLIMITED,
      source: limit.source,
      unit: limit.unit,
      period: limit.period,
    })),
  }));
}

/**
 * Every plan a customer can buy, with the comparison matrix beside it.
 *
 * The matrix is the union of what all the plans hold, so the page draws one table from one
 * response instead of guessing which features exist and which plans include them. Adding a
 * feature to a plan makes it appear here with no matching change to the frontend, which is
 * the whole reason plans are rows.
 */
planRouter.get("/", async (req, res, next) => {
  try {
    const interval = typeof req.query.interval === "string" ? req.query.interval : "monthly";
    const plans = await buildCatalogue();

    const featureIndex = new Map<
      string,
      { key: string; name: string; description: string; category: string; plans: string[] }
    >();

    for (const plan of plans) {
      for (const feature of plan.features) {
        const entry = featureIndex.get(feature.key) ?? {
          key: feature.key,
          name: feature.name,
          description: feature.description,
          category: feature.category,
          plans: [],
        };
        entry.plans.push(plan.key);
        featureIndex.set(feature.key, entry);
      }
    }

    // Limits likewise. A limit only one plan sets is still a row, because that difference
    // is usually the reason somebody is comparing plans in the first place.
    const limitIndex = new Map<
      string,
      { key: string; unit: string; period: string; values: Record<string, number | null> }
    >();

    for (const plan of plans) {
      for (const limit of plan.limits) {
        const entry = limitIndex.get(limit.key) ?? {
          key: limit.key,
          unit: limit.unit,
          period: limit.period,
          values: {},
        };
        entry.values[plan.key] = limit.unlimited ? null : limit.value;
        limitIndex.set(limit.key, entry);
      }
    }

    res.json({
      data: {
        plans,
        interval,
        comparison: {
          features: [...featureIndex.values()].sort((a, b) => {
            // Core capabilities first, then alphabetical. The rows a Community customer
            // can already use should not be buried under the ones they cannot.
            const aCore = a.category === FEATURE_CATEGORIES.CORE;
            const bCore = b.category === FEATURE_CATEGORIES.CORE;
            if (aCore !== bCore) return aCore ? -1 : 1;
            return a.name.localeCompare(b.name);
          }),
          limits: [...limitIndex.values()],
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/** One plan by key, for a deep link from an error message. */
planRouter.get("/:key", async (req, res, next) => {
  try {
    const plan = await prisma.plan.findFirst({
      where: { key: req.params.key, status: "ACTIVE", visibility: "PUBLIC" },
      include: {
        prices: { where: { isActive: true } },
        features: { include: { feature: true } },
        limits: true,
      },
    });
    if (!plan) throw new AppError(404, "Plan not found");
    res.json({
      data: {
        key: plan.key,
        name: plan.name,
        description: plan.description,
        highlight: plan.highlight,
        isFree: plan.isFree,
        trialDays: plan.trialDays,
        prices: plan.prices,
        features: plan.features
          .filter(g => g.feature.available)
          .map(g => ({
            key: g.feature.key,
            name: g.feature.name,
            description: g.feature.description,
          })),
        limits: plan.limits.map(l => ({
          key: l.key,
          value: l.value === UNLIMITED ? null : l.value,
          unlimited: l.value === UNLIMITED,
          unit: l.unit,
          period: l.period,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});
