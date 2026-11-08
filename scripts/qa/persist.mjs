import puppeteer from "puppeteer-core";
import { rmSync } from "node:fs";

/**
 * Persistent-unlock regression test.
 *
 * Proves the HttpOnly-cookie session behaviour:
 *   1. unlocking a screen sets an HttpOnly session cookie (no JS token);
 *   2. closing the browser and reopening with the SAME profile lands on Home
 *      without asking for the passcode;
 *   3. clearing only the HTTP cache does not log out;
 *   4. clearing cookies does;
 *   5. "Sign out" clears the cookie and the picker asks again.
 *
 * Requires the local Netlify Dev server (functions + Blobs), default
 * http://localhost:8888. Uses a throwaway Chrome user-data-dir.
 */

const BASE = process.env.QA_BASE || "http://localhost:8888";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = "C:\\Users\\LIGHTHOOK\\AppData\\Local\\Temp\\opencode\\lighthook-device-test";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

let activeBrowser = null;

try {
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
} catch {
  /* a previous run may still be releasing the profile; continue with it */
}

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    userDataDir: PROFILE,
    args: ["--no-sandbox"],
    defaultViewport: { width: 1440, height: 950 },
  });
  activeBrowser = browser;
  return { browser, page: await browser.newPage() };
}

async function typeInto(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.click(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}

async function dismissNotice(page) {
  if (!(await page.$(".notice"))) return;
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      x.textContent?.includes("Got it"),
    );
    b?.click();
  });
  await page.waitForFunction(() => !document.querySelector(".notice"), { timeout: 10000 });
}

async function tapSam(page) {
  await page.evaluate(() => {
    const tile = [...document.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") || "").includes("Sam"),
    );
    tile?.click();
  });
}

async function waitHome(page) {
  await page.waitForFunction(
    () => location.pathname === "/" && Boolean(document.querySelector(".home")),
    { timeout: 30000 },
  );
}

async function clearCache(page) {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Network.clearBrowserCache");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function clearCookies(page) {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Network.clearBrowserCookies");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

try {
  /* 1 — first launch: unlock Sam, creating the cookie */
  {
    const { browser, page } = await launch();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".profiles-page", { timeout: 30000 });
    await dismissNotice(page);
    const build = await page.$eval(".profiles-build", (el) => el.textContent?.trim() ?? "");
    check("Build tag is visible", /^build \w+/.test(build), build);
    await tapSam(page);
    await page.waitForSelector(".sheet", { timeout: 15000 });
    await typeInto(page, 'input[aria-label="Password for Sam"]', "1234");
    await page.keyboard.press("Enter");
    await waitHome(page);

    const cookies = await page.cookies();
    const session = cookies.find((c) => c.name === "lighthook_session");
    check(
      "Unlock sets an HttpOnly session cookie",
      Boolean(session?.httpOnly) && session?.value.length > 20,
      session ? `httpOnly=${session.httpOnly} secure=${session.secure}` : "missing",
    );
    check("Session cookie is long-lived", Boolean(session) && session.expires > Date.now() / 1000 + 365 * 24 * 3600);
    const jsToken = await page.evaluate(() =>
      Object.keys(localStorage).find((k) => k.startsWith("lighthook:device:")),
    );
    check("No JS-readable token is stored", !jsToken, jsToken ?? "none");
    await browser.close();
  }

  await new Promise((r) => setTimeout(r, 1200));

  /* 2 — same Chrome profile, browser restarted */
  {
    const { browser, page } = await launch();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitHome(page).catch(() => {});
    check(
      "Closing and reopening skips the passcode",
      Boolean(await page.$(".home")) && !(await page.$(".sheet")),
    );

    /* 3 — clearing only the HTTP cache must not log out */
    await clearCache(page);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".home, .profiles-page", { timeout: 30000 });
    check("Clearing cache does not log out", Boolean(await page.$(".home")));

    /* 4 — clearing cookies must log out */
    await clearCookies(page);
    // Clearing cookies does not clear this tab's sessionStorage unlock, which
    // is correct. A browser restart / new tab does, so model that.
    await page.evaluate(() => {
      try {
        sessionStorage.clear();
      } catch {
        /* ignore */
      }
    });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".profiles-page", { timeout: 30000 });
    await dismissNotice(page);
    await tapSam(page);
    await page.waitForSelector(".sheet", { timeout: 15000 });
    check(
      "Clearing cookies asks for the passcode again",
      Boolean(await page.$('input[aria-label="Password for Sam"]')),
    );

    /* 5 — sign out revokes the cookie session */
    await typeInto(page, 'input[aria-label="Password for Sam"]', "1234");
    await page.keyboard.press("Enter");
    await waitHome(page);
    await page.goto(BASE + "/profiles", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".profiles-page", { timeout: 25000 });
    const remembered = await page.$(".profiles-remembered");
    check("Profiles shows the remembered-device hint", Boolean(remembered));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) =>
        (x.textContent || "").includes("Sign out of Sam"),
      );
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    await tapSam(page);
    await page.waitForSelector(".sheet", { timeout: 15000 });
    check(
      "Signing out ends the remembered session",
      Boolean(await page.$('input[aria-label="Password for Sam"]')),
    );
    await browser.close();
  }

  await new Promise((r) => setTimeout(r, 1000));

  /* 6 — after sign-out, reopening stays on the picker */
  {
    const { browser, page } = await launch();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".profiles-page, .home", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1200));
    check(
      "After sign-out, reopening lands on the picker",
      Boolean(await page.$(".profiles-page")) && !(await page.$(".home")),
    );
    await browser.close();
  }
} catch (error) {
  check("Run completed without exception", false, error.message);
} finally {
  if (activeBrowser) {
    try {
      await activeBrowser.close();
    } catch {
      /* ignore */
    }
    activeBrowser = null;
  }
}

try {
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
} catch {
  /* Chrome can hold the profile briefly; it lives in temp either way */
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} device checks passed.`);
process.exit(failed.length ? 1 : 0);
