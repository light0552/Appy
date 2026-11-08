import puppeteer from "puppeteer-core";
import { rmSync } from "node:fs";

/**
 * Feature QA for the 2026 access-control release.
 *
 * Covers, in a real headless Chrome against the local Netlify functions:
 *  - one-time pass → forced first-login change → permanent pass, no app access
 *  - admin-only ref name, never shown on the picker or public APIs
 *  - self-service passcode change + server-enforced weekly cooldown surviving
 *    a full cookie/localStorage wipe
 *  - admin kick on Home and mid-watch, per-screen and multi-select
 *  - history multi-select removal and tombstone sync on a "second device"
 *  - admin readback of a passcode the user set themselves
 */

const BASE = process.env.QA_BASE || "http://localhost:5173";
const API = process.env.QA_API || "http://localhost:8888";
const CHROME = process.env.QA_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE_DIR =
  process.env.QA_PROFILE ||
  "C:\\Users\\LIGHTHOOK\\AppData\\Local\\Temp\\opencode\\lighthook-features";
const FAMILY_KEY = process.env.QA_FAMILY_KEY || "samandmellu";
const ADMIN_KEY = process.env.QA_ADMIN_KEY || "light0552";
const ORIGIN = new URL(BASE).origin;

const A_NAME = "QA OTP";
const B_NAME = "QA Kick";
const A_OTP = "otp-pass-11";
const A_PERMA = "perma-pass-22";
const A_SELF = "perma-pass-33";
const B_PASS = "kick-pass-44";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function step(name) {
  console.log(`\n>>> ${name}`);
}

/* ------------------------------ REST helpers ------------------------------ */

async function api(action, body = {}, opts = {}) {
  const res = await fetch(`${API}/api/auth`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-family-key": FAMILY_KEY,
      ...(opts.admin ? { "x-admin-key": ADMIN_KEY } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: JSON.stringify({ action, ...body }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith("lighthook_session=") && value.length > 30);
  return { status: res.status, data, cookie: cookie ?? null };
}

async function stateApi(method, id, body) {
  const res = await fetch(`${API}/api/profiles?id=${encodeURIComponent(id)}`, {
    method,
    headers: { "x-family-key": FAMILY_KEY, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, data };
}

async function listProfiles() {
  const res = await fetch(`${API}/api/profiles`, { headers: { "x-family-key": FAMILY_KEY } });
  const data = await res.json();
  return data.profiles ?? [];
}

async function removeProfile(profile) {
  await stateApi("DELETE", profile.id);
  await api("adminRemove", { profileId: profile.id }, { admin: true });
}

async function cleanupQaProfiles() {
  for (const profile of await listProfiles()) {
    if (profile.name.startsWith("QA ")) await removeProfile(profile);
  }
}

/* ------------------------------ DOM helpers ------------------------------- */

try {
  rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
} catch {
  /* leftover lock; continue with the existing profile if removal failed */
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  userDataDir: PROFILE_DIR,
  protocolTimeout: 45_000,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 950 },
});

const page = await browser.newPage();
const adminPage = await browser.newPage();
const pageErrors = [];
for (const p of [page, adminPage]) {
  p.on("pageerror", (error) => pageErrors.push(error.message));
  p.on("popup", async (popup) => {
    try {
      await popup.close();
    } catch {
      /* ignore */
    }
  });
}

async function goto(p, path, waitFor) {
  await p.bringToFront();
  await p.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (waitFor) await p.waitForSelector(waitFor, { timeout: 30000 });
}

async function clickSelector(p, selector) {
  await p.bringToFront();
  await p.waitForSelector(selector, { timeout: 15000 });
  await p.click(selector);
}

async function typeInto(p, selector, value) {
  await p.bringToFront();
  await p.waitForSelector(selector, { timeout: 15000 });
  await p.click(selector);
  await p.keyboard.down("Control");
  await p.keyboard.press("KeyA");
  await p.keyboard.up("Control");
  await p.keyboard.press("Backspace");
  await p.type(selector, value);
}

async function dismissNotice(p = page) {
  await p.bringToFront();
  if (!(await p.$(".notice"))) return;
  try {
    await p.click(".notice-got");
  } catch {
    /* fall through to the storage fallback */
  }
  try {
    await p.waitForFunction(() => !document.querySelector(".notice"), { timeout: 3000 });
    return;
  } catch {
    /* React had not attached the handler yet — acknowledge and reload */
  }
  await p.evaluate(() => {
    try {
      localStorage.setItem("lighthook.notice.acknowledged", "1");
    } catch {
      /* ignore */
    }
  });
  await p.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForFunction(() => !document.querySelector(".notice"), { timeout: 20000 });
}

async function clickText(p, text, root = "document") {
  await p.bringToFront();
  const clicked = await p.evaluate(
    (needle, scope) => {
      const host = scope === "document" ? document : document.querySelector(scope);
      if (!host) return false;
      const button = [...host.querySelectorAll("button")].find((candidate) =>
        (candidate.textContent || "").trim().includes(needle),
      );
      button?.click();
      return Boolean(button);
    },
    text,
    root,
  );
  if (!clicked) throw new Error(`button not found: ${text}`);
}

async function clickRowButton(p, name, label) {
  await p.bringToFront();
  const clicked = await p.evaluate(
    (screenName, buttonText) => {
      const row = [...document.querySelectorAll(".admin-screen")].find(
        (candidate) =>
          candidate.querySelector(".admin-screen-name")?.textContent?.trim() === screenName,
      );
      if (!row) return false;
      const button = [...row.querySelectorAll("button")].find((candidate) =>
        (candidate.textContent || "").trim().includes(buttonText),
      );
      button?.click();
      return Boolean(button);
    },
    name,
    label,
  );
  if (!clicked) throw new Error(`row button not found: ${name} / ${label}`);
}

async function waitForText(p, text, timeout = 20000) {
  await p.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    { timeout },
    text,
  );
}

async function openScreen(name, target = page) {
  await target.bringToFront();
  await target.waitForSelector(`button[aria-label*="${name}"]`, { timeout: 20000 });
  await target.evaluate((needle) => {
    const tile = [...document.querySelectorAll("button")].find((candidate) =>
      (candidate.getAttribute("aria-label") || "").includes(needle),
    );
    tile?.click();
  }, name);
  await target.waitForSelector(".sheet", { timeout: 15000 });
}

async function unlock(name, password, target = page) {
  await openScreen(name, target);
  await typeInto(target, `input[aria-label="Password for ${name}"]`, password);
  await target.keyboard.press("Enter");
}

async function waitHome(target = page) {
  await target.waitForFunction(() => location.pathname === "/" && Boolean(document.querySelector(".home")), {
    timeout: 30000,
  });
}

async function adminLogin(target = adminPage) {
  await target.bringToFront();
  await goto(target, "/admin", ".admin-page");
  if (await target.$(".admin-page--login")) {
    await typeInto(target, 'input[aria-label="Admin password"]', ADMIN_KEY);
    await target.keyboard.press("Enter");
  }
  await target.waitForSelector(".admin-page:not(.admin-page--login)", { timeout: 30000 });
}

async function rowPassword(name, target = adminPage) {
  await target.bringToFront();
  return target.evaluate((screenName) => {
    const row = [...document.querySelectorAll(".admin-screen")].find(
      (candidate) =>
        candidate.querySelector(".admin-screen-name")?.textContent?.trim() === screenName,
    );
    return row?.querySelector(".admin-password-value")?.textContent?.trim() ?? null;
  }, name);
}

async function wipeDevice(target = page) {
  const cdp = await target.createCDPSession();
  try {
    // Only the credential-bearing stores. Clearing the service worker on a
    // production origin fires controllerchange, which can navigate the page
    // mid-evaluate; the security claim is about cookies/localStorage/IndexedDB.
    await cdp.send("Storage.clearDataForOrigin", {
      origin: ORIGIN,
      storageTypes: "cookies,local_storage,indexeddb",
    });
  } finally {
    await cdp.detach().catch(() => {});
  }
  await target
    .evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      /* a service-worker reload can destroy the context; navigation below recovers */
    });
  await goto(target, "/", ".profiles-page");
  await dismissNotice(target);
}

/** Refreshes the library UI after server-side history seeding. */
async function openHistory(target = page) {
  await goto(target, "/library", ".library-page");
  await clickText(target, "History", ".library-tabs");
  await target.waitForFunction(
    () => document.querySelectorAll(".library-grid .poster-card, .library-grid .poster").length >= 0,
    { timeout: 20000 },
  );
}

async function historyTitles(target = page) {
  return target.evaluate(() =>
    [...document.querySelectorAll(".library-grid .poster-card")].map(
      (card) => card.textContent?.trim() ?? "",
    ),
  );
}

async function seedHistory(profileId, titles) {
  const now = Date.now();
  const history = titles.map((title, index) => ({
    id: `qa-${index}-${now}-movie-${1000 + index}`,
    mediaType: "movie",
    tmdbId: 1000 + index,
    title,
    posterPath: null,
    watchedAt: now - index * 1000,
    updatedAt: now - index * 1000,
  }));
  const res = await stateApi("POST", profileId, { history });
  if (res.status !== 200) throw new Error(`seed history failed (${res.status})`);
}

async function serverHistory(profileId) {
  const res = await stateApi("GET", profileId);
  const history = res.data.history ?? [];
  return {
    live: history.filter((item) => !item.deletedAt),
    tombstones: history.filter((item) => Boolean(item.deletedAt)),
  };
}

/** Waits for the debounced/async push to reach the server. */
async function waitForServerHistory(profileId, predicate, timeout = 15000) {
  const startedAt = Date.now();
  let last = await serverHistory(profileId);
  while (!predicate(last) && Date.now() - startedAt < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = await serverHistory(profileId);
  }
  return last;
}

/* -------------------------------------------------------------------------- */

let profileA = null;
let profileB = null;

try {
  await cleanupQaProfiles();

  /* ===================== 1. admin creates the screens ===================== */

  step("admin creates screens");
  await adminLogin();

  await typeInto(adminPage, 'input[aria-label="New screen name"]', A_NAME);
  await typeInto(adminPage, 'input[aria-label="New screen password"]', A_OTP);
  await typeInto(adminPage, 'input[aria-label="Admin reference name"]', "zyn");
  await clickSelector(adminPage, 'input[aria-label="One-time passcode"]');
  await clickText(adminPage, "Add screen");
  await adminPage.waitForFunction(
    (name) =>
      [...document.querySelectorAll(".admin-screen")].some(
        (row) =>
          row.querySelector(".admin-screen-name")?.textContent?.trim() === name &&
          row.textContent?.includes("One-time · change pending") &&
          row.textContent?.includes("ref: zyn"),
      ),
    { timeout: 30000 },
    A_NAME,
  );
  check("Admin can add a screen with a one-time pass and an admin ref name", true);

  await typeInto(adminPage, 'input[aria-label="New screen name"]', B_NAME);
  await typeInto(adminPage, 'input[aria-label="New screen password"]', B_PASS);
  await clickText(adminPage, "Add screen");
  await adminPage.waitForFunction(
    (name) =>
      [...document.querySelectorAll(".admin-screen")].some(
        (row) => row.querySelector(".admin-screen-name")?.textContent?.trim() === name,
      ),
    { timeout: 30000 },
    B_NAME,
  );
  await adminPage.waitForFunction(
    (name, expected) =>
      [...document.querySelectorAll(".admin-screen")].some(
        (row) =>
          row.querySelector(".admin-screen-name")?.textContent?.trim() === name &&
          row.querySelector(".admin-password-value")?.textContent?.trim() === expected,
      ),
    { timeout: 30000 },
    B_NAME,
    B_PASS,
  );
  check("Admin can add a second screen with a permanent pass", true);

  check("Admin reads the one-time pass in the console", (await rowPassword(A_NAME)) === A_OTP);
  check("Admin reads the permanent pass in the console", (await rowPassword(B_NAME)) === B_PASS);

  profileA = (await listProfiles()).find((profile) => profile.name === A_NAME);
  profileB = (await listProfiles()).find((profile) => profile.name === B_NAME);
  if (!profileA || !profileB) throw new Error("QA profiles missing after admin add");

  /* ===================== 2. ref name privacy ============================== */

  step("ref-name privacy");
  await goto(page, "/", ".profiles-page");
  await dismissNotice();
  const pickerText = await page.evaluate(() => document.body.innerText);
  check("Admin ref name is never shown on the picker", !pickerText.includes("zyn"));
  const publicProfiles = await listProfiles();
  check(
    "Admin ref name is absent from the public profiles API",
    publicProfiles.every((profile) => !("adminName" in profile) || !profile.adminName),
  );

  /* ===================== 3. forced one-time change ======================== */

  step("forced one-time change");
  await unlock(A_NAME, A_OTP);
  await page.waitForSelector("#passcode-new", { timeout: 20000 });
  check(
    "A one-time pass opens the forced change step, not the app",
    page.url().endsWith("/profiles") && !(await page.$(".home")),
  );
  check("The forced step says Choose your passcode", (await page.evaluate(() => document.body.innerText)).includes("Choose your passcode"));

  await typeInto(page, `input[aria-label="New passcode for ${A_NAME}"]`, A_PERMA);
  await typeInto(page, `input[aria-label="Confirm passcode for ${A_NAME}"]`, A_PERMA);
  await clickText(page, "Save passcode");
  await waitHome();
  check("Choosing a passcode enters Home and issues a session", true);

  const afterChange = await api("adminList", { profileIds: [profileA.id] }, { admin: true });
  const rowA = afterChange.data.screens[profileA.id];
  check("Admin reads the passcode the user chose", rowA?.password === A_PERMA);
  check("The one-time state is cleared after the change", rowA?.mustChange === false);
  check("The admin ref name survives the user's change", rowA?.adminName === "zyn");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitHome();
  check("The new session survives a reload", true);

  const browserCookies = await page.cookies();
  const sessionValue = browserCookies.find((cookie) => cookie.name === "lighthook_session")?.value;
  const otherProfile = (await listProfiles()).find((profile) => profile.id !== profileA.id);
  if (sessionValue && otherProfile) {
    const cookieHeader = `lighthook_session=${sessionValue}`;
    const crossProbe = await api(
      "resume",
      { profileId: otherProfile.id },
      { cookie: cookieHeader },
    );
    const stillValid = await api("resume", { profileId: profileA.id }, { cookie: cookieHeader });
    check(
      "Probing another screen does not revoke the device's live session",
      crossProbe.status === 401 && stillValid.status === 200,
    );
  }

  /* ===================== 4. self-service change + cooldown ================ */

  step("self-service change");
  await goto(page, "/library", ".library-page");
  await clickSelector(page, `button[aria-label="Change passcode for ${A_NAME}"]`);
  await typeInto(page, `input[aria-label="Current passcode for ${A_NAME}"]`, A_PERMA);
  await typeInto(page, `input[aria-label="New passcode for ${A_NAME}"]`, A_SELF);
  await typeInto(page, `input[aria-label="Confirm new passcode for ${A_NAME}"]`, A_SELF);
  await clickText(page, "Save passcode");
  await page.waitForFunction(() => !document.querySelector(".library-sheet"), { timeout: 20000 });
  check("A user can change their passcode from Library", true);

  const selfChangedRow = await api(
    "adminList",
    { profileIds: [profileA.id] },
    { admin: true },
  );
  check(
    "Admin reads the passcode the user set themselves",
    selfChangedRow.data.screens[profileA.id]?.password === A_SELF &&
      selfChangedRow.data.screens[profileA.id]?.mustChange === false,
  );

  await clickSelector(page, `button[aria-label="Change passcode for ${A_NAME}"]`);
  await typeInto(page, `input[aria-label="Current passcode for ${A_NAME}"]`, A_SELF);
  await typeInto(page, `input[aria-label="New passcode for ${A_NAME}"]`, "perma-pass-55");
  await typeInto(page, `input[aria-label="Confirm new passcode for ${A_NAME}"]`, "perma-pass-55");
  await clickText(page, "Save passcode");
  await page.waitForFunction(
    () => document.querySelector(".library-sheet-error")?.textContent?.includes("once a week"),
    { timeout: 20000 },
  );
  check("A second change inside 7 days is blocked with cooldown copy", true);

  /* the key security claim: clearing the browser cannot reset the cooldown */
  step("cooldown after wipe");
  await wipeDevice();
  await unlock(A_NAME, A_SELF);
  await waitHome();
  await goto(page, "/library", ".library-page");
  await clickSelector(page, `button[aria-label="Change passcode for ${A_NAME}"]`);
  await typeInto(page, `input[aria-label="Current passcode for ${A_NAME}"]`, A_SELF);
  await typeInto(page, `input[aria-label="New passcode for ${A_NAME}"]`, "perma-pass-66");
  await typeInto(page, `input[aria-label="Confirm new passcode for ${A_NAME}"]`, "perma-pass-66");
  await clickText(page, "Save passcode");
  await page.waitForFunction(
    () => document.querySelector(".library-sheet-error")?.textContent?.includes("once a week"),
    { timeout: 20000 },
  );
  check("The weekly cooldown survives a full cookie/localStorage wipe", true);
  await page.keyboard.press("Escape");

  /* ===================== 5. kick on Home and mid-watch ==================== */

  step("kick on home");
  await adminLogin(adminPage);
  await goto(page, "/", ".home");
  await clickRowButton(adminPage, A_NAME, "Kick session");
  await clickRowButton(adminPage, A_NAME, "Confirm kick");
  await page.bringToFront();
  await page.waitForFunction(
    () => location.pathname === "/profiles" && Boolean(document.querySelector(".profiles-kicked")),
    { timeout: 30000 },
  );
  check("An admin kick sends an active Home screen back to the picker", true);
  check("The picker explains the admin sign-out", (await page.evaluate(() => document.body.innerText)).includes("signed out by the admin"));

  await unlock(A_NAME, A_SELF);
  await waitHome();
  step("kick mid-watch");
  await goto(page, "/watch/tv/1399?s=1&e=1", ".watch-stage");
  await clickRowButton(adminPage, A_NAME, "Kick session");
  await clickRowButton(adminPage, A_NAME, "Confirm kick");
  await page.bringToFront();
  await page.waitForFunction(
    () => location.pathname === "/profiles" && !document.querySelector(".watch-stage"),
    { timeout: 30000 },
  );
  check("An admin kick stops a movie and returns to the picker", true);

  await unlock(A_NAME, A_SELF);
  await waitHome();

  /* multi-select kick: capture live sessions, kick both screens from the UI */
  step("multi-select kick");
  const cookieA = (await api("verify", { profileId: profileA.id, password: A_SELF })).cookie;
  const cookieB = (await api("verify", { profileId: profileB.id, password: B_PASS })).cookie;
  check("Both QA screens have live sessions before the bulk kick", Boolean(cookieA && cookieB));

  await clickSelector(adminPage, `input[aria-label="Select ${A_NAME}"]`);
  await clickSelector(adminPage, `input[aria-label="Select ${B_NAME}"]`);
  await adminPage.waitForFunction(
    () => document.querySelector(".admin-kick-selected")?.textContent?.includes("(2)"),
    { timeout: 10000 },
  );
  await clickText(adminPage, "Kick selected (2)");
  await adminPage.waitForFunction(
    () =>
      document.querySelector(".admin-kick-selected")?.textContent?.includes("(0)") &&
      document.querySelectorAll(".admin-screen.is-selected").length === 0,
    { timeout: 20000 },
  );
  check("Multi-select kick clears the selection after firing", true);

  const kickedA = await api("resume", { profileId: profileA.id });
  const kickedB = await api("resume", { profileId: profileB.id });
  check(
    "Both screens' live sessions are rejected after the bulk kick",
    kickedA.status === 401 && kickedB.status === 401,
  );

  /* page 1 was one of the kicked screens — it must have bounced too */
  await page.bringToFront();
  await page.waitForFunction(() => location.pathname === "/profiles", { timeout: 30000 });
  check("The kicking admin's other tab also loses the kicked screen", true);

  await unlock(A_NAME, A_SELF);
  await waitHome();

  /* ===================== 6. admin ref edit ================================ */

  step("admin ref edit");
  await clickRowButton(adminPage, B_NAME, "Edit");
  await typeInto(adminPage, `input[aria-label="Admin ref name for ${B_NAME}"]`, "sc1-zyn");
  await clickText(adminPage, "Save details");
  await adminPage.waitForFunction(
    (name) =>
      [...document.querySelectorAll(".admin-screen")].some(
        (row) =>
          row.querySelector(".admin-screen-name")?.textContent?.trim() === name &&
          row.textContent?.includes("ref: sc1-zyn"),
      ),
    { timeout: 20000 },
    B_NAME,
  );
  check("Admin can edit the admin-only ref name inline", true);

  await goto(page, "/profiles", ".profiles-page");
  await dismissNotice();
  check(
    "The edited ref name stays off the picker",
    !(await page.evaluate(() => document.body.innerText)).includes("sc1-zyn"),
  );

  /* ===================== 7. history multi-select + sync =================== */

  step("history sync");
  // Screen A is still the active profile, so /library opens directly.
  await seedHistory(profileA.id, ["QA History One", "QA History Two", "QA History Three"]);
  await openHistory();
  await page.waitForFunction(
    () =>
      ["QA History One", "QA History Two", "QA History Three"].every((title) =>
        document.body.innerText.includes(title),
      ),
    { timeout: 30000 },
  );
  check("Seeded history appears in Library on this device", true);

  await clickText(page, "Select", ".library-shelf-actions");
  await clickSelector(page, 'input[aria-label="Select QA History One"]');
  await clickText(page, "Remove selected (1)");
  await clickText(page, "Remove", '[aria-label="Confirm removal"]');
  await page.waitForFunction(
    () => !document.body.innerText.includes("QA History One"),
    { timeout: 20000 },
  );
  check("One history item can be removed through multi-select", true);

  const afterOne = await waitForServerHistory(
    profileA.id,
    (snapshot) =>
      snapshot.tombstones.some((item) => item.title === "QA History One") &&
      !snapshot.live.some((item) => item.title === "QA History One"),
  );
  check(
    "The removed item is a tombstone on the server (not just hidden locally)",
    afterOne.tombstones.some((item) => item.title === "QA History One") &&
      !afterOne.live.some((item) => item.title === "QA History One"),
  );

  /* "second device": clear everything, sign in again, pull from the server */
  await wipeDevice();
  await unlock(A_NAME, A_SELF);
  await waitHome();
  await openHistory();
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("QA History One") &&
      document.body.innerText.includes("QA History Two") &&
      document.body.innerText.includes("QA History Three"),
    { timeout: 30000 },
  );
  check("History removal syncs to a wiped device", true);

  await clickText(page, "Select", ".library-shelf-actions");
  await clickText(page, "Select all");
  const selectedCount = await page.evaluate(
    () => document.querySelector(".library-select-count")?.textContent ?? "",
  );
  check("Select all selects every remaining entry", /[1-9]/.test(selectedCount), selectedCount.trim());
  await clickText(page, "Remove selected");
  await clickText(page, "Remove", '[aria-label="Confirm removal"]');
  await page.waitForFunction(
    () => document.body.innerText.includes("No history yet"),
    { timeout: 20000 },
  );
  check("Select all + remove clears the history", true);

  const cleared = await waitForServerHistory(
    profileA.id,
    (snapshot) => snapshot.live.length === 0,
  );
  check("Every history entry is tombstoned on the server", cleared.live.length === 0);

  await goto(page, "/", ".home");
  check(
    "Home no longer shows Continue watching after history is cleared",
    !(await page.evaluate(() => document.body.innerText)).includes("Continue watching"),
  );

  /* ===================== 8. passcode reset kicks the screen ============== */

  step("admin passcode reset kicks the screen");
  // The second-device wipe clears site data for the whole origin, including
  // the admin tab's sessionStorage key. Re-authenticate before using the console.
  await adminLogin(adminPage);
  await typeInto(adminPage, `input[aria-label="New password for ${A_NAME}"]`, "reset-pass-77");
  await clickSelector(adminPage, `input[aria-label="One-time passcode for ${A_NAME}"]`);
  await clickRowButton(adminPage, A_NAME, "Save");
  await adminPage.waitForFunction(
    (name) =>
      [...document.querySelectorAll(".admin-screen")].some(
        (row) =>
          row.querySelector(".admin-screen-name")?.textContent?.trim() === name &&
          row.querySelector(".admin-password-value")?.textContent?.trim() === "reset-pass-77" &&
          row.textContent?.includes("One-time · change pending"),
      ),
    { timeout: 20000 },
    A_NAME,
  );
  await page.bringToFront();
  await page.waitForFunction(
    () => location.pathname === "/profiles" && Boolean(document.querySelector(".profiles-kicked")),
    { timeout: 30000 },
  );
  check("Changing a passcode from admin signs the active screen out", true);

  await unlock(A_NAME, "reset-pass-77");
  await page.waitForSelector("#passcode-new", { timeout: 20000 });
  check("Admin can set a one-time pass on an existing screen", true);
  await typeInto(page, `input[aria-label="New passcode for ${A_NAME}"]`, "final-pass-99");
  await typeInto(page, `input[aria-label="Confirm passcode for ${A_NAME}"]`, "final-pass-99");
  await clickText(page, "Save passcode");
  await waitHome();
  const finalRow = await api("adminList", { profileIds: [profileA.id] }, { admin: true });
  check(
    "The one-time reset completes and the admin reads the final pass",
    finalRow.data.screens[profileA.id]?.password === "final-pass-99" &&
      finalRow.data.screens[profileA.id]?.mustChange === false,
  );

  /* ===================== 9. cleanup/regression sanity ==================== */

  check("No uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (error) {
  check("Run completed without exception", false, error.message);
  console.log(error.stack);
} finally {
  try {
    for (const profile of [profileA, profileB]) {
      if (profile) await removeProfile(profile);
    }
    await cleanupQaProfiles();
  } catch (error) {
    console.log(`cleanup warning: ${error.message}`);
  }
  await browser.close();
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  } catch {
    /* temp only */
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} feature checks passed.`);
process.exit(failed.length ? 1 : 0);
