// Captures the product screenshots embedded in docs/presentation/KaziOS-Presentation.pptx.
// Run the dev stack first (npm run dev:api + dev:web), then:
//
//   node apps/web/scripts/shoot-deck.mjs
//
// Signs in through the API and plants the token, exactly like check-overlay.mjs, so the
// shots do not depend on the login form's markup.

import { chromium } from "playwright-core";

const BASE = process.env.KAZIOS_WEB_URL || "http://localhost:3000";
const EMAIL = process.env.KAZIOS_SMOKE_EMAIL || "admin@kazios.dev";
const PASSWORD = process.env.KAZIOS_SMOKE_PASSWORD || "admin123";
const OUT = process.env.OUT_DIR || "C:\\Users\\ZBOOK\\AppData\\Local\\Temp\\kazi-deck\\assets";
const EDGE =
  process.env.CHROME_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

const settle = ms => page.waitForTimeout(ms);

async function snap(name) {
  await page.screenshot({ path: `${OUT}/shot-${name}.png` });
  console.log(`SHOT:${name}`);
}

async function visit(path) {
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 15000 });
  } catch {
    // Polling pages never reach networkidle; fall back to DOM readiness.
    await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 15000 });
  }
}

try {
  // Public landing page first, while signed out.
  await visit("/");
  await settle(4000); // hero video, fonts, entrance animations
  await snap("landing");

  // Sign in and plant the token the app expects.
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const token = await page.evaluate(
    async ({ base, email, password }) => {
      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json();
      return body?.data?.token ?? null;
    },
    { base: BASE, email: EMAIL, password: PASSWORD }
  );
  if (!token) throw new Error("could not sign in");
  await page.evaluate(value => localStorage.setItem("kazios_token", value), token);
  console.log("LOGIN:OK");

  const shots = [
    ["dashboard", "/dashboard", 2500],
    ["pos", "/pos", 3200],
    ["inventory", "/inventory", 2500],
    ["billing", "/settings?tab=billing", 4000],
  ];
  for (const [name, path, wait] of shots) {
    await visit(path);
    await settle(wait);
    if (name === "pos") {
      // The grid keeps its skeleton until the products fetch lands; a fixed wait
      // caught it mid-load and the deck ended up with a blank catalogue.
      await page
        .locator("text=Loading products")
        .first()
        .waitFor({ state: "detached", timeout: 15000 })
        .catch(() => {});
      await settle(800);

      // Main Warehouse in the seed data is nearly empty, so the first frame was a
      // wall of greyed OUT OF STOCK tiles. Probe every branch × warehouse combo
      // and keep the one with the most in-stock products for the deck.
      const branchSelect = page.locator("select").nth(0);
      const warehouseSelect = page.locator("select").nth(1);
      const enabledCount = () => page.locator("button.kazi-card:not([disabled])").count();
      const best = { b: 0, w: 0, count: -1 };
      const branchCount = await branchSelect
        .locator("option")
        .count()
        .catch(() => 0);
      for (let b = 0; b < branchCount; b++) {
        await branchSelect.selectOption({ index: b }).catch(() => {});
        await settle(700); // handleBranchChange resets the warehouse selection
        const warehouseCount = await warehouseSelect
          .locator("option")
          .count()
          .catch(() => 0);
        for (let w = 0; w < warehouseCount; w++) {
          await warehouseSelect.selectOption({ index: w }).catch(() => {});
          await settle(800);
          const count = await enabledCount();
          if (count > best.count) {
            best.b = b;
            best.w = w;
            best.count = count;
          }
        }
      }
      if (best.count >= 0) {
        await branchSelect.selectOption({ index: best.b }).catch(() => {});
        await settle(700);
        await warehouseSelect.selectOption({ index: best.w }).catch(() => {});
        await settle(900);
      }

      // Add one in-stock product so the cart shows a live line, not an empty state.
      await page
        .locator("button.kazi-card:not([disabled])")
        .first()
        .click({ timeout: 5000 })
        .catch(() => {});
      await settle(500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(300);
    }
    if (name === "billing") {
      // The Card/M-PESA rail toggle lives in the plan checkout card, below the
      // fold of a 900px viewport. Anchor CHANGE PLAN 150px below the top: above it
      // the usage meters read over-limit in red (the seed org has more branches
      // than the free plan allows) and that must never reach the deck. The app may
      // scroll the window or its own container, so measure and adjust each.
      await page
        .evaluate(() => {
          // The label is rendered with CSS uppercase, so match case-insensitively.
          const matches = [...document.querySelectorAll("*")].filter(
            el => el.textContent.trim().toUpperCase() === "CHANGE PLAN"
          );
          const heading =
            matches.find(
              el =>
                ![...el.children].some(c => c.textContent.trim().toUpperCase() === "CHANGE PLAN")
            ) ?? matches[0];
          if (!heading) return "NO-HEADING";
          heading.scrollIntoView({ block: "start", behavior: "instant" });
          window.scrollBy({ top: heading.getBoundingClientRect().top - 150, behavior: "instant" });
          const rest = heading.getBoundingClientRect().top - 150;
          let node = heading.parentElement;
          let scrolled = "window";
          while (node) {
            const cs = getComputedStyle(node);
            if (node.scrollHeight > node.clientHeight + 50 && /(auto|scroll)/.test(cs.overflowY)) {
              node.scrollTop += rest;
              scrolled = `container:${node.tagName}.${node.className}`;
              break;
            }
            node = node.parentElement;
          }
          return `${heading.tagName} top=${Math.round(heading.getBoundingClientRect().top)} via ${scrolled}`;
        })
        .then(info => console.log(`BILLING-SCROLL: ${info}`))
        .catch(err => console.log(`BILLING-SCROLL-ERR: ${err.message}`));
      const toggle = page.getByRole("button", { name: "M-PESA" }).first();
      await toggle.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      await settle(800);
    }
    await snap(name);
  }
  console.log("DONE");
} finally {
  await browser.close();
}
