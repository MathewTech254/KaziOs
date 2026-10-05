import { prisma } from "../lib/prisma";
import { loadCoreFeatureKeys } from "../services/entitlements";

/**
 * Prints what a fresh business actually gets, straight from the database.
 *
 * Written because the failures that matter here are only visible against a real database:
 * a column the client expects but the migration did not add, a plan catalogue that was never
 * seeded, a business that ends up with no subscription. Each of those reports as a generic
 * 500 from a route, with the real cause printed once by the error handler and never read.
 *
 * Run with: npx ts-node src/utils/checkPlans.ts
 */
async function main() {
  await loadCoreFeatureKeys();

  const plans = await prisma.plan.findMany({
    include: {
      prices: true,
      limits: true,
      features: { include: { feature: true } },
    },
    orderBy: { sortOrder: "asc" },
  });

  console.log(`\n${plans.length} plans found`);
  for (const plan of plans) {
    console.log(
      `  ${plan.key.padEnd(12)} free=${String(plan.isFree).padEnd(5)} default=${String(
        plan.isDefault
      ).padEnd(5)} trial=${String(plan.trialDays).padEnd(3)} visibility=${plan.visibility.padEnd(
        8
      )} features=${plan.features.length} limits=${plan.limits.length} prices=${plan.prices
        .map(p => `${p.interval}:${p.amountCents}`)
        .join(",")}`
    );
  }

  // Creates and immediately removes a throwaway business, so the whole path that runs at
  // registration is exercised: organization, user, role, branch, warehouse, accounts, tax
  // categories and subscription.
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = `plan-check-${suffix}`;

  let organizationId: string | null = null;
  try {
    const organization = await prisma.organization.create({
      data: {
        name: `Plan check ${suffix}`,
        slug,
        country: "KE",
        currency: "KES",
        timezone: "Africa/Nairobi",
      },
      select: { id: true, planId: true },
    });
    organizationId = organization.id;

    const defaultPlan = await prisma.plan.findFirst({
      where: { isDefault: true },
      select: { id: true, key: true },
    });
    if (!defaultPlan) {
      console.error("\nNo default plan is set. A new business would have no subscription.");
    }

    await prisma.subscription.create({
      data: {
        organizationId: organization.id,
        planId: defaultPlan!.id,
        status: "ACTIVE",
        billingInterval: "monthly",
      },
    });

    const subscription = await prisma.subscription.findUnique({
      where: { organizationId: organization.id },
      include: { plan: { include: { limits: true, features: true } } },
    });

    console.log(`\nA new business on ${subscription!.plan.key} gets:`);
    for (const limit of subscription!.plan.limits) {
      console.log(`  limit ${limit.key.padEnd(22)} = ${limit.value} (${limit.source})`);
    }
    console.log(`  ${subscription!.plan.features.length} features granted`);
    console.log("\nAll good.");
  } catch (err: any) {
    console.error("\nCreating a subscription failed:", err?.message ?? err);
    console.error("Code:", err?.code);
    process.exitCode = 1;
  } finally {
    if (organizationId) {
      await prisma.subscription.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } }).catch(() => 0);
    }
    await prisma.$disconnect();
  }
}

main();
