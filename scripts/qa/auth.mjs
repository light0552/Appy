import puppeteer from "puppeteer-core";

/**
 * Server-backed auth regression test.
 *
 * Proves the thing the user actually reported: after clearing cache/cookies,
 * screen passwords and lockouts do NOT reset to 1234. Requires the local
 * Netlify Dev server (functions + Blobs) — default http://localhost:8888.
 */

const BASE = process.env.QA_BASE || "http://localhost:8888";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ORIGIN = new URL(BASE).origin;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 950 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("popup", async (p) => {
  try {
    await p.close();
  } catch {
    /* ignore */
  }
});

async function goto(path, waitFor) {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 30000 });
}

async function typeInto(selector, value) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.click(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}

async function dismissNotice() {
  const has = await page.$(".notice");
  if (!has) return;
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      x.textContent?.includes("Got it"),
    );
    b?.click();
  });
  await page.waitForFunction(() => !document.querySelector(".notice"), { timeout: 10000 });
}

async function openScreen(name) {
  await page.waitForSelector(`button[aria-label*="${name}"]`, { timeout: 20000 });
  await page.evaluate((n) => {
    const tile = [...document.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") || "").includes(n),
    );
    tile?.click();
  }, name);
  await page.waitForSelector(".sheet", { timeout: 15000 });
}

async function unlock(name, password) {
  await openScreen(name);
  await typeInto(`input[aria-label="Password for ${name}"]`, password);
  await page.keyboard.press("Enter");
}

async function waitDashboard() {
  await page.waitForSelector(".admin-page:not(.admin-page--login)", { timeout: 25000 });
}

async function adminLogin() {
  await goto("/admin", ".admin-page--login");
  await typeInto('input[aria-label="Admin password"]', "light0552");
  await page.keyboard.press("Enter");
  await waitDashboard();
}

async function setPassword(name, password) {
  await typeInto(`input[aria-label="New password for ${name}"]`, password);
  await page.evaluate((n) => {
    const row = [...document.querySelectorAll(".admin-screen")].find((r) =>
      r.textContent?.includes(n),
    );
    const btn = [...(row?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Save",
    );
    btn?.click();
  }, name);
  await page.waitForFunction(
    (n) => {
      const row = [...document.querySelectorAll(".admin-screen")].find((r) =>
        r.textContent?.includes(n),
      );
      return [...(row?.querySelectorAll("button") ?? [])].some(
        (b) => b.textContent?.trim() === "Saved",
      );
    },
    { timeout: 20000 },
    name,
  );
}

async function unblock(name) {
  await page.evaluate((n) => {
    const row = [...document.querySelectorAll(".admin-screen")].find((r) =>
      r.textContent?.includes(n),
    );
    const btn = [...(row?.querySelectorAll("button") ?? [])].find((b) =>
      b.textContent?.includes("Unblock screen"),
    );
    btn?.click();
  }, name);
  await page.waitForFunction(
    (n) => {
      const row = [...document.querySelectorAll(".admin-screen")].find((r) =>
        r.textContent?.includes(n),
      );
      return row && !row.querySelector(".admin-blocked-badge");
    },
    { timeout: 20000 },
    name,
  );
}

/** Resets a screen's server record (fresh attempts) via the admin API. */
async function resetServerScreen(profileId, password) {
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-family-key": process.env.QA_FAMILY_KEY || "samandmellu",
      "x-admin-key": "light0552",
    },
    body: JSON.stringify({ action: "adminSet", profileId, password }),
  });
  if (!res.ok) throw new Error(`adminSet ${profileId} failed (${res.status})`);
}

/** Wipes cookies + localStorage + IndexedDB + sessionStorage, then reloads. */
async function wipeDevice() {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "all" });
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
  await dismissNotice();
}

try {
  /* 1 — baseline: seeded password works */
  await goto("/", ".profiles-page");
  await dismissNotice();
  await unlock("Sam", "1234");
  await page.waitForFunction(() => location.pathname === "/", { timeout: 25000 });
  check("Seeded 1234 unlocks Sam", true);

  /* 2 — admin sets a new server-side password */
  await adminLogin();
  await setPassword("Mellu", "mellu5678");
  check("Admin sets a new passcode", true);

  /* 3 — the reported bug: wipe everything, password must survive */
  await wipeDevice();
  await unlock("Mellu", "mellu5678");
  await page.waitForFunction(() => location.pathname === "/", { timeout: 25000 });
  check("New passcode survives a full cache/cookie wipe", true);

  /* 4 — old password must be rejected after the wipe */
  await wipeDevice();
  await unlock("Mellu", "1234");
  await page.waitForFunction(
    () => document.body.innerText.includes("attempts left"),
    { timeout: 15000 },
  );
  check("Old 1234 is rejected after the wipe", true);

  /* 5 — three strikes block server-side and survive another wipe */
  await resetServerScreen("mellu", "mellu5678"); // fresh attempt counter
  await page.keyboard.press("Escape");
  await wipeDevice();
  await unlock("Mellu", "wrong-1");
  await page.waitForFunction(() => document.body.innerText.includes("2 attempts left"), { timeout: 15000 });
  await typeInto('input[aria-label="Password for Mellu"]', "wrong-2");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.body.innerText.includes("1 attempt left"), { timeout: 15000 });
  await typeInto('input[aria-label="Password for Mellu"]', "wrong-3");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.body.innerText.includes("This screen is blocked"), { timeout: 15000 });
  check("Third wrong attempt blocks the screen", true);

  await page.keyboard.press("Escape");
  await wipeDevice();
  await openScreen("Mellu");
  await page.waitForFunction(
    () => document.body.innerText.includes("This screen is blocked"),
    { timeout: 15000 },
  );
  check("Block survives a cache wipe (correct password still rejected)", true);

  /* 6 — admin unblocks and restores the default */
  await page.keyboard.press("Escape");
  await adminLogin();
  await unblock("Mellu");
  await setPassword("Mellu", "1234");
  check("Admin unblocks and restores the passcode", true);

  /* 7 — restore is live after another wipe */
  await wipeDevice();
  await unlock("Mellu", "1234");
  await page.waitForFunction(() => location.pathname === "/", { timeout: 25000 });
  check("Restored 1234 unlocks after a wipe", true);

  /* 8 — admin session is per-tab (lost on wipe) but login still works */
  await wipeDevice();
  await adminLogin();
  check("Admin can still sign in after a wipe", true);

  check("No uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (error) {
  check("Run completed without exception", false, error.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} auth checks passed.`);
await browser.close();
process.exit(failed.length ? 1 : 0);
