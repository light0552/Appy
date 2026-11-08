import { useEffect } from "react";

/**
 * Keeps a running client on the bundle that is actually deployed.
 *
 * The build writes /version.json (see vite.config.ts). This watcher compares
 * that file with the version compiled into the running JS. On a mismatch it
 * refreshes the service worker and hard-reloads, so a deploy replaces the old
 * bundle even in an already-open tab and even during /watch playback.
 *
 * Everything here is fail-safe: if /version.json is absent (plain `vite dev`
 * or preview) or the network is down, the checks silently do nothing.
 */

/** sessionStorage key describing the last automatic reload attempt. */
const RELOAD_KEY = "lighthook:updateReload";

/** Poll cadence while the tab is visible. */
const POLL_MS = 60_000;

/** Minimum spacing between ad-hoc checks (focus + visibilitychange can pair up). */
const MIN_CHECK_GAP_MS = 5_000;

/** How long to wait for an updated service worker to take control. */
const SW_SETTLE_MS = 2_500;

/** A second mismatch for the same target inside this window means the reload failed. */
const LOOP_WINDOW_MS = 30_000;

/** Give up on a `/version.json` request after this long. */
const FETCH_TIMEOUT_MS = 10_000;

type ReloadRecord = {
  /** Version the reload was aimed at. */
  version: string;
  /** Epoch ms of the attempt. */
  at: number;
  /** True once the escalating hard reset has run for this version. */
  reset: boolean;
};

/** Cleared after the reload, so it lives in sessionStorage rather than memory. */
function readRecord(): ReloadRecord | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ReloadRecord).version === "string" &&
      typeof (parsed as ReloadRecord).at === "number" &&
      typeof (parsed as ReloadRecord).reset === "boolean"
    ) {
      return parsed as ReloadRecord;
    }
  } catch {
    // Storage disabled or corrupt value — treat as no attempt yet.
  }
  return null;
}

function writeRecord(record: ReloadRecord): void {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, JSON.stringify(record));
  } catch {
    // Private mode: the in-memory flags still prevent a same-page loop.
  }
}

function clearRecord(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/** True once this page has committed to an update; stops further checks. */
let stopped = false;

/** Guards against overlapping polls. */
let inFlight = false;

/** Timestamp of the last check, for de-duplicating focus/visibility events. */
let lastCheck = 0;

/**
 * Resolves when the new service worker has taken control (or became active),
 * or after `timeoutMs` — whichever comes first. Reloading before the new
 * worker activates would let the old precache serve the old bundle again.
 */
function waitForServiceWorkerSettle(
  registration: ServiceWorkerRegistration | null,
  timeoutMs: number,
): Promise<void> {
  const container = navigator.serviceWorker;
  if (!container) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let timer = 0;
    let detachWorker: (() => void) | null = null;

    const finish = () => {
      window.clearTimeout(timer);
      container.removeEventListener("controllerchange", finish);
      detachWorker?.();
      detachWorker = null;
      resolve();
    };

    timer = window.setTimeout(finish, timeoutMs);
    container.addEventListener("controllerchange", finish);

    const pending: ServiceWorker | null =
      registration?.installing ?? registration?.waiting ?? null;
    if (pending) {
      const onStateChange = () => {
        // autoUpdate workers call skipWaiting(), so "activated" is the point
        // where the new precache owns the next navigation. A waiting worker
        // that cannot activate simply falls through to the timeout.
        if (pending.state === "activated" || pending.state === "redundant") finish();
      };
      pending.addEventListener("statechange", onStateChange);
      detachWorker = () => pending.removeEventListener("statechange", onStateChange);
      onStateChange();
    }
  });
}

/**
 * Nuclear option for the case where a normal update reload comes back on the
 * old bundle again: drop every registration and cached response, then reload
 * from the network. Runs at most once per target version.
 */
async function hardReset(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch {
    // No SW support / registration API failure — caches are still cleared.
  }

  try {
    const keys = await window.caches.keys();
    await Promise.all(keys.map((key) => window.caches.delete(key)));
  } catch {
    // CacheStorage unavailable (or blocked) — the reload below still runs.
  }
}

/** Brings the service worker up to date before reloading. */
async function refreshServiceWorker(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return; // No SW: the reload alone fetches fresh assets.

    // Force a check of sw.js now instead of waiting for the browser's own
    // background schedule, then give the replacement worker time to activate.
    await registration.update().catch(() => undefined);
    await waitForServiceWorkerSettle(registration, SW_SETTLE_MS);
  } catch {
    // Any failure here is non-fatal: reloading still re-requests the bundle.
  }
}

/**
 * Reloads into `targetVersion`, escalating once to a full SW/cache reset if a
 * previous reload for the same version did not actually change the bundle.
 * A reload record in sessionStorage survives the reload and carries that state.
 */
async function forceUpdate(targetVersion: string): Promise<void> {
  if (stopped) return;
  stopped = true;

  const now = Date.now();
  const record = readRecord();

  if (record && record.version === targetVersion) {
    if (record.reset) {
      // The cache reset already ran and this page is still stale. Stop rather
      // than loop forever; the next deploy gets a fresh attempt.
      return;
    }
    if (now - record.at < LOOP_WINDOW_MS) {
      // The soft reload landed back on the old bundle: escalate exactly once.
      writeRecord({ version: targetVersion, at: now, reset: true });
      console.info(`[update] ${targetVersion} still stale after reload — clearing caches`);
      await hardReset();
      window.location.reload();
      return;
    }
  }

  // First attempt for this version (or an attempt stale by more than the loop
  // window): record it so a failing reload is detected, then reload.
  writeRecord({ version: targetVersion, at: now, reset: false });
  console.info(`[update] deploying ${targetVersion} over ${__BUILD_ID__}`);
  await refreshServiceWorker();
  window.location.reload();
}

/**
 * Reads /version.json and triggers the update flow on a mismatch. Missing file,
 * bad JSON, non-2xx and network errors are all ignored — those are the normal
 * conditions under `vite dev` and `vite preview`.
 */
async function checkVersion(): Promise<void> {
  if (stopped || inFlight) return;

  const now = Date.now();
  if (now - lastCheck < MIN_CHECK_GAP_MS) return;
  lastCheck = now;
  inFlight = true;

  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, {
      cache: "no-store",
      signal: abort.signal,
    });
    if (!response.ok) return;

    const data: unknown = await response.json();
    const version =
      typeof data === "object" &&
      data !== null &&
      typeof (data as { version?: unknown }).version === "string"
        ? (data as { version: string }).version
        : null;
    if (!version) return;

    if (version === __BUILD_ID__) {
      // Running the deployed bundle: any leftover loop guard is obsolete.
      clearRecord();
      return;
    }

    await forceUpdate(version);
  } catch {
    // Offline, aborted, or no version.json — nothing to do.
  } finally {
    window.clearTimeout(timer);
    inFlight = false;
  }
}

export default function UpdateWatcher(): null {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    // Only meaningful when the page was loaded *with* a controller. A first
    // install also fires controllerchange, and reloading then is pointless.
    const hadController = navigator.serviceWorker.controller !== null;

    const onFocus = () => {
      void checkVersion();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };

    /**
     * A new worker took control: the document is now a mix of the old bundle
     * and the new precache, so reload. The sessionStorage record keeps this
     * from bouncing when the reload was already initiated by forceUpdate.
     */
    const onControllerChange = () => {
      const now = Date.now();
      const record = readRecord();
      const recent = record !== null && now - record.at < LOOP_WINDOW_MS;

      if (recent) return; // An update attempt in this window already owns the reload.
      if (record?.reset) return; // Hard reset failed once; stop trying.

      writeRecord({ version: __BUILD_ID__, at: now, reset: false });
      console.info("[update] service worker changed control — reloading");
      window.location.reload();
    };

    void checkVersion(); // Mount check.

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    if (hadController) {
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    }

    // Slow poll for a tab that stays open and focused for a long time.
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkVersion();
    }, POLL_MS);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (hadController) {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      }
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
