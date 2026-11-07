import { kvGet, kvSet } from "./store";

/**
 * Household access control for the shelf.
 *
 * This is deliberately a local, app-level lock — not a hardened identity
 * system. Screen passwords live in the same private local store as the
 * watchlists (IndexedDB), and the admin password is a household secret.
 * The point is to stop a family member wandering onto another screen, not
 * to defend against someone with the device unlocked and devtools open.
 */

export const ADMIN_PASSWORD = "light0552";
export const DEFAULT_SCREEN_PASSWORD = "1234";
export const MAX_FAILED_ATTEMPTS = 3;
/** Shortest screen password the admin may set. */
export const MIN_SCREEN_PASSWORD_LENGTH = 4;
/** Longest screen password the admin may set. */
export const MAX_SCREEN_PASSWORD_LENGTH = 64;

export interface ProfileAuthRecord {
  profileId: string;
  password: string;
  failedAttempts: number;
  blocked: boolean;
  updatedAt: number;
}

export type ProfileAuthMap = Record<string, ProfileAuthRecord>;

export type ProfileAuthError = "wrong_password" | "blocked" | "missing";

export interface ProfileAuthResult {
  ok: boolean;
  blocked: boolean;
  failedAttempts: number;
  attemptsLeft: number;
  error?: ProfileAuthError;
}

export interface AdminCredential {
  profileId: string;
  name: string;
  color: string;
  password: string;
  failedAttempts: number;
  blocked: boolean;
}

const KEY_AUTH = "auth:v1";
const ADMIN_SESSION_KEY = "lighthook:adminSession";
const UNLOCK_PREFIX = "lighthook:unlocked:";

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

export async function loadAuthMap(): Promise<ProfileAuthMap> {
  const stored = await kvGet<ProfileAuthMap>(KEY_AUTH);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const map: ProfileAuthMap = {};
  for (const [id, record] of Object.entries(stored)) {
    if (!record || typeof record !== "object") continue;
    const value = record as Partial<ProfileAuthRecord>;
    if (typeof value.password !== "string") continue;
    map[id] = {
      profileId: id,
      password: value.password,
      failedAttempts:
        typeof value.failedAttempts === "number" && value.failedAttempts >= 0
          ? Math.floor(value.failedAttempts)
          : 0,
      blocked: value.blocked === true,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    };
  }
  return map;
}

export async function saveAuthMap(map: ProfileAuthMap): Promise<void> {
  await kvSet(KEY_AUTH, map);
}

export function makeAuthRecord(
  profileId: string,
  password = DEFAULT_SCREEN_PASSWORD,
): ProfileAuthRecord {
  return {
    profileId,
    password,
    failedAttempts: 0,
    blocked: false,
    updatedAt: Date.now(),
  };
}

/**
 * Seeds a password for every screen that does not have one yet, and drops
 * auth records for screens that no longer exist. Called after the profile
 * index is reconciled so a new screen always has a working password.
 */
export async function ensureAuthSeeds(profileIds: string[]): Promise<ProfileAuthMap> {
  const map = await loadAuthMap();
  const ids = new Set(profileIds);
  let changed = false;

  for (const id of profileIds) {
    if (!map[id]) {
      map[id] = makeAuthRecord(id);
      changed = true;
    }
  }

  for (const id of Object.keys(map)) {
    if (!ids.has(id)) {
      delete map[id];
      changed = true;
    }
  }

  if (changed) await saveAuthMap(map);
  return map;
}

/** Copies a screen's password when a pending local screen is adopted by the server. */
export async function migrateAuthRecord(
  oldId: string,
  newId: string,
): Promise<ProfileAuthMap> {
  const map = await loadAuthMap();
  const old = map[oldId];
  if (!old) return map;
  map[newId] = { ...old, profileId: newId, updatedAt: Date.now() };
  delete map[oldId];
  await saveAuthMap(map);
  return map;
}

export function verifyAdminPassword(password: string): boolean {
  return password === ADMIN_PASSWORD;
}

export function hasAdminSession(): boolean {
  return sessionGet(ADMIN_SESSION_KEY) === "1";
}

export function setAdminSession(active: boolean): void {
  sessionSet(ADMIN_SESSION_KEY, active ? "1" : null);
}

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
 * Verifies a screen password. The third wrong attempt blocks the screen;
 * a blocked screen cannot be retried until an admin unblocks it.
 */
export async function verifyProfilePassword(
  profileId: string,
  password: string,
): Promise<{ result: ProfileAuthResult; map: ProfileAuthMap }> {
  const map = await loadAuthMap();
  const record = map[profileId] ?? makeAuthRecord(profileId);

  if (record.blocked) {
    map[profileId] = record;
    return {
      result: {
        ok: false,
        blocked: true,
        failedAttempts: record.failedAttempts,
        attemptsLeft: 0,
        error: "blocked",
      },
      map,
    };
  }

  if (password === record.password) {
    record.failedAttempts = 0;
    record.updatedAt = Date.now();
    map[profileId] = record;
    await saveAuthMap(map);
    setProfileUnlocked(profileId, true);
    return {
      result: {
        ok: true,
        blocked: false,
        failedAttempts: 0,
        attemptsLeft: MAX_FAILED_ATTEMPTS,
      },
      map,
    };
  }

  record.failedAttempts += 1;
  record.updatedAt = Date.now();
  if (record.failedAttempts >= MAX_FAILED_ATTEMPTS) record.blocked = true;
  map[profileId] = record;
  await saveAuthMap(map);
  setProfileUnlocked(profileId, false);

  return {
    result: {
      ok: false,
      blocked: record.blocked,
      failedAttempts: record.failedAttempts,
      attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - record.failedAttempts),
      error: record.blocked ? "blocked" : "wrong_password",
    },
    map,
  };
}

export async function adminSetPassword(
  profileId: string,
  password: string,
): Promise<ProfileAuthMap> {
  const map = await loadAuthMap();
  const record = map[profileId] ?? makeAuthRecord(profileId);
  map[profileId] = {
    ...record,
    profileId,
    password: password.slice(0, MAX_SCREEN_PASSWORD_LENGTH),
    failedAttempts: 0,
    blocked: false,
    updatedAt: Date.now(),
  };
  await saveAuthMap(map);
  setProfileUnlocked(profileId, false);
  return map;
}

export async function adminUnblock(profileId: string): Promise<ProfileAuthMap> {
  const map = await loadAuthMap();
  const record = map[profileId] ?? makeAuthRecord(profileId);
  map[profileId] = {
    ...record,
    profileId,
    failedAttempts: 0,
    blocked: false,
    updatedAt: Date.now(),
  };
  await saveAuthMap(map);
  return map;
}

export async function adminAddRecord(
  profileId: string,
  password = DEFAULT_SCREEN_PASSWORD,
): Promise<ProfileAuthMap> {
  const map = await loadAuthMap();
  map[profileId] = makeAuthRecord(
    profileId,
    password.slice(0, MAX_SCREEN_PASSWORD_LENGTH),
  );
  await saveAuthMap(map);
  return map;
}

export async function adminRemoveRecord(profileId: string): Promise<ProfileAuthMap> {
  const map = await loadAuthMap();
  delete map[profileId];
  await saveAuthMap(map);
  setProfileUnlocked(profileId, false);
  return map;
}

export function credentialsFrom(
  profiles: ReadonlyArray<{ id: string; name: string; color: string }>,
  map: ProfileAuthMap,
): AdminCredential[] {
  return profiles.map((profile) => {
    const record = map[profile.id] ?? makeAuthRecord(profile.id);
    return {
      profileId: profile.id,
      name: profile.name,
      color: profile.color,
      password: record.password,
      failedAttempts: record.failedAttempts,
      blocked: record.blocked,
    };
  });
}
