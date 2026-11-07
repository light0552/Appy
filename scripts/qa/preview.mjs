#!/usr/bin/env node
/**
 * Lighthook production-preview QA.
 *
 * Verifies the *built* app, not the dev server:
 *
 *   1. `dist/` contains index.html, sw.js, manifest.webmanifest and the hashed
 *      bundle assets produced by `npm run build`.
 *   2. `vite preview` (default port 4173, strict) is spawned as a child
 *      process, waited on, and killed in a finally block.
 *   3. Headless Chrome drives the preview exactly like a browser would:
 *      profiles picker, manifest, service worker, SPA deep links, unlock,
 *      home hero/shelves, title page, watch page, admin gate/dashboard.
 *   4. Screenshots are captured at 1440x950 and 390x844 under
 *      %TEMP%\opencode\lighthook-preview\ (never committed).
 *
 * Usage (from anywhere; puppeteer-core resolves from the Appy package):
 *
 *   node scripts/qa/preview.mjs
 *   node scripts/qa/preview.mjs --headed --keep-profile
 *   node scripts/qa/preview.mjs --base=http://localhost:4173 --chrome="C:\path\chrome.exe"
 *
 * Exit codes:
 *   0  every check passed
 *   1  at least one FAIL
 *   2  no FAIL, but at least one SKIP (environment limitation, e.g. TMDB down)
 *   64 bad arguments / missing Chrome binary / preview failed to start
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_BASE = "http://localhost:4173";
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Keys / secrets the preview run relies on (see src/lib/auth.ts). */
const ADMIN_PASSWORD = "light0552";
const SCREEN_PASSWORD = "1234";

const TITLE_PATH = "/title/movie/550";
const WATCH_PATH = "/watch/tv/1399?s=1&e=1";

const SHOT_DIR = path.join(os.tmpdir(), "opencode", "lighthook-preview");
const VIEWPORTS = [
  { width: 1440, height: 950, isMobile: false, hasTouch: false },
  { width: 390, height: 844, isMobile: true, hasTouch: true },
];

function parseArgs(argv) {
  const config = { base: DEFAULT_BASE, chrome: DEFAULT_CHROME, headed: false, keepProfile: false };

  for (const arg of argv) {
    if (arg === "--headed") config.headed = true;
    else if (arg === "--keep-profile") config.keepProfile = true;
    else if (arg.startsWith("--base=")) config.base = arg.slice("--base=".length);
    else if (arg.startsWith("--chrome=")) config.chrome = arg.slice("--chrome=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Lighthook production-preview QA",
          "",
          "  node scripts/qa/preview.mjs [options]",
          "",
          "  --headed            show the browser window",
          "  --keep-profile      keep the temporary Chrome profile after the run",
          "  --base=<url>        preview origin (default http://localhost:4173)",
          "  --chrome=<path>     Chrome executable (default Program Files install)",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg} (try --help)`);
      process.exit(64);
    }
  }

  return config;
}

const CFG = parseArgs(process.argv.slice(2));
const BASE = CFG.base.replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;
const PREVIEW_PORT = new URL(BASE).port || "4173";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Result bookkeeping                                                  */
/* ------------------------------------------------------------------ */

const results = [];
const pageErrors = [];
const failedResponses = [];
let shotFiles = [];

class SkipError extends Error {}

const message = (err) => (err instanceof Error ? err.message : String(err));

function record(status, name, detail = "") {
  results.push({ status, name, detail });
  console.log(`${status}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const pass = (name, detail) => record("PASS", name, detail);
const skip = (name, detail) => record("SKIP", name, detail);
const fail = (name, detail) => record("FAIL", name, detail);

function assert(condition, text) {
  if (!condition) throw new Error(text);
}

/** Normalises whitespace and smart punctuation so copy checks are stable. */
const norm = (value) =>
  (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .trim();

const slug = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === "string" ? detail : undefined);
    return true;
  } catch (err) {
    if (err instanceof SkipError) {
      skip(name, err.message);
      return false;
    }
    fail(name, message(err));
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Preview child process                                               */
/* ------------------------------------------------------------------ */

/** @type {import("node:child_process").ChildProcess | null} */
let preview = null;
let previewLog = "";

function appendPreviewLog(chunk) {
  previewLog = `${previewLog}${chunk}`.slice(-4000);
}

function spawnPreview() {
  const args = ["/d", "/s", "/c", `npx vite preview --port ${PREVIEW_PORT} --strictPort`];

  preview = spawn(process.env.ComSpec || "cmd.exe", args, {
    cwd: APP_DIR,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  preview.stdout.on("data", (chunk) => appendPreviewLog(chunk.toString()));
  preview.stderr.on("data", (chunk) => appendPreviewLog(chunk.toString()));
  preview.on("error", (err) => appendPreviewLog(`spawn error: ${err.message}`));
}

async function waitForPreview(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error(
        `vite preview exited early (code ${preview.exitCode}).\n${previewLog.trim()}`,
      );
    }

    try {
      const res = await fetch(`${BASE}/`, {
        signal: AbortSignal.timeout(1500),
        redirect: "follow",
      });
      if (res.ok) {
        // The child can still die on the next tick if another process owns the
        // port; strictPort makes that explicit.
        await delay(300);
        if (preview.exitCode !== null) {
          throw new Error(
            `vite preview died after a successful probe (code ${preview.exitCode}).\n${previewLog.trim()}`,
          );
        }
        return;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("vite preview died")) throw err;
    }

    await delay(300);
  }

  throw new Error(`vite preview did not become ready within ${timeoutMs}ms.\n${previewLog.trim()}`);
}

async function stopPreview() {
  const child = preview;
  preview = null;
  if (!child || child.exitCode !== null) return;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", done);
      killer.on("error", done);
    } else {
      child.kill("SIGTERM");
      child.on("exit", done);
    }

    setTimeout(done, 5000);
  });
}

/* ------------------------------------------------------------------ */
/* Build artifacts                                                     */
/* ------------------------------------------------------------------ */

function buildArtifactChecks() {
  const dist = path.join(APP_DIR, "dist");
  const required = ["index.html", "sw.js", "manifest.webmanifest"];

  return Promise.all(
    required.map((file) =>
      check(`Production build contains ${file}`, async () => {
        const full = path.join(dist, file);
        assert(fs.existsSync(full), `${full} is missing (run npm run build)`);
        const size = fs.statSync(full).size;
        assert(size > 0, `${file} is empty`);
        return `${size} bytes`;
      }),
    ),
  );
}

async function checkHashedAssets() {
  return check("Production build contains hashed JS + CSS assets", async () => {
    const assetsDir = path.join(APP_DIR, "dist", "assets");
    assert(fs.existsSync(assetsDir), `dist/assets is missing (run npm run build)`);

    const files = fs.readdirSync(assetsDir);
    const js = files.filter((file) => /-[\w-]{8,}\.js$/.test(file));
    const css = files.filter((file) => /-[\w-]{8,}\.css$/.test(file));
    assert(js.length > 0, "no hashed .js asset found in dist/assets");
    assert(css.length > 0, "no hashed .css asset found in dist/assets");

    const html = fs.readFileSync(path.join(APP_DIR, "dist", "index.html"), "utf8");
    for (const file of [...js, ...css]) {
      assert(html.includes(`/assets/${file}`), `dist/index.html does not reference /assets/${file}`);
    }

    return `${js.length} JS + ${css.length} CSS`;
  });
}

/* ------------------------------------------------------------------ */
/* Browser helpers                                                     */
/* ------------------------------------------------------------------ */

/** @type {import("puppeteer-core").Browser | null} */
let browser = null;
/** @type {import("puppeteer-core").Page | null} */
let page = null;

async function settle(ms = 900) {
  await delay(ms);
}

async function fill(selector, value) {
  await page.waitForSelector(selector, { timeout: 15_000 });
  await page.click(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}

async function bodyText() {
  return page.evaluate(() => document.body.innerText);
}

async function hasText(text) {
  return norm(await bodyText()).includes(norm(text));
}

async function goto(pathname, waitFor) {
  const res = await page.goto(`${BASE}${pathname}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 30_000 });
  return res;
}

async function waitForAny(selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      if (await page.$(selector)) return selector;
    }
    await delay(200);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HTTP checks                                                         */
/* ------------------------------------------------------------------ */

async function httpChecks() {
  await check(`/ returns 200`, async () => {
    const res = await fetch(`${BASE}/`, { redirect: "follow" });
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.text();
    assert(body.includes('id="root"'), "response does not contain the app root");
    return `status 200, ${body.length} bytes`;
  });

  await check(`/manifest.webmanifest returns 200 and is valid JSON`, async () => {
    const res = await fetch(`${BASE}/manifest.webmanifest`);
    assert(res.status === 200, `status ${res.status}`);
    const text = await res.text();
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (err) {
      throw new Error(`invalid JSON: ${message(err)}`);
    }
    assert(manifest && typeof manifest === "object", "manifest is not an object");
    assert(manifest.name === "LIGHTH00K", `name is ${JSON.stringify(manifest.name)}`);
    assert(
      manifest.short_name === "LIGHTH00K",
      `short_name is ${JSON.stringify(manifest.short_name)}`,
    );
    assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, "manifest has no icons");
    assert(manifest.display === "standalone", `display is ${JSON.stringify(manifest.display)}`);
    return `name/short_name LIGHTH00K, ${manifest.icons.length} icons, display standalone`;
  });

  await check(`/sw.js returns 200 with a JavaScript content type`, async () => {
    const res = await fetch(`${BASE}/sw.js`);
    assert(res.status === 200, `status ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    assert(/javascript|ecmascript/i.test(type), `content-type is ${JSON.stringify(type)}`);
    const body = await res.text();
    assert(body.length > 0, "sw.js is empty");
    return `${type.split(";")[0]}, ${body.length} bytes`;
  });
}

/* ------------------------------------------------------------------ */
/* Browser checks                                                      */
/* ------------------------------------------------------------------ */

async function launchBrowser() {
  const profileDir = path.join(
    os.tmpdir(),
    "opencode",
    `lighthook-preview-chrome-${process.pid}-${Date.now()}`,
  );

  browser = await puppeteer.launch({
    executablePath: CFG.chrome,
    headless: CFG.headed ? false : "new",
    userDataDir: profileDir,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-features=Translate,MediaRouter",
      `--window-size=${VIEWPORTS[0].width},${VIEWPORTS[0].height}`,
    ],
    defaultViewport: {
      width: VIEWPORTS[0].width,
      height: VIEWPORTS[0].height,
      deviceScaleFactor: 1,
    },
  });

  page = await browser.newPage();

  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("popup", async (popup) => {
    try {
      await popup.close();
    } catch {
      /* provider popunder already gone */
    }
  });
  page.on("response", (res) => {
    let url;
    try {
      url = new URL(res.url());
    } catch {
      return;
    }
    if (url.origin !== ORIGIN) return;
    if (res.status() < 400) return;
    // The preview server has no Netlify Functions; /api responses are expected
    // to fail and are checked separately as "local-only mode".
    if (/^\/(?:api|\.netlify)(?:[/?]|$)/.test(url.pathname)) return;
    failedResponses.push({ path: `${url.pathname}${url.search}`, status: res.status() });
  });

  return profileDir;
}

async function profilesChecks() {
  await check("Profiles picker renders at /", async () => {
    const res = await goto("/", ".profiles-page");
    assert(res && res.status() === 200, `navigation status ${res ? res.status() : "unknown"}`);
    await page.waitForSelector('button[aria-label="Unlock Sam with a password"]', {
      timeout: 20_000,
    });
    const heading = norm(await page.$eval(".profiles-title", (el) => el.textContent));
    assert(heading.includes("Who's watching?"), `heading is ${JSON.stringify(heading)}`);
    return "profiles-page + both seeded screens";
  });

  await check("Service worker registers and activates", async () => {
    const detail = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) throw new Error("serviceWorker unsupported");
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("navigator.serviceWorker.ready timed out (15s)")), 15_000);
      });
      const registration = await Promise.race([navigator.serviceWorker.ready, timeout]);
      if (!registration.active) throw new Error("registration has no active worker");
      return `${registration.scope} (${registration.active.state})`;
    });
    return detail;
  });
}

async function dismissNotice() {
  if (!(await page.$(".notice"))) return;

  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((node) =>
      (node.textContent ?? "").includes("Got it"),
    );
    if (button) button.click();
  });

  await page.waitForFunction(() => !document.querySelector(".notice"), { timeout: 10_000 });
}

async function unlockChecks() {
  await dismissNotice();

  await check("Unlock Sam with 1234 lands on /", async () => {
    await page.click('button[aria-label="Unlock Sam with a password"]');
    await page.waitForSelector(".sheet", { timeout: 10_000 });
    await fill('input[aria-label="Password for Sam"]', SCREEN_PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.pathname === "/", { timeout: 20_000 });
    await page.waitForSelector(".tab-bar", { timeout: 20_000 });
    return "pathname /";
  });

  await check("Home renders hero + shelves and the tab bar", async () => {
    await page.waitForSelector(".home", { timeout: 20_000 });
    const found = await waitForAny([".hero", ".row-error--page", ".home-empty"], 30_000);

    if (found !== ".hero") {
      const errorText = norm(
        await page.evaluate(() => document.querySelector(".row-error__text, .home-empty")?.textContent),
      );
      throw new SkipError(
        `TMDB catalogue unavailable${errorText ? ` (${errorText})` : ""}; hero/shelves cannot render`,
      );
    }

    await page.waitForFunction(
      () => {
        const shelves = [...document.querySelectorAll(".row")].filter((row) =>
          row.querySelector(".row-scroller"),
        );
        const populated = shelves.filter((row) => row.querySelector(".poster-card"));
        return populated.length >= 2;
      },
      { timeout: 45_000 },
    );

    const rows = await page.$$eval(".row", (nodes) => nodes.length);
    const posters = await page.$$eval(".row .poster-card", (nodes) => nodes.length);
    const tabBar = Boolean(await page.$(".tab-bar"));
    assert(tabBar, ".tab-bar is missing");
    assert(rows >= 2, `only ${rows} shelf row(s) rendered`);
    assert(posters >= 10, `only ${posters} poster card(s) rendered across the shelves`);
    return `.hero, ${rows} rows, ${posters} posters, .tab-bar`;
  });

  await check("App sets document.documentElement.dataset.theme", async () => {
    const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
    assert(theme === "dark" || theme === "amoled", `dataset.theme is ${JSON.stringify(theme)}`);
    return `theme=${theme}`;
  });
}

async function deepLinkChecks() {
  const links = [
    {
      path: "/search",
      selector: ".search-page",
      content: async () => {
        const title = norm(await page.$eval(".search-title", (el) => el.textContent));
        assert(title.includes("Search the whole shelf"), `search title is ${JSON.stringify(title)}`);
        return title;
      },
    },
    {
      path: "/library",
      selector: ".library-page",
      content: async () => {
        const title = norm(await page.$eval(".library-title", (el) => el.textContent));
        assert(title === "Sam", `library title is ${JSON.stringify(title)}`);
        return title;
      },
    },
    {
      path: "/browse/trending",
      selector: ".browse-page",
      content: async () => {
        const title = norm(await page.$eval(".browse-title", (el) => el.textContent));
        assert(title.includes("Trending this week"), `browse title is ${JSON.stringify(title)}`);
        return title;
      },
    },
    {
      path: "/admin",
      selector: ".admin-page--login",
      content: async () => {
        assert(await page.$("#admin-password"), "admin password field is missing");
        assert(await hasText("Control room"), "login gate copy is missing");
        return "login gate";
      },
    },
  ];

  for (const link of links) {
    await check(`Deep link ${link.path} renders the SPA shell`, async () => {
      const res = await goto(link.path, ".app");
      assert(res && res.status() === 200, `navigation status ${res ? res.status() : "unknown"}`);
      await page.waitForSelector(link.selector, { timeout: 30_000 });
      const proof = await link.content();
      return `.app + ${link.selector} + ${proof}`;
    });
  }
}

async function adminChecks() {
  await check("/admin shows the login gate", async () => {
    await goto("/admin", ".admin-page--login");
    const text = norm(await bodyText());
    assert(text.includes("Control room"), "Control room heading is missing");
    assert(text.includes("Authenticate"), "Authenticate button is missing");
    assert(!(await page.$(".admin-page--dash")), "dashboard rendered before authentication");
    return "Control room + Authenticate";
  });

  await check(`Admin login with ${ADMIN_PASSWORD} shows the dashboard`, async () => {
    await fill("#admin-password", ADMIN_PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".admin-page--dash", { timeout: 20_000 });
    await page.waitForSelector(".admin-screen-list", { timeout: 20_000 });

    const text = norm(await bodyText());
    assert(text.includes("Sam"), "registry is missing Sam");
    assert(text.includes("Mellu"), "registry is missing Mellu");
    const rows = await page.$$eval(".admin-screen", (nodes) => nodes.length);
    assert(rows >= 2, `only ${rows} registry row(s)`);
    return `.admin-page--dash, ${rows} screens`;
  });
}

async function titleChecks() {
  await check(`/title/movie/550 renders .title-page`, async () => {
    const res = await goto(TITLE_PATH, ".title-page");
    assert(res && res.status() === 200, `navigation status ${res ? res.status() : "unknown"}`);
    return ".title-page";
  });

  await check("Title page renders a Play control", async () => {
    const failed = Boolean(await page.$(".title-empty"));
    if (failed) {
      const errorText = norm(await page.$eval(".title-empty", (el) => el.textContent));
      throw new SkipError(`TMDB title unavailable (${errorText}); Play control cannot render`);
    }

    await page.waitForSelector(".title-heading", { timeout: 30_000 });
    const play = await page.evaluate(() => {
      const link = [...document.querySelectorAll(".title-actions a")].find(
        (node) => (node.textContent ?? "").trim() === "Play",
      );
      return link ? { href: link.getAttribute("href"), text: link.textContent.trim() } : null;
    });
    assert(play, "no Play link in .title-actions");
    assert(play.href === "/watch/movie/550", `Play links to ${play.href}`);
    return `Play -> ${play.href}`;
  });
}

async function watchChecks() {
  await check(`/watch/tv/1399?s=1&e=1 renders the deck, S1·E1, Reload, no Previous`, async () => {
    const res = await goto(WATCH_PATH, ".watch-bar");
    assert(res && res.status() === 200, `navigation status ${res ? res.status() : "unknown"}`);

    // URL-driven controls are present before TMDB answers.
    assert(await page.$('[aria-label="Reload stream"]'), "Reload stream control is missing");
    assert(!(await page.$('[aria-label="Previous episode"]')), "Previous episode appeared on S1E1");

    // The badge sits inside the deck's `detail ? ...` branch, so wait for the
    // async title details instead of sampling the instant .watch-bar appears.
    try {
      await page.waitForSelector(".watch-episode-badge", { timeout: 30_000 });
    } catch {
      throw new SkipError("TMDB title details unavailable; the S1·E1 badge cannot render");
    }

    const badge = norm(await page.$eval(".watch-episode-badge", (el) => el.textContent));
    assert(/S1\s*[·•∙]\s*E1/.test(badge), `badge is ${JSON.stringify(badge)}`);

    return `.watch-bar, ${badge}, Reload stream, no Previous`;
  });

  await check("Watch page shows the episode name and Next episode", async () => {
    try {
      await page.waitForFunction(
        () => {
          const name = (document.querySelector(".watch-episode-name")?.textContent ?? "").trim();
          const realName =
            name.length > 0 && !name.startsWith("Loading") && name !== "Episode";
          return realName && Boolean(document.querySelector('a[aria-label="Next episode"]'));
        },
        { timeout: 30_000 },
      );
    } catch {
      const name = norm(
        await page.evaluate(
          () => document.querySelector(".watch-episode-name")?.textContent ?? "",
        ),
      );
      throw new SkipError(
        `TMDB episode metadata unavailable (episode name ${JSON.stringify(name)}); Next episode cannot render`,
      );
    }

    const name = norm(await page.$eval(".watch-episode-name", (el) => el.textContent));
    const nextHref = await page.$eval('a[aria-label="Next episode"]', (el) =>
      el.getAttribute("href"),
    );
    return `${JSON.stringify(name)}, Next -> ${nextHref}`;
  });
}

/* ------------------------------------------------------------------ */
/* Screenshots                                                        */
/* ------------------------------------------------------------------ */

const SHOT_PAGES = [
  { name: "profiles", path: "/profiles", selector: ".profiles-page" },
  { name: "home", path: "/", selector: ".home" },
  { name: "title", path: TITLE_PATH, selector: ".title-page" },
  { name: "watch", path: WATCH_PATH, selector: ".watch-bar" },
  { name: "admin", path: "/admin", selector: ".admin-page--dash" },
  { name: "search", path: "/search", selector: ".search-page" },
  { name: "library", path: "/library", selector: ".library-page" },
  { name: "browse", path: "/browse/trending", selector: ".browse-page" },
];

async function captureScreenshots() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  for (const viewport of VIEWPORTS) {
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      deviceScaleFactor: 1,
    });

    for (const shot of SHOT_PAGES) {
      try {
        await goto(shot.path, shot.selector);
        await settle(1200);
        const file = path.join(
          SHOT_DIR,
          `${shot.name}-${viewport.width}x${viewport.height}.png`,
        );
        await page.screenshot({ path: file, fullPage: false });
        shotFiles.push(file);
      } catch (err) {
        console.log(`WARN  screenshot ${shot.name} @ ${viewport.width}x${viewport.height} - ${message(err)}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

let chromeProfileDir = null;

async function main() {
  console.log("Lighthook production-preview QA");
  console.log(`App:      ${APP_DIR}`);
  console.log(`Preview:  ${BASE}`);
  console.log(`Chrome:   ${CFG.chrome}`);
  console.log(`Shots:    ${SHOT_DIR}`);
  console.log("");

  if (!fs.existsSync(CFG.chrome)) {
    console.error(`Chrome not found at ${CFG.chrome}`);
    process.exit(64);
  }

  await buildArtifactChecks();
  await checkHashedAssets();

  spawnPreview();
  try {
    await waitForPreview();
    pass(`vite preview is serving the production build on ${PREVIEW_PORT}`, BASE);

    await httpChecks();

    chromeProfileDir = await launchBrowser();
    await profilesChecks();
    await unlockChecks();
    await deepLinkChecks();
    await adminChecks();
    await titleChecks();
    await watchChecks();

    await captureScreenshots();

    await check("No uncaught page errors during the run", async () => {
      assert(
        pageErrors.length === 0,
        `${pageErrors.length} pageerror(s): ${[...new Set(pageErrors)].join(" | ")}`,
      );
      return "0 pageerror events";
    });

    await check("No 404s (or other failed responses) for same-origin assets", async () => {
      const unique = [...new Map(failedResponses.map((entry) => [entry.path, entry])).values()];
      assert(
        unique.length === 0,
        unique.map((entry) => `${entry.status} ${entry.path}`).join(", "),
      );
      return "no failed same-origin responses";
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already gone */
      }
      browser = null;
      page = null;
    }

    if (chromeProfileDir && !CFG.keepProfile) {
      try {
        fs.rmSync(chromeProfileDir, { recursive: true, force: true });
      } catch {
        /* Chrome can hold a file open briefly; the temp dir is disposable */
      }
    }

    await stopPreview();
  }

  const passed = results.filter((entry) => entry.status === "PASS").length;
  const failed = results.filter((entry) => entry.status === "FAIL").length;
  const skipped = results.filter((entry) => entry.status === "SKIP").length;

  console.log("");
  console.log(`Summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`Screenshots: ${shotFiles.length} file(s) in ${SHOT_DIR}`);

  if (failed > 0) process.exitCode = 1;
  else if (skipped > 0) process.exitCode = 2;
}

main().catch(async (err) => {
  console.error(`FATAL  ${message(err)}`);
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* already gone */
    }
  }
  if (chromeProfileDir && !CFG.keepProfile) {
    try {
      fs.rmSync(chromeProfileDir, { recursive: true, force: true });
    } catch {
      /* Chrome can hold a file open briefly; the temp dir is disposable */
    }
  }
  await stopPreview();
  process.exitCode = 1;
});
