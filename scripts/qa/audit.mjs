#!/usr/bin/env node
/**
 * Lighthook household QA audit.
 *
 * Drives the real app in headless Chrome (puppeteer-core) and checks the
 * household rules end to end:
 *
 *   1. House notice copy, "Got it" dismissal, localStorage day stamp, and the
 *      notice being hidden on /watch and /admin.
 *   2. Screen unlock, the three-strike lockout, and the blocked screen
 *      refusing even the correct password.
 *   3. Admin login, the screen/password registry, unblocking, adding a screen
 *      (and unlocking it), removing it, and the "Copy all" control.
 *   4. The movie title page (no "Continue", no stale player copy).
 *   5. The TV watch page (episode badge, episode name, Next / Reload, no
 *      Previous on the first episode).
 *
 * Usage (from anywhere; puppeteer-core resolves from the Appy package):
 *
 *   node scripts/qa/audit.mjs
 *   node scripts/qa/audit.mjs --headed --keep-profile
 *   node scripts/qa/audit.mjs --base=http://localhost:5173 --chrome="C:\path\chrome.exe"
 *
 * Exit codes:
 *   0  every check passed
 *   1  at least one FAIL
 *   2  no FAIL, but at least one SKIP (environment limitation, e.g. TMDB down)
 *   64 bad arguments / missing Chrome binary
 *
 * The run is repeatable: it launches Chrome with a brand-new temporary profile
 * and wipes the origin's storage before the first assertion, so no auth record,
 * lockout counter, or dismissal stamp survives between runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_BASE = "http://localhost:5173";
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/** Keys / secrets the audit relies on (see src/lib/auth.ts). */
const NOTICE_KEY = "lighthook.notice.acknowledged";
const LEGACY_NOTICE_KEY = "lighthook.notice.dismissedOn";
const ADMIN_PASSWORD = "light0552";
const DEFAULT_SCREEN_PASSWORD = "1234";

/** The disposable screen the admin phase provisions and then removes. */
const QA_SCREEN = { name: "QA Test", password: "qa-pass-9" };

const MOVIE_TITLE_PATH = "/title/movie/550";
const TV_WATCH_PATH = "/watch/tv/1399?s=1&e=1";

const SHOT_DIR = path.join(os.tmpdir(), "opencode", "lighthook-qa");
const PROFILE_ROOT = path.join(os.tmpdir(), "opencode");

function parseArgs(argv) {
  const config = {
    base: DEFAULT_BASE,
    chrome: DEFAULT_CHROME,
    headed: false,
    keepProfile: false,
  };

  for (const arg of argv) {
    if (arg === "--headed") config.headed = true;
    else if (arg === "--keep-profile") config.keepProfile = true;
    else if (arg.startsWith("--base=")) config.base = arg.slice("--base=".length);
    else if (arg.startsWith("--chrome=")) config.chrome = arg.slice("--chrome=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Lighthook QA audit",
          "",
          "  node scripts/qa/audit.mjs [options]",
          "",
          "  --headed            show the browser window",
          "  --keep-profile      keep the temporary Chrome profile after the run",
          "  --base=<url>        app origin (default http://localhost:5173)",
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

/* ------------------------------------------------------------------ */
/* Result bookkeeping                                                  */
/* ------------------------------------------------------------------ */

const results = [];
const runtimeDiagnostics = [];
let shotSeq = 0;

/** A skip is an environment limitation, never a false pass. */
class SkipError extends Error {}

const message = (err) => (err instanceof Error ? err.message : String(err));

function record(status, name, detail = "") {
  results.push({ status, name, detail });
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const pass = (name, detail) => record("PASS", name, detail);
const fail = (name, detail) => record("FAIL", name, detail);
const skip = (name, detail) => record("SKIP", name, detail);

function assert(condition, text) {
  if (!condition) throw new Error(text);
}

/** Normalises whitespace and smart apostrophes so copy checks are stable. */
const norm = (value) =>
  (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .trim();

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function shot(name, fullPage = false) {
  if (!page) return null;
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `${String(++shotSeq).padStart(2, "0")}-${name}`);
    await page.screenshot({ path: file, fullPage });
    return file;
  } catch {
    return null;
  }
}

/**
 * Runs one assertion, records PASS / FAIL / SKIP, and never lets a failure
 * abort the rest of the audit. A failing check also saves a screenshot.
 */
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
    const file = await shot(`fail-${slug(name)}.png`);
    fail(name, `${message(err)}${file ? ` (screenshot: ${file})` : ""}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Browser + page helpers                                              */
/* ------------------------------------------------------------------ */

/** @type {import("puppeteer-core").Page | null} */
let page = null;

async function goto(pathname, waitFor, timeout = 45_000) {
  const url = pathname.startsWith("http") ? pathname : `${BASE}${pathname}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  if (waitFor) await page.waitForSelector(waitFor, { timeout });
}

async function bodyText() {
  return page.evaluate(() => document.body.innerText);
}

async function waitForBodyText(text, timeout = 10_000) {
  await page.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    { timeout },
    text,
  );
}

async function clickText(selector, text, { exact = false } = {}) {
  const handles = await page.$$(selector);
  for (const handle of handles) {
    const label = norm(await handle.evaluate((el) => el.textContent ?? ""));
    if (exact ? label === text : label.includes(text)) {
      await handle.click();
      return;
    }
  }
  throw new Error(`No ${selector} with text "${text}"`);
}

async function fill(selector, value) {
  const input = await page.waitForSelector(selector, { timeout: 10_000 });
  // Click to focus, then select all via keyboard: triple-click selection is
  // unreliable on inputs the app pre-fills (e.g. the admin add-screen form).
  await input.click();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await input.type(value);
}

async function waitForHome(timeout = 25_000) {
  await page.waitForFunction(
    () => location.pathname === "/" && document.querySelector(".tab-bar") !== null,
    { timeout },
  );
}

async function openUnlockSheet(name) {
  await page.waitForSelector(`button[aria-label="Unlock ${name} with a password"]`, {
    timeout: 15_000,
  });
  await page.click(`button[aria-label="Unlock ${name} with a password"]`);
  await page.waitForSelector(".sheet", { timeout: 10_000 });
}

async function unlockScreen(name, password) {
  await openUnlockSheet(name);
  await fill(`input[aria-label="Password for ${name}"]`, password);
  await page.keyboard.press("Enter");
}

/** Reads the admin registry rows as plain objects. */
async function registryRows() {
  return page.$$eval(".admin-screen", (rows) =>
    rows.map((row) => ({
      name: (row.querySelector(".admin-screen-name")?.textContent ?? "").trim(),
      password: (row.querySelector(".admin-password-value")?.textContent ?? "").trim(),
      blocked: Boolean(row.querySelector(".admin-blocked-badge")),
      status: (row.querySelector(".admin-status")?.textContent ?? "").trim(),
    })),
  );
}

async function findAdminRow(name) {
  const rows = await page.$$(".admin-screen");
  for (const row of rows) {
    const rowName = norm(
      await row.evaluate(
        (el) => el.querySelector(".admin-screen-name")?.textContent ?? "",
      ),
    );
    if (rowName === name) return row;
  }
  return null;
}

async function findRowButton(row, text) {
  const buttons = await row.$$("button");
  for (const button of buttons) {
    const label = norm(await button.evaluate((el) => el.textContent ?? ""));
    if (label.includes(text)) return button;
  }
  return null;
}

/** Waits until the named registry row exists (optionally unblocked). */
async function waitForAdminRow(name, { unblocked = false, gone = false } = {}) {
  await page.waitForFunction(
    (target, mustBeUnblocked, mustBeGone) => {
      const row = [...document.querySelectorAll(".admin-screen")].find(
        (el) => (el.querySelector(".admin-screen-name")?.textContent ?? "").trim() === target,
      );
      if (mustBeGone) return !row;
      if (!row) return false;
      if (mustBeUnblocked) return !row.querySelector(".admin-blocked-badge");
      return true;
    },
    { timeout: 20_000 },
    name,
    unblocked,
    gone,
  );
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

/**
 * Boots the app once, wipes every storage bucket for the origin, then reloads
 * so the run starts from a genuinely fresh household.
 */
async function setup() {
  await resetServerAuth();
  await goto("/profiles", ".profiles-page");

  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Storage.clearDataForOrigin", {
      origin: ORIGIN,
      storageTypes: "all",
    });
  } finally {
    await cdp.detach().catch(() => {});
  }

  await goto("/profiles", ".profiles-page");
  await page.waitForSelector('button[aria-label="Unlock Sam with a password"]', {
    timeout: 20_000,
  });
}

/**
 * Resets Sam and Mellu to the seeded passcode, clears any server-side lockout
 * and removes QA Test leftovers, so the audit is repeatable. Auth is
 * server-backed, so a previous half-finished run would otherwise leave Mellu
 * blocked in Blobs or a duplicate QA Test profile behind.
 * Silently no-ops when the auth function is not running (e.g. vite preview).
 */
async function resetServerAuth() {
  try {
    const headers = {
      "content-type": "application/json",
      "x-family-key": process.env.QA_FAMILY_KEY || "samandmellu",
    };
    const post = (body, extra = {}) =>
      fetch(`${BASE}/api/auth`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
      });

    const login = await post({ action: "adminLogin", password: "light0552" });
    if (!login.ok) return false;
    const admin = { "x-admin-key": "light0552" };

    // Clean any leftover QA Test screens from an interrupted previous run.
    const listRes = await fetch(`${BASE}/api/profiles`, { headers });
    if (listRes.ok) {
      const list = await listRes.json().catch(() => null);
      const leftovers = Array.isArray(list?.profiles)
        ? list.profiles.filter((entry) => entry?.name === QA_SCREEN.name)
        : [];
      for (const entry of leftovers) {
        await fetch(`${BASE}/api/profiles?id=${encodeURIComponent(entry.id)}`, {
          method: "DELETE",
          headers,
        });
        await post({ action: "adminRemove", profileId: entry.id }, admin);
      }
    }

    for (const profileId of ["sam", "mellu"]) {
      await post(
        { action: "adminSet", profileId, password: DEFAULT_SCREEN_PASSWORD },
        admin,
      );
      await post({ action: "adminUnblock", profileId }, admin);
    }
    return true;
  } catch {
    return false;
  }
}

/* 1 — house notice -------------------------------------------------- */

async function phaseNotice() {
  await check("Profiles picker is the first screen", async () => {
    assert(await page.$(".profiles-page"), "The profiles picker did not render");
    const heading = norm(await page.$eval(".profiles-title", (el) => el.textContent ?? ""));
    return heading || "profiles picker";
  });

  await check("House notice is visible on first open", async () => {
    await page.waitForSelector(".notice", { timeout: 10_000 });
    return "notice present";
  });

  const noticeText = norm(
    await page
      .$eval(".notice", (el) => el.innerText)
      .catch(() => ""),
  );
  await shot("notice.png");

  await check('Notice copy says "Best watched with an ad blocker"', async () => {
    assert(
      noticeText.includes("Best watched with an ad blocker"),
      `Notice copy was: ${noticeText.slice(0, 200) || "(no notice text)"}`,
    );
    return "copy found";
  });

  await check('Notice lists "Brave Browser"', async () => {
    assert(noticeText.includes("Brave Browser"), "Brave Browser is not named");
    return "Brave Browser";
  });

  await check('Notice lists "uBlock Origin Lite"', async () => {
    assert(noticeText.includes("uBlock Origin Lite"), "uBlock Origin Lite is not named");
    return "uBlock Origin Lite";
  });

  await check("Acknowledgement flag is empty before dismissal", async () => {
    const stamp = await page.evaluate((key) => localStorage.getItem(key), NOTICE_KEY);
    assert(stamp === null, `Expected null, found ${JSON.stringify(stamp)}`);
    return "null";
  });

  await check('"Got it" dismisses the notice', async () => {
    await clickText("button", "Got it", { exact: true });
    await page.waitForFunction(() => document.querySelector(".notice") === null, {
      timeout: 10_000,
    });
    return "notice removed";
  });

  await check("Acknowledgement is stored as a permanent flag", async () => {
    const flag = await page.evaluate((key) => localStorage.getItem(key), NOTICE_KEY);
    assert(flag === "1", `Expected "1", found ${JSON.stringify(flag)}`);
    const legacy = await page.evaluate((key) => localStorage.getItem(key), LEGACY_NOTICE_KEY);
    assert(legacy === null, `Legacy date key should be cleared, found ${JSON.stringify(legacy)}`);
    return flag;
  });

  await check("Dismissed notice stays hidden after a reload", async () => {
    await goto("/profiles", ".profiles-page");
    assert((await page.$(".notice")) === null, "Notice came back after reload");
    return "still hidden";
  });

  await check("Clearing the acknowledgement brings the notice back", async () => {
    await page.evaluate((key) => localStorage.removeItem(key), NOTICE_KEY);
    await goto("/profiles", ".profiles-page");
    await page.waitForSelector(".notice", { timeout: 10_000 });
    return "notice returns on a fresh device";
  });
}

/* 2 — notice hidden by route (checked while the stamp is cleared) ---- */

async function phaseNoticeRoutes() {
  await check("House notice is hidden on /admin", async () => {
    // The previous phase proved the notice shows on /profiles with no stamp,
    // so its absence here is route-based, not a leftover dismissal.
    await goto("/admin", ".admin-page");
    assert((await page.$(".notice")) === null, "Notice rendered on /admin");
    return "no notice on /admin";
  });
}

/* 3 — unlock Sam ----------------------------------------------------- */

async function phaseUnlockSam() {
  await check("Sam unlocks with the seeded password 1234", async () => {
    await goto("/profiles", ".profiles-page");
    await unlockScreen("Sam", DEFAULT_SCREEN_PASSWORD);
    await waitForHome();
    return "landed on / with the tab bar";
  });
}

/* 4 — three-strike lockout ------------------------------------------ */

async function phaseLockout() {
  await check("Wrong password reports attempts left (2, then 1)", async () => {
    await goto("/profiles", ".profiles-page");
    await unlockScreen("Mellu", "0000");
    await waitForBodyText("2 attempts left");
    assert(
      norm(await bodyText()).includes("Incorrect password"),
      "The sheet did not say the password was incorrect",
    );

    await fill('input[aria-label="Password for Mellu"]', "1111");
    await page.keyboard.press("Enter");
    await waitForBodyText("1 attempt left");
    return "2 attempts left → 1 attempt left";
  });

  await check('Third wrong password blocks with "Contact admin" copy', async () => {
    await fill('input[aria-label="Password for Mellu"]', "2222");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return text.includes("Contact admin") && /blocked/i.test(text);
      },
      { timeout: 15_000 },
    );
    const text = norm(await bodyText());
    assert(text.includes("Contact admin"), "No Contact admin copy after the third attempt");
    assert(/3 of 3 attempts used/.test(text), "The 3-of-3 attempt counter is missing");
    await shot("blocked-sheet.png");
    return "blocked after 3 attempts";
  });

  await check("Blocked screen is marked on the picker", async () => {
    await clickText("button", "Back to screens", { exact: true });
    await page.waitForFunction(() => document.querySelector(".sheet") === null, {
      timeout: 10_000,
    });
    await page.waitForSelector(
      'button[aria-label="Mellu is blocked. Open for details on contacting admin."]',
      { timeout: 10_000 },
    );
    assert(await page.$(".profile-tile--blocked"), "No blocked tile styling on the picker");
    return "blocked tile present";
  });

  await check("Correct password cannot be entered while blocked", async () => {
    await page.click(
      'button[aria-label="Mellu is blocked. Open for details on contacting admin."]',
    );
    await page.waitForSelector(".sheet", { timeout: 10_000 });
    await waitForBodyText("Contact admin");
    assert(
      (await page.$('input[aria-label="Password for Mellu"]')) === null,
      "The password field is still offered on a blocked screen",
    );
    const unlockOffered = await page.$$eval("button", (buttons) =>
      buttons.some(
        (button) =>
          (button.textContent ?? "").replace(/\s+/g, " ").trim() === "Unlock",
      ),
    );
    assert(!unlockOffered, "The Unlock button is still offered on a blocked screen");
    return "no password field, Contact admin shown";
  });

  // Close the blocked sheet so the next phase starts on the picker.
  await clickText("button", "Back to screens", { exact: true });
  await page.waitForFunction(() => document.querySelector(".sheet") === null, {
    timeout: 10_000,
  });
}

/* 5 — admin console -------------------------------------------------- */

async function phaseAdmin() {
  await check("Admin console requires the admin password", async () => {
    await goto("/admin", ".admin-page--login");
    assert(
      await page.$('input[aria-label="Admin password"]'),
      "No admin password field on /admin",
    );
    return "login gate shown";
  });

  await check("Wrong admin password is rejected", async () => {
    await fill('input[aria-label="Admin password"]', "not-the-password");
    await page.keyboard.press("Enter");
    await waitForBodyText("Incorrect admin password");
    return "rejected";
  });

  await check(`Admin password ${ADMIN_PASSWORD} opens the dashboard`, async () => {
    await fill('input[aria-label="Admin password"]', ADMIN_PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".admin-page--dash", { timeout: 20_000 });
    return "dashboard";
  });

  await shot("admin-dashboard.png", true);

  await check("Dashboard lists screens and their server passcodes", async () => {
    const rows = await registryRows();
    assert(rows.length >= 2, `Only ${rows.length} screen rows are listed`);
    for (const row of rows) {
      assert(row.password, `No passcode is shown for ${row.name}`);
    }
    const byName = Object.fromEntries(rows.map((row) => [row.name, row.password]));
    assert(
      byName.Sam === DEFAULT_SCREEN_PASSWORD,
      `Sam's passcode is shown as ${JSON.stringify(byName.Sam)}`,
    );
    assert(
      byName.Mellu === DEFAULT_SCREEN_PASSWORD,
      `Mellu's passcode is shown as ${JSON.stringify(byName.Mellu)}`,
    );
    return rows.map((row) => `${row.name}:${row.password}`).join(", ");
  });

  await check("Admin has a Copy all passcodes control", async () => {
    const button =
      (await page.$(".admin-copy-all")) || (await page.$(".admin-copy-names"));
    assert(button, "No copy control on the dashboard");
    const label = norm(await button.evaluate((el) => el.textContent ?? ""));
    assert(/copy/i.test(label), `Button label was ${JSON.stringify(label)}`);
    assert(!(await button.evaluate((el) => el.disabled)), "Copy control is disabled");
    return label;
  });

  await check("Blocked screen is listed as blocked in admin", async () => {
    const rows = await registryRows();
    const mellu = rows.find((row) => row.name === "Mellu");
    assert(mellu?.blocked, "Mellu is not marked blocked in the registry");
    return mellu.status;
  });

  await check("Admin can unblock a blocked screen", async () => {
    const row = await findAdminRow("Mellu");
    assert(row, "Mellu's row is missing");
    const button = await findRowButton(row, "Unblock screen");
    assert(button, "No Unblock screen button on Mellu's row");
    await button.click();
    await waitForAdminRow("Mellu", { unblocked: true });
    const rows = await registryRows();
    const mellu = rows.find((entry) => entry.name === "Mellu");
    assert(mellu && !mellu.blocked, "Mellu is still blocked");
    assert(mellu.status === "Active", `Mellu's status is ${JSON.stringify(mellu.status)}`);
    return "Mellu active";
  });

  await check("Unblocked screen accepts its password again", async () => {
    await goto("/profiles", ".profiles-page");
    await unlockScreen("Mellu", DEFAULT_SCREEN_PASSWORD);
    await waitForHome();
    return "Mellu unlocked";
  });

  await check("Admin can add a screen with a name and password", async () => {
    await goto("/admin", ".admin-page--dash");
    await fill('input[aria-label="New screen name"]', QA_SCREEN.name);
    await fill('input[aria-label="New screen password"]', QA_SCREEN.password);
    await clickText("button", "Add screen", { exact: true });
    await waitForAdminRow(QA_SCREEN.name);
    // The profile row renders as soon as the profile exists; the auth record
    // is a second request. Wait for the server-stored passcode note.
    await page.waitForFunction(
      (name) => {
        const row = [...document.querySelectorAll(".admin-screen")].find((r) =>
          r.textContent?.includes(name),
        );
        return row && /stored on server/i.test(row.textContent ?? "");
      },
      { timeout: 20000 },
      QA_SCREEN.name,
    );
    const rows = await registryRows();
    const created = rows.find((row) => row.name === QA_SCREEN.name);
    assert(created, "The new screen is missing from the registry");
    assert(
      created.password === QA_SCREEN.password,
      `Stored passcode is ${JSON.stringify(created.password)}`,
    );
    return `${QA_SCREEN.name}:${QA_SCREEN.password}`;
  });

  await check("New screen unlocks with its own password", async () => {
    await goto("/profiles", ".profiles-page");
    await unlockScreen(QA_SCREEN.name, QA_SCREEN.password);
    await waitForHome();
    return `unlocked ${QA_SCREEN.name}`;
  });

  await check("Admin can remove a screen", async () => {
    await goto("/admin", ".admin-page--dash");
    const row = await findAdminRow(QA_SCREEN.name);
    assert(row, "The new screen's row is missing before removal");
    const remove = await findRowButton(row, "Remove screen");
    assert(remove, "No Remove screen button");
    await remove.click();

    // React swaps the button for the confirmation pair; re-find the row.
    const confirmRow = await findAdminRow(QA_SCREEN.name);
    assert(confirmRow, "The row vanished before confirmation");
    const confirm = await findRowButton(confirmRow, "Confirm remove");
    assert(confirm, "No Confirm remove button");
    await confirm.click();

    await waitForAdminRow(QA_SCREEN.name, { gone: true });
    const rows = await registryRows();
    assert(
      !rows.some((entry) => entry.name === QA_SCREEN.name),
      "The screen is still listed after removal",
    );
    return "removed";
  });

  await check("Removed screen disappears from the picker", async () => {
    await goto("/profiles", ".profiles-page");
    const names = await page.$$eval(".profile-name", (els) =>
      els.map((el) => (el.textContent ?? "").trim()),
    );
    assert(
      !names.includes(QA_SCREEN.name),
      `The picker still lists ${QA_SCREEN.name}`,
    );
    return names.join(", ");
  });
}

/* 6 — notice hidden on /watch --------------------------------------- */

async function phaseWatchNotice() {
  await check("Sam unlocks for the watch checks", async () => {
    await goto("/profiles", ".profiles-page");
    await unlockScreen("Sam", DEFAULT_SCREEN_PASSWORD);
    await waitForHome();
    return "Sam active";
  });

  await check("Notice is visible on home (route-hiding control)", async () => {
    // The stamp was cleared in the notice phase and never re-set, so the
    // notice must be present here for the /watch assertion to mean anything.
    await page.waitForSelector(".notice", { timeout: 10_000 });
    return "notice present on /";
  });

  await check("House notice is hidden on /watch", async () => {
    await goto("/watch/movie/550", ".watch-bar");
    assert((await page.$(".notice")) === null, "Notice rendered on /watch");
    return "no notice on /watch";
  });
}

/* 7 — movie title page ---------------------------------------------- */

async function phaseMovieTitle() {
  let loaded = false;

  await check("Movie title page loads", async () => {
    await goto(MOVIE_TITLE_PATH, ".title-page", 60_000);
    await page.waitForFunction(
      () => document.querySelector(".title-heading") || document.querySelector(".title-empty"),
      { timeout: 45_000 },
    );
    if (await page.$(".title-empty")) {
      const copy = norm(
        await page.$eval(".title-empty", (el) => el.innerText).catch(() => ""),
      );
      throw new SkipError(`TMDB title did not load: ${copy || "unknown error"}`);
    }
    loaded = true;
    return norm(await page.$eval(".title-heading", (el) => el.textContent ?? ""));
  });

  if (!loaded) {
    skip("Movie title page has a Play control", "title page unavailable (TMDB)");
    skip("Movie title page has no Continue control", "title page unavailable (TMDB)");
    skip("Movie title page drops the old player copy", "title page unavailable (TMDB)");
    return;
  }

  await shot("title-movie.png", true);

  await check("Movie title page has a Play control", async () => {
    const controls = await page.$$eval("a, button", (els) =>
      els
        .map((el) => ({
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
          href: el.getAttribute("href") ?? "",
        }))
        .filter((entry) => entry.text === "Play" || entry.text.startsWith("Play ")),
    );
    assert(controls.length > 0, "No Play control on the title page");
    assert(
      controls.some((entry) => entry.href.includes("/watch/movie/550")),
      `Play does not link to the movie's watch page: ${JSON.stringify(controls)}`,
    );
    return "Play → /watch/movie/550";
  });

  await check("Movie title page has no Continue control", async () => {
    const continues = await page.$$eval("a, button", (els) =>
      els
        .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((text) => /^Continue\b/.test(text)),
    );
    assert(continues.length === 0, `Found Continue control(s): ${continues.join(", ")}`);
    return "none";
  });

  await check("Movie title page drops the old player copy", async () => {
    const text = norm(await bodyText());
    assert(
      !text.includes("Opens the title you picked"),
      'Found "Opens the title you picked"',
    );
    assert(
      !text.includes("position can't be read back"),
      'Found "position can\'t be read back"',
    );
    return "no stale copy";
  });
}

/* 8 — TV watch page -------------------------------------------------- */

async function phaseTvWatch() {
  let detailLoaded = false;

  await check("TV watch page loads with title details", async () => {
    await goto(TV_WATCH_PATH, ".watch-bar", 60_000);
    const state = await page
      .waitForFunction(
        () => {
          if (document.querySelector(".watch-now-title")) return "detail";
          if (document.body.innerText.includes("Title details didn")) return "failed";
          return false;
        },
        { timeout: 40_000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => "timeout");

    if (state !== "detail") {
      throw new SkipError(
        state === "failed"
          ? "TMDB title details failed to load"
          : "Timed out waiting for TMDB title details",
      );
    }
    detailLoaded = true;
    return norm(await page.$eval(".watch-now-title", (el) => el.textContent ?? ""));
  });

  if (!detailLoaded) {
    for (const name of [
      "TV watch page shows the S1 · E1 episode badge",
      "TV watch page shows the episode name element",
      "TV watch page has a Next episode control",
      "First episode has no Previous episode control",
    ]) {
      skip(name, "title details unavailable (TMDB)");
    }
  } else {
    await check("TV watch page shows the S1 · E1 episode badge", async () => {
      const badge = norm(await page.$eval(".watch-episode-badge", (el) => el.textContent ?? ""));
      assert(/^S1\s*·\s*E1$/.test(badge), `Badge was ${JSON.stringify(badge)}`);
      return badge;
    });

    await check("TV watch page shows the episode name element", async () => {
      const element = await page.waitForSelector(".watch-episode-name", { timeout: 20_000 });
      assert(element, "No .watch-episode-name element");
      const name = norm(await element.evaluate((el) => el.textContent ?? ""));
      if (!name || name === "Episode") {
        throw new SkipError(
          `Season details unavailable — the name fell back to ${JSON.stringify(name || "(empty)")}`,
        );
      }
      return name;
    });

    await check("TV watch page has a Next episode control", async () => {
      const next = await page.$('[aria-label="Next episode"]');
      assert(next, "No Next episode control");
      const href = await next.evaluate((el) => el.getAttribute("href") ?? "");
      assert(/s=1/.test(href) && /e=2/.test(href), `Next links to ${JSON.stringify(href)}`);
      return href;
    });

    await check("First episode has no Previous episode control", async () => {
      const previous = await page.$('[aria-label="Previous episode"]');
      if (previous) {
        // Report where the control points so the finding is actionable.
        const href = await previous.evaluate((el) => el.getAttribute("href") ?? "");
        assert(
          false,
          `A Previous episode control is rendered on S1 E1 and links to ${JSON.stringify(href)}`,
        );
      }
      return "absent";
    });
  }

  await check("TV watch page has a Reload stream control", async () => {
    const reload = await page.$('button[aria-label="Reload stream"]');
    assert(reload, "No Reload stream control");
    assert(!(await reload.evaluate((el) => el.disabled)), "Reload stream is disabled");
    return "button present";
  });

  await shot("watch-tv.png");
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function assertServerUp() {
  try {
    const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    console.error(
      `Cannot reach ${BASE} — start the dev server first (npm run dev). (${message(err)})`,
    );
    process.exit(1);
  }
}

function printSummary() {
  const passed = results.filter((entry) => entry.status === "PASS").length;
  const failed = results.filter((entry) => entry.status === "FAIL");
  const skipped = results.filter((entry) => entry.status === "SKIP");

  console.log("");
  console.log(
    `Summary: ${passed} passed, ${failed.length} failed, ${skipped.length} skipped (${results.length} checks)`,
  );

  if (failed.length) {
    console.log("Failed:");
    for (const entry of failed) console.log(`  FAIL  ${entry.name} — ${entry.detail}`);
  }
  if (skipped.length) {
    console.log("Skipped:");
    for (const entry of skipped) console.log(`  SKIP  ${entry.name} — ${entry.detail}`);
  }
  if (runtimeDiagnostics.length) {
    console.log("Runtime diagnostics:");
    for (const line of runtimeDiagnostics) console.log(`  - ${line}`);
  }

  console.log(`Screenshots: ${SHOT_DIR}`);
}

async function main() {
  if (!fs.existsSync(CFG.chrome)) {
    console.error(`Chrome not found at ${CFG.chrome} — pass --chrome=<path>.`);
    process.exit(64);
  }

  await assertServerUp();

  console.log(`Lighthook QA audit — ${BASE}`);
  console.log(`Chrome: ${CFG.chrome}`);
  console.log("");

  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(PROFILE_ROOT, "lighthook-qa-profile-"));

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CFG.chrome,
      headless: !CFG.headed,
      userDataDir: profileDir,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-extensions",
        "--mute-audio",
        "--window-size=1440,1000",
      ],
      defaultViewport: { width: 1440, height: 1000 },
    });

    page = await browser.newPage();
    page.setDefaultTimeout(15_000);

    // Provider frames fire popunders; close them instead of leaking tabs.
    page.on("popup", (popup) => {
      popup.close().catch(() => {});
    });
    page.on("pageerror", (err) => {
      runtimeDiagnostics.push(`pageerror: ${message(err)}`);
    });
    // Collect page errors / failing endpoints once each (no duplicate spam);
    // printed in the summary as "Runtime diagnostics".
    const pushDiagnostic = (line) => {
      if (!runtimeDiagnostics.includes(line)) runtimeDiagnostics.push(line);
    };
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const url = msg.location()?.url ?? "";
      if (url.startsWith(BASE)) pushDiagnostic(`console.error: ${msg.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() < 500) return;
      const url = response.url();
      if (!url.startsWith(BASE)) return;
      pushDiagnostic(`HTTP ${response.status()}: ${url.split("?")[0]}`);
    });

    await setup();

    const phases = [
      ["House notice", phaseNotice],
      ["Notice route hiding", phaseNoticeRoutes],
      ["Unlock Sam", phaseUnlockSam],
      ["Three-strike lockout", phaseLockout],
      ["Admin console", phaseAdmin],
      ["Watch notice hiding", phaseWatchNotice],
      ["Movie title page", phaseMovieTitle],
      ["TV watch page", phaseTvWatch],
    ];

    for (const [name, fn] of phases) {
      try {
        await fn();
      } catch (err) {
        fail(`Phase "${name}" aborted`, message(err));
      }
    }
  } catch (err) {
    fail("Audit run", message(err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!CFG.keepProfile) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
      } catch {
        runtimeDiagnostics.push(`Could not remove temp profile ${profileDir}`);
      }
    }
  }

  printSummary();

  const failedCount = results.filter((entry) => entry.status === "FAIL").length;
  const skippedCount = results.filter((entry) => entry.status === "SKIP").length;
  process.exitCode = failedCount > 0 ? 1 : skippedCount > 0 ? 2 : 0;
}

await main();
