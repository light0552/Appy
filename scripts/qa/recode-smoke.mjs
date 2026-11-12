#!/usr/bin/env node
/**
 * RECODE smoke suite — full-stack local preview.
 *
 * Drives the running `netlify dev` server (default http://localhost:8888),
 * logs in through the real profiles API, walks every route at desktop and
 * phone sizes, checks the new design tokens, and captures screenshots.
 *
 *   node scripts/qa/recode-smoke.mjs
 *   BASE=http://localhost:5173 node scripts/qa/recode-smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE = (process.env.BASE || "http://localhost:8888").replace(/\/+$/, "");
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = path.join("E:\\OPENCODE\\RECODE", ".screens", "smoke");
const PASSWORD = process.env.SCREEN_PASSWORD || "1234";

fs.mkdirSync(OUT, { recursive: true });

const envText = fs.readFileSync(path.join("E:\\OPENCODE\\RECODE", ".env"), "utf8");
const adminPassword =
  process.env.ADMIN_PASSWORD ||
  (envText.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1]?.trim() ||
  "";

const results = [];
const errors = [];
const failedResponses = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 950, deviceScaleFactor: 1 },
});
const page = await browser.newPage();

page.on("pageerror", (err) => errors.push(err.message));
page.on("response", (res) => {
  const url = new URL(res.url());
  if (url.origin !== new URL(BASE).origin) return;
  if (res.status() < 400) return;
  if (/^\/(?:api|\.netlify)(?:[/?]|$)/.test(url.pathname)) return;
  failedResponses.push(`${res.status()} ${url.pathname}`);
});

async function shot(name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function goto(route, selector) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2", timeout: 60000 });
  if (selector) await page.waitForSelector(selector, { timeout: 30000 });
  await delay(1200);
}

async function body() {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
}

try {
  // Design tokens ------------------------------------------------------
  await goto("/profiles", ".profiles-page");
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const title = document.querySelector(".profiles-title");
    return {
      bg: cs.getPropertyValue("--bg").trim(),
      accent: cs.getPropertyValue("--accent").trim(),
      bodyFont: body.fontFamily,
      titleFont: title ? getComputedStyle(title).fontFamily : "",
      titleSize: title ? getComputedStyle(title).fontSize : "",
      theme: document.documentElement.dataset.theme || "",
    };
  });
  check("Warm token set is active", tokens.bg === "#0a0806" && tokens.accent === "#e9a05a", JSON.stringify(tokens));
  check("Bricolage drives the display type", /Bricolage/i.test(tokens.titleFont), tokens.titleFont);
  check("Cat seal is rendered", Boolean(await page.$(".profiles-seal img")), ".profiles-seal img");
  check("Profiles heading copy is intact", (await body()).includes("Who's watching?"));
  check("House notice offers the private app", (await body()).includes("LIGHTH00K app") && (await body()).includes("Android only · request access from admin"));

  if (await page.$(".notice")) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("Got it"));
      b?.click();
    });
    await delay(500);
  }
  await shot("profiles-desktop");

  // Login through the live local API ----------------------------------
  const tile = await page.$('button[aria-label="Unlock Sam with a password"]');
  check("Profiles picker offers Sam", Boolean(tile));
  if (tile) {
    await tile.click();
    await page.waitForSelector('input[aria-label="Password for Sam"]', { timeout: 10000 });
    await page.type('input[aria-label="Password for Sam"]', PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.pathname === "/", { timeout: 30000 });
    await page.waitForSelector(".home", { timeout: 30000 });
    check("Passcode unlock lands on home", true);
  }

  await delay(3500);
  await shot("home-desktop");
  const homeText = await body();
  check("Home greeting + nav render", /Good (morning|afternoon|evening), Sam/.test(homeText) && homeText.includes("Search"));
  check("Home hero renders", Boolean(await page.$(".hero-title")), await page.$eval(".hero-title", (el) => el.textContent || ""));
  check("Home shelves render", (await page.$$(".row .poster-card")).length >= 10);
  check("Tab bar is present", Boolean(await page.$(".tab-bar")));

  await goto("/search", ".search-page");
  await shot("search-desktop");
  check("Search page + field", Boolean(await page.$(".search-field input")));
  await page.type(".search-field input", "Dune");
  await delay(4000);
  check("Search returns results", (await page.$$(".search-results .poster-card")).length > 0);
  await shot("search-results-desktop");

  await goto("/library", ".library-page");
  await shot("library-desktop");
  check("Library page + tabs", Boolean(await page.$(".library-tabs")));

  await goto("/browse/trending", ".browse-page");
  await shot("browse-desktop");
  check("Browse grid renders", (await page.$$(".browse-grid .poster-card")).length > 0);

  await goto("/title/movie/550", ".title-page");
  await shot("title-desktop");
  check("Title displays Fight Club", (await body()).includes("Fight Club"));
  check("Title Play control exists", Boolean(await page.$(".title-actions .btn-primary")));

  await goto("/watch/tv/1399?s=1&e=1", ".watch-bar");
  await delay(3000);
  await shot("watch-desktop");
  check("Watch deck renders", Boolean(await page.$(".watch-stage")));
  check("Watch has reload + transport", Boolean(await page.$('[aria-label="Reload stream"]')));

  await goto("/admin", ".admin-page");
  await shot("admin-login-desktop");
  check("Admin gate renders", (await body()).includes("Control room"));
  if (adminPassword) {
    await page.type("#admin-password", adminPassword);
    await page.keyboard.press("Enter");
    const dashboard = await page
      .waitForSelector(".admin-page--dash", { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("Admin login succeeds", dashboard);
    await page.waitForSelector(".admin-screen-list", { timeout: 15000 }).catch(() => {});
    await delay(800);
    await shot("admin-dash-desktop");
    check(
      "Admin has three screen looks",
      (await page.$$(".admin-look-grid .admin-look-option")).length === 3,
    );
  }

  // Phone pass ---------------------------------------------------------
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await goto("/profiles", ".profiles-page");
  await shot("profiles-mobile");
  check("Mobile profiles title fits", await page.evaluate(() => {
    const el = document.querySelector(".profiles-title");
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width <= window.innerWidth && r.height < 200;
  }));
  await goto("/", ".home");
  await delay(1500);
  await shot("home-mobile");

  // HTTP guards --------------------------------------------------------
  const httpChecks = await page.evaluate(async (files) => {
    const out = [];
    for (const file of files) {
      try {
        const res = await fetch(file, { cache: "no-store" });
        out.push({ file, status: res.status });
      } catch {
        out.push({ file, status: 0 });
      }
    }
    const manifest = await (await fetch("/manifest.webmanifest", { cache: "no-store" })).json();
    return { out, manifest };
  }, ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/favicon.svg", "/fonts/bricolage-latin.woff2"]);
  for (const entry of httpChecks.out) {
    check(`HTTP ${entry.file}`, entry.status === 200, `${entry.status}`);
  }
  const manifest = httpChecks.manifest;
  check("Manifest is branded", manifest.name === "LIGHTH00K" && manifest.theme_color === "#0a0806");

  check("No uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  check("No same-origin 404s", failedResponses.length === 0, failedResponses.slice(0, 5).join(" | "));
} catch (err) {
  check("Smoke run completed", false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Shots: ${OUT}`);
if (failed.length) {
  console.log("Failures:");
  for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
