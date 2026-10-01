// Measures whether the notification dropdown is actually painted on top of the
// sidebar, using the real DOM in a real browser. Run the dev stack first:
//
//   node apps/web/scripts/check-overlay.mjs
//
// This exists because the bug it guards against is invisible to a typecheck: a
// dropdown can be correct in every way and still be painted underneath a sibling.

import { chromium } from "playwright-core";

const BASE = process.env.KAZIOS_WEB_URL || "http://localhost:3000";
const EMAIL = process.env.KAZIOS_SMOKE_EMAIL || "admin@kazios.dev";
const PASSWORD = process.env.KAZIOS_SMOKE_PASSWORD || "admin123";

const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}   ${detail}`);
  }
}

try {
  // Navigate before signing in: a fetch issued from about:blank has no origin and is
  // refused, so the login has to happen once the page is on the site's own origin.
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Sign in through the API, then plant the token the app expects, so the test does
  // not depend on the login form's markup.
  const token = await page.evaluate(async ({ base, email, password }) => {
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    return body?.data?.token ?? null;
  }, { base: BASE, email: EMAIL, password: PASSWORD });

  if (!token) throw new Error("could not sign in");
  await page.evaluate((value) => localStorage.setItem("kazios_token", value), token);
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });

  // Open the bell.
  const bell = page.getByRole("button", { name: /Notifications/i }).first();
  await bell.click();
  const menu = page.locator('[role="menu"][aria-label="Notifications"]');
  await menu.waitFor({ state: "visible", timeout: 5000 });
  check("the notification menu opens", true);

  // The real question: at the point where the dropdown overlaps the sidebar, which
  // element is actually on top? A hit test answers it the way a user experiences it.
  const result = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"][aria-label="Notifications"]');
    const sidebar = document.querySelector("aside");
    const header = document.querySelector("header");

    const m = menu.getBoundingClientRect();
    const s = sidebar.getBoundingClientRect();

    // Find the point of genuine overlap between the two boxes.
    const left = Math.max(m.left, s.left);
    const right = Math.min(m.right, s.right);
    const top = Math.max(m.top, s.top);
    const bottom = Math.min(m.bottom, s.bottom);
    const overlaps = right > left && bottom > top;

    let topElement = null;
    let insideMenu = false;
    if (overlaps) {
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      topElement = hit ? `${hit.tagName.toLowerCase()}${hit.className ? "." + String(hit.className).split(" ")[0] : ""}` : "none";
      // The decisive question is not what the element is called, but whether the point
      // the user can see lands inside the menu or inside the thing covering it.
      insideMenu = Boolean(hit && menu.contains(hit));
    }

    const z = (el) => (el ? getComputedStyle(el).zIndex : "n/a");
    const pos = (el) => (el ? getComputedStyle(el).position : "n/a");

    return {
      overlaps,
      topElement,
      insideMenu,
      menuRect: { left: m.left, right: m.right, top: m.top, bottom: m.bottom },
      sidebarRect: { left: s.left, right: s.right, top: s.top, bottom: s.bottom },
      menuZ: z(menu),
      headerZ: z(header),
      headerPos: pos(header),
      sidebarZ: z(sidebar),
      sidebarPos: pos(sidebar),
    };
  });

  console.log(`\n  menu      pos=${result.menuZ} rect=${JSON.stringify(result.menuRect)}`);
  console.log(`  header    ${result.headerPos} z=${result.headerZ}`);
  console.log(`  sidebar   ${result.sidebarPos} z=${result.sidebarZ}`);
  console.log(`  overlaps sidebar: ${result.overlaps}\n`);

  if (result.overlaps) {
    check(
      "the dropdown is painted above the sidebar where they overlap",
      result.insideMenu,
      `the sidebar covers it (topmost at the overlap point = ${result.topElement})`
    );
  } else {
    console.log("  SKIP  the two boxes do not overlap at this viewport width");
  }

  // The layering has to be deliberate, not accidentally correct. When both sat on the
  // same z-index the menu still looked fine, because the sidebar comes first in the
  // markup and a tie is resolved by document order. That is luck: reorder the tree or
  // wrap the sidebar and identical code starts hiding the menu again. Asserting the
  // top bar is strictly above the sidebar is what makes the rule enforceable.
  check(
    "the top bar is layered strictly above the sidebar",
    Number(result.headerZ) > Number(result.sidebarZ),
    `header z=${result.headerZ}, sidebar z=${result.sidebarZ} - a tie relies on DOM order`
  );

  // Source comments can leak into the page. A `//` comment placed inside a JSX return
  // is not a comment at all: the compiler treats it as a text node and renders it on
  // screen, so the source of the layout appears in the sidebar. Nothing about a
  // typecheck or a visual glance reliably catches it, so it is asserted here.
  const leaked = await page.evaluate(() => {
    const chrome = document.querySelector("aside")?.parentElement;
    if (!chrome) return [];
    const found = [];
    const walker = document.createTreeWalker(chrome, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.textContent || "").trim();
      // Comment syntax in visible text is the signature of the mistake.
      if (/^\/\//.test(text) || /^\/\*/.test(text)) {
        found.push(text.slice(0, 60));
      }
    }
    return found;
  });
  check(
    "no source comments are rendered into the page",
    leaked.length === 0,
    `rendered: ${leaked.slice(0, 2).join(" | ")}`
  );

  // The dropdown must also never be clipped by an ancestor, or it is unusable even
  // when nothing overlaps it.
  const clipped = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"][aria-label="Notifications"]');
    let el = menu.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX) ||
          ["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) {
        return `${el.tagName.toLowerCase()} overflow=${style.overflow}`;
      }
      el = el.parentElement;
    }
    return null;
  });
  check("the dropdown is not clipped by an ancestor", clipped === null, `clipped by ${clipped}`);
} catch (err) {
  failures++;
  console.log(`  FAIL  the check could not run: ${err.message}`);
} finally {
  await browser.close();
}

console.log(`\n  ${failures === 0 ? "all overlay checks passed" : `${failures} overlay check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);