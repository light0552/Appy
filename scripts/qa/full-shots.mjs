import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://localhost:8888";
const OUT = "E:\\OPENCODE\\RECODE\\.screens";
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 950, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(`${BASE}/profiles`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector(".profiles-page", { timeout: 30000 });
await delay(800);
if (await page.$(".notice")) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("Got it"));
    b?.click();
  });
  await delay(500);
}
const tile = await page.$('button[aria-label="Unlock Sam with a password"]');
if (tile) {
  await tile.click();
  await page.waitForSelector('input[aria-label="Password for Sam"]', { timeout: 10000 });
  await page.type('input[aria-label="Password for Sam"]', "1234");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.pathname === "/", { timeout: 30000 });
}

for (const [name, route, sel, full] of [
  ["home-full", "/", ".home", true],
  ["profiles-full", "/profiles", ".profiles-page", true],
  ["search-full", "/search", ".search-page", true],
  ["library-full", "/library", ".library-page", true],
  ["browse-full", "/browse/trending", ".browse-page", true],
  ["title-full", "/title/movie/550", ".title-page", true],
]) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
  await page.waitForSelector(sel, { timeout: 30000 }).catch(() => {});
  await delay(2500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
  console.log("shot", name);
}

await browser.close();
