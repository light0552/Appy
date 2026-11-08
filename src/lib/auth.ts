import { kvGet, kvSet } from "./store";

/**
 * Household access control for the shelf.
 *
 * Passwords are owned by the server (/api/auth): scrypt hashes in Netlify
 * Blobs, never plaintext in this bundle. The client keeps only a status
 * snapshot (blocked / failed attempts / hasPassword) for the UI, and the admin
 * password for the tab, so a screen lock survives clearing browser storage.
 *
 * Screen unlocks remain a tab-level convenience flag in sessionStorage — that
 * is not a credential, just "this tab already passed the prompt".
 */

export const DEFAULT_SCREEN_PASSWORD = "1234";
export const MAX_FAILED_ATTEMPTS = 3;
/** Shortest screen password the admin may set. */
export const MIN_SCREEN_PASSWORD_LENGTH = 4;
/** Longest screen password the admin may set. */
export const MAX_SCREEN_PASSWORD_LENGTH = 64;

export interface ProfileAuthRecord {
  profileId: string;
  failedAttempts: number;
  blocked: boolean;
  updatedAt: number;
  hasPassword: boolean;
  /** Plaintext is only present on admin-read responses (adminList). */
  password?: string | null;
}

export type ProfileAuthMap = Record<string, ProfileAuthRecord>;

export type ProfileAuthError = "wrong_password" | "blocked" | "missing" | "unreachable";

export interface ProfileAuthResult {
  ok: boolean;
  blocked: boolean;
  failedAttempts: number;
  attemptsLeft: number;
  /** Present on a successful verify; also mirrored into the device token store. */
  token?: string;
  error?: ProfileAuthError;
}

export interface AdminCredential {
  profileId: string;
  name: string;
  color: string;
  failedAttempts: number;
  blocked: boolean;
  hasPassword: boolean;
  password: string;
}

const ENDPOINT = "/api/auth";
const FAMILY_KEY =
  (import.meta.env.VITE_FAMILY_KEY as string | undefined)?.trim() || "samandmellu";
const REQUEST_TIMEOUT_MS = 10_000;

const ADMIN_KEY_STORAGE = "lighthook:adminKey";
const UNLOCK_PREFIX = "lighthook:unlocked:";
const DEVICE_PREFIX = "lighthook:device:";

/** Legacy local records (plaintext passwords) migrated once to the server. */
const LEGACY_AUTH_KEY = "auth:v1";
const MIGRATED_KEY = "auth:migrated:v1";

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — the in-memory context still works */
  }
}

/* Device tokens live in localStorage: "stay signed in until sign-out or a
   cache wipe", while the admin session stays per-tab in sessionStorage. */

function localGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage disabled — the token simply does not persist */
  }
}

function deviceKey(profileId: string): string {
  return DEVICE_PREFIX + profileId;
}

const REMEMBERED_PREFIX = "lighthook:remembered:";
const SIGNED_OUT_PREFIX = "lighthook:signedOut:";

/** Non-sensitive UI hint: "this device has a server session for this screen". */
export function isRemembered(profileId: string): boolean {
  return localGet(REMEMBERED_PREFIX + profileId) === "1";
}

function markRemembered(profileId: string): void {
  localSet(REMEMBERED_PREFIX + profileId, "1");
}

function clearRemembered(profileId: string): void {
  localSet(REMEMBERED_PREFIX + profileId, null);
}

export function hasDeviceToken(profileId: string): boolean {
  const token = localGet(deviceKey(profileId));
  return typeof token === "string" && token.length >= 20;
}

export function clearDeviceToken(profileId: string): void {
  localSet(deviceKey(profileId), null);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/** The service could not answer (offline, timeout, 5xx) — not a rejection. */
class AuthUnreachableError extends Error {
  constructor() {
    super("The auth service is unreachable.");
    this.name = "AuthUnreachableError";
  }
}

interface CodedError extends Error {
  code: string;
  status?: number;
}

function codedError(code: string, message: string, status?: number): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(err: unknown): string | null {
  if (err instanceof Error && typeof (err as CodedError).code === "string") {
    return (err as CodedError).code;
  }
  return null;
}

/**
 * POSTs an action to /api/auth. Every request carries the household family
 * key; admin actions additionally carry the admin password from sessionStorage,
 * which is also where the server keeps the only copy of the hash.
 */
async function call(
  body: Record<string, unknown>,
  options: { admin?: boolean } = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-family-key": FAMILY_KEY,
  };

  if (options.admin) {
    const adminKey = getAdminKey();
    if (!adminKey) throw codedError("admin_required", "Admin sign-in required.");
    headers["x-admin-key"] = adminKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new AuthUnreachableError();
  } finally {
    clearTimeout(timer);
  }

  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (isRecord(parsed)) data = parsed;
  } catch {
    /* non-JSON body — handled by the status check below */
  }

  if (!res.ok) {
    // An expired/absent admin key is a sign-in problem, not a generic failure.
    if (options.admin && res.status === 401) {
      throw codedError("admin_required", "Admin sign-in required.", 401);
    }
    if (res.status >= 500) throw new AuthUnreachableError();
    const code = typeof data.error === "string" ? data.error : `http_${res.status}`;
    throw codedError(code, `Auth request failed (${res.status}).`, res.status);
  }

  return data;
}

/* ------------------------------------------------------------------ */
/* Status mapping                                                      */
/* ------------------------------------------------------------------ */

function toCount(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Converts the server's public screen status into the client map. A returned
 * screen always has a hash on the server (status seeds it), so `hasPassword`
 * is true for every entry. Plaintext never exists in this shape.
 */
function mapFromScreens(screens: unknown, now = Date.now()): ProfileAuthMap {
  const map: ProfileAuthMap = {};
  if (!isRecord(screens)) return map;

  for (const [id, raw] of Object.entries(screens)) {
    if (!isRecord(raw)) continue;
    map[id] = {
      profileId: id,
      failedAttempts: toCount(raw.failedAttempts),
      blocked: raw.blocked === true,
      updatedAt: now,
      // Every screen has a passcode; the server stores it as a hash. A record
      // exists here because status returned it, so this is always true.
      hasPassword: true,
      password: typeof raw.password === "string" ? raw.password : null,
    };
  }
  return map;
}

/** Last map handed to a caller — used only to keep UI state during an outage. */
let lastKnownMap: ProfileAuthMap = {};

function remember(map: ProfileAuthMap): ProfileAuthMap {
  lastKnownMap = map;
  return map;
}

/* ------------------------------------------------------------------ */
/* Screen status / verification                                        */
/* ------------------------------------------------------------------ */

/**
 * Fetches blocked/failed-attempt state for the given screens. On any service
 * failure this returns an empty map so boot proceeds into the picker instead
 * of crashing — a screen prompt will retry when the user acts.
 */
export async function loadAuthMap(profileIds: string[]): Promise<ProfileAuthMap> {
  try {
    const data = await call({ action: "status", profileIds });
    const map = mapFromScreens(data.screens);
    // A screen the server has never seen still has the default passcode. The
    // UI should say "stored on server", not "no passcode", until an admin
    // changes it (the first verify creates the record).
    const now = Date.now();
    for (const id of profileIds) {
      if (!map[id]) {
        map[id] = {
          profileId: id,
          failedAttempts: 0,
          blocked: false,
          updatedAt: now,
          hasPassword: true,
        };
      }
    }
    return remember(map);
  } catch {
    return {};
  }
}

/**
 * Server-side status seeds a default-password record for every known screen,
 * so ensuring seeds is just reading status. Same name is kept for callers.
 */
export async function ensureAuthSeeds(profileIds: string[]): Promise<ProfileAuthMap> {
  return loadAuthMap(profileIds);
}

function resultFromVerify(data: Record<string, unknown>): ProfileAuthResult {
  const ok = data.ok === true;
  const blocked = data.blocked === true;
  const failedAttempts = toCount(data.failedAttempts);
  const attemptsLeft =
    typeof data.attemptsLeft === "number" && Number.isFinite(data.attemptsLeft)
      ? Math.max(0, Math.floor(data.attemptsLeft))
      : Math.max(0, MAX_FAILED_ATTEMPTS - failedAttempts);

  const serverError = typeof data.error === "string" ? data.error : null;
  const error: ProfileAuthError | undefined = ok
    ? undefined
    : serverError === "blocked" || blocked
      ? "blocked"
      : "wrong_password";

  const token = typeof data.token === "string" && data.token.length >= 20 ? data.token : undefined;

  return { ok, blocked, failedAttempts, attemptsLeft, ...(token ? { token } : {}), ...(error ? { error } : {}) };
}

/**
 * Verifies a screen password. The server owns the attempt counter: the third
 * wrong attempt blocks the screen until an admin releases it.
 */
export async function verifyProfilePassword(
  profileId: string,
  password: string,
): Promise<{ result: ProfileAuthResult; map: ProfileAuthMap }> {
  try {
    const data = await call({ action: "verify", profileId, password });
    const result = resultFromVerify(data);

    // Fold this screen's fresh state into the last full snapshot so callers
    // replacing their authMap do not lose every other screen's status.
    const map: ProfileAuthMap = {
      ...lastKnownMap,
      [profileId]: {
        profileId,
        failedAttempts: result.failedAttempts,
        blocked: result.blocked,
        updatedAt: Date.now(),
        hasPassword: true,
      },
    };
    remember(map);

    setProfileUnlocked(profileId, result.ok);
    if (result.ok) {
      // The server set the HttpOnly cookie; no JS-readable token is kept.
      clearDeviceToken(profileId);
      localSet(SIGNED_OUT_PREFIX + profileId, null);
      markRemembered(profileId);
    } else if (result.blocked) {
      clearDeviceToken(profileId);
      clearRemembered(profileId);
    }
    return { result, map };
  } catch (err) {
    const code = errorCode(err);
    const isMissing = code === "invalid_profile" || code === "invalid_password";

    // Best-effort snapshot for the UI; never throws, and falls back to the
    // in-memory map when the service is still unreachable.
    const fetched = await loadAuthMap([profileId]);
    const map = Object.keys(fetched).length > 0 ? fetched : { ...lastKnownMap };

    return {
      result: {
        ok: false,
        blocked: false,
        failedAttempts: 0,
        attemptsLeft: MAX_FAILED_ATTEMPTS,
        error: isMissing ? "missing" : "unreachable",
      },
      map,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Persistent device unlock                                            */
/* ------------------------------------------------------------------ */

/**
 * Tries to resume a profile from its stored device token. This is what makes
 * closing Brave/Chrome and reopening land straight in the profile without a
 * passcode, while a password change / block / sign-out revokes the token.
 */
export async function resumeProfile(profileId: string): Promise<boolean> {
  // An explicit sign-out wins even if the network was down and the server
  // cookie could not be cleared: stay signed out until a passcode is entered.
  if (localGet(SIGNED_OUT_PREFIX + profileId) === "1") {
    clearRemembered(profileId);
    return false;
  }

  // The session lives in an HttpOnly cookie, so always ask the server. A
  // localStorage token from the previous release is sent once for migration.
  const legacyToken = localGet(deviceKey(profileId));

  try {
    const data = await call({
      action: "resume",
      profileId,
      ...(legacyToken && legacyToken.length >= 20 ? { token: legacyToken } : {}),
    });
    if (data.ok !== true) {
      clearDeviceToken(profileId);
      clearRemembered(profileId);
      return false;
    }
    clearDeviceToken(profileId);
    markRemembered(profileId);
    setProfileUnlocked(profileId, true);
    return true;
  } catch (err) {
    const code = errorCode(err);
    // A real rejection means the cookie/token is dead. A transport failure
    // keeps everything for the next attempt.
    if (code !== null && code !== "offline" && code !== "timeout") {
      clearDeviceToken(profileId);
      clearRemembered(profileId);
    }
    return false;
  }
}

/** Revokes this device's session server-side, then forgets it locally. */
export async function revokeDeviceToken(profileId: string): Promise<void> {
  const legacyToken = localGet(deviceKey(profileId));
  clearDeviceToken(profileId);
  clearRemembered(profileId);
  localSet(SIGNED_OUT_PREFIX + profileId, "1");
  try {
    await call({
      action: "revoke",
      profileId,
      ...(legacyToken && legacyToken.length >= 20 ? { token: legacyToken } : {}),
    });
  } catch {
    /* best effort — the signed-out flag blocks resume even if this failed */
  }
}

/* ------------------------------------------------------------------ */
/* Admin session + admin-only actions                                  */
/* ------------------------------------------------------------------ */

export async function verifyAdminPassword(password: string): Promise<boolean> {
  try {
    const data = await call({ action: "adminLogin", password });
    return data.ok === true;
  } catch {
    return false;
  }
}

export function setAdminKey(key: string | null): void {
  const trimmed = key?.trim() ?? "";
  sessionSet(ADMIN_KEY_STORAGE, trimmed.length > 0 ? trimmed : null);
}

export function getAdminKey(): string | null {
  const key = sessionGet(ADMIN_KEY_STORAGE);
  return key && key.length > 0 ? key : null;
}

export function hasAdminSession(): boolean {
  return getAdminKey() !== null;
}

/** Runs an admin-only action and returns the full screen status it carries. */
async function adminCall(body: Record<string, unknown>): Promise<ProfileAuthMap> {
  const data = await call(body, { admin: true });
  return remember(mapFromScreens(data.screens));
}

/**
 * Admin-only readback of every screen passcode. The server decrypts its
 * encrypted copy with a key derived from the admin password on this request.
 */
export async function loadAdminPasswords(profileIds: string[] = []): Promise<ProfileAuthMap> {
  return adminCall({ action: "adminList", profileIds });
}

export async function adminSetPassword(
  profileId: string,
  password: string,
): Promise<ProfileAuthMap> {
  const map = await adminCall({
    action: "adminSet",
    profileId,
    password: password.slice(0, MAX_SCREEN_PASSWORD_LENGTH),
  });
  setProfileUnlocked(profileId, false);
  clearDeviceToken(profileId);
  clearRemembered(profileId);
  return map;
}

export async function adminUnblock(profileId: string): Promise<ProfileAuthMap> {
  return adminCall({ action: "adminUnblock", profileId });
}

export async function adminAddRecord(
  profileId: string,
  password = DEFAULT_SCREEN_PASSWORD,
): Promise<ProfileAuthMap> {
  const map = await adminCall({
    action: "adminAdd",
    profileId,
    password: password.slice(0, MAX_SCREEN_PASSWORD_LENGTH),
  });
  setProfileUnlocked(profileId, false);
  return map;
}

export async function adminRemoveRecord(profileId: string): Promise<ProfileAuthMap> {
  const map = await adminCall({ action: "adminRemove", profileId });
  setProfileUnlocked(profileId, false);
  clearDeviceToken(profileId);
  clearRemembered(profileId);
  return map;
}

/* ------------------------------------------------------------------ */
/* Legacy migration                                                    */
/* ------------------------------------------------------------------ */

/**
 * Pushes passwords that only exist in this device's old local records to the
 * server. The server skips any screen it already has, so a rerun can never
 * overwrite a newer password. Best-effort: returns 0 on any failure and only
 * marks the migration complete once the server accepted the batch.
 */
export async function migrateLegacyAuth(): Promise<number> {
  try {
    if (await kvGet<boolean>(MIGRATED_KEY)) return 0;

    const stored = await kvGet<Record<string, unknown>>(LEGACY_AUTH_KEY);
    if (!isRecord(stored)) return 0;

    const screens: Array<{ profileId: string; password: string }> = [];
    for (const [profileId, raw] of Object.entries(stored)) {
      if (!isRecord(raw)) continue;
      const password = typeof raw.password === "string" ? raw.password.trim() : "";
      if (
        password.length < MIN_SCREEN_PASSWORD_LENGTH ||
        password.length > MAX_SCREEN_PASSWORD_LENGTH
      ) {
        continue;
      }
      screens.push({ profileId, password });
    }

    if (screens.length === 0) {
      await kvSet(MIGRATED_KEY, true);
      return 0;
    }
    if (!hasAdminSession()) return 0;

    const data = await call(
      { action: "migrate", screens: screens.slice(0, 50) },
      { admin: true },
    );
    const migrated = toCount(data.migrated, screens.length);
    await kvSet(MIGRATED_KEY, true);
    return migrated;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Screen credentials for the admin UI                                 */
/* ------------------------------------------------------------------ */

export function credentialsFrom(
  profiles: ReadonlyArray<{ id: string; name: string; color: string }>,
  map: ProfileAuthMap,
): AdminCredential[] {
  return profiles.map((profile) => {
    const record = map[profile.id];
    return {
      profileId: profile.id,
      name: profile.name,
      color: profile.color,
      failedAttempts: record?.failedAttempts ?? 0,
      blocked: record?.blocked ?? false,
      hasPassword: record?.hasPassword ?? false,
      password: record?.password ?? "",
    };
  });
}

/* ------------------------------------------------------------------ */
/* Tab-local unlock flags                                              */
/* ------------------------------------------------------------------ */

export function isProfileUnlocked(profileId: string): boolean {
  return sessionGet(UNLOCK_PREFIX + profileId) === "1";
}

export function setProfileUnlocked(profileId: string, unlocked: boolean): void {
  sessionSet(UNLOCK_PREFIX + profileId, unlocked ? "1" : null);
}

export function clearAllProfileUnlocks(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(UNLOCK_PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Carries the tab unlock across a server-assigned id change when a pending
 * local screen is adopted. Passwords are not involved — the server has them.
 */
export async function migrateAuthRecord(
  oldId: string,
  newId: string,
): Promise<ProfileAuthMap> {
  if (isProfileUnlocked(oldId)) {
    setProfileUnlocked(newId, true);
    setProfileUnlocked(oldId, false);
  }
  return { ...lastKnownMap };
}
