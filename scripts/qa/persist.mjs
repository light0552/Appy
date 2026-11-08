import puppeteer from "puppeteer-core";
import { rmSync } from "node:fs";

/**
 * Persistent-unlock regression test.
 *
 * Proves the device-token behaviour:
 *   1. unlocking a screen stores a device token;
 *   2. closing the browser and reopening with the SAME browser profile lands
 *      straight on Home without asking for the passcode;
 *   3. clearing site data removes the token and asks again;
 *   4. "Sign out" revokes the token server-side, and reopening asks again.
 *
 * Requires the local Netlify Dev server (functions + Blobs), default
 * http://localhost:8888. It uses a throwaway Chrome user-data-dir so it never
 * touches your real browser session.
 */

const BASE = process.env.QA_BASE || "http://localhost:8888";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = "C:\\Users\\LIGHTHOOK\\AppData\\Local\\Temp\\opencode\\lighthook-device-test";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

rmSync(PROFILE, { recursive: true, force: true });

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    userDataDir: PROFILE,
    args: ["--no-sandbox"],
    defaultViewport: { width: 1440, height: 950 },
  });
  const page = await browser.newPage();
  return { browser, page };
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

try {
  /* 1 — first launch: unlock Sam, creating the token */
  {
    const { browser, page } = await launch();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".profiles-page", { timeout: 30000 });
    await dismissNotice(page);
    await tapSam(page);
    await page.waitForSelector(".sheet", { timeout: 15000 });
    await typeInto(page, 'input[aria-label="Password for Sam"]', "1234");
    await page.keyboard.press("Enter");
    await waitHome(page);
    const token = await page.evaluate(() => localStorage.getItem("lighthook:device:sam"));
    check("Unlock stores a device token", Boolean(token && token.length > 20));
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

    /* 3 — clearing site data removes the token */
    const cdp = await page.createCDPSession();
    try {
      await cdp.send("Storage.clearDataForOrigin", {
        origin: new URL(BASE).origin,
        storageTypes: "all",
      });
    } finally {
      await cdp.detach().catch(() => {});
    }
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* ignore */
      }
    });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".profiles-page", { timeout: 25000 });
    await dismissNotice(page);
    await tapSam(page);
    await page.waitForSelector(".sheet", { timeout: 15000 });
    check(
      "Clearing cache asks for the passcode again",
      Boolean(await page.$('input[aria-label="Password for Sam"]')),
    );

    /* 4 — sign out revokes the token */
    await typeInto(page, 'input[aria-label="Password for Sam"]', "1234");
    await page.keyboard.press("Enter");
    await waitHome(page);
    await page.goto(BASE + "/profiles", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".profiles-page", { timeout: 25000 });
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
      "Signing out revokes the remembered device",
      Boolean(await page.$('input[aria-label="Password for Sam"]')),
    );
    await browser.close();
  }

  await new Promise((r) => setTimeout(r, 1000));

  /* 5 — after sign-out, reopening stays on the picker */
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
}

rmSync(PROFILE, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} device checks passed.`);
process.exit(failed.length ? 1 : 0);
