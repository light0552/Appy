import type { HistoryItem, ProfilePrefs, ProfileState, Stamped, WatchItem } from "../types";

const DB_NAME = "lighthook";
const DB_VERSION = 1;
const STORE_NAME = "kv";
const LS_PREFIX = "lighthook:";
/** Opening IndexedDB (or running a transaction on it) can hang forever in
 *  broken/private-mode browsers; these bounds guarantee the app boots anyway. */
const IDB_OPEN_TIMEOUT_MS = 3000;
const IDB_OP_TIMEOUT_MS = 1500;

export const KEY_PROFILES = "profiles";
export const KEY_ACTIVE = "activeProfile";

export function stateKey(profileId: string): string {
  return `state:${profileId}`;
}

/* ------------------------------------------------------------------ */
/* IndexedDB with localStorage + memory fallbacks                      */
/* ------------------------------------------------------------------ */

function timeoutValue<T>(ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    setTimeout(() => resolve(fallback), ms);
  });
}

/**
 * The in-memory Map always succeeds and is checked first/last as appropriate.
 * Once IndexedDB fails or times out it is demoted to `null` for the rest of the
 * session so subsequent reads/writes go straight to localStorage/memory instead
 * of repeatedly paying the timeout — and so a stale IndexedDB value can never
 * shadow a fresher localStorage/memory write made during the outage.
 */
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    let settled = false;
    const done = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => done(null), IDB_OPEN_TIMEOUT_MS);

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgraded the DB: close and forget this connection so the
        // next operation reopens (or falls back) instead of failing forever.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        done(db);
      };
      request.onerror = () => done(null);
      request.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
  return dbPromise;
}

function demoteDb(): void {
  dbPromise = Promise.resolve(null);
}

/** Resolves `{ ok: false }` on any failure/timeout so callers can fall back. */
function idbGet<T>(db: IDBDatabase, key: string): Promise<{ ok: boolean; value?: T }> {
  const work = new Promise<{ ok: boolean; value?: T }>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve({ ok: true, value: req.result as T | undefined });
      req.onerror = () => resolve({ ok: false });
      tx.onabort = () => resolve({ ok: false });
    } catch {
      resolve({ ok: false });
    }
  });
  return Promise.race([work, timeoutValue(IDB_OP_TIMEOUT_MS, { ok: false })]);
}

/** Resolves true on commit, false on any failure/timeout. */
async function idbSet(db: IDBDatabase, key: string, value: unknown): Promise<boolean> {
  const work = new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  return Promise.race([work, timeoutValue(IDB_OP_TIMEOUT_MS, false)]);
}

/** Resolves true on commit, false on any failure/timeout. */
async function idbDelete(db: IDBDatabase, key: string): Promise<boolean> {
  const work = new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  return Promise.race([work, timeoutValue(IDB_OP_TIMEOUT_MS, false)]);
}

function lsGet<T>(key: string): T | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function lsSet(key: string, value: unknown): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    /* quota or private mode — memory copy is still authoritative for this session */
    return false;
  }
}

const memory = new Map<string, unknown>();

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (db) {
    const result = await idbGet<T>(db, key);
    if (result.ok) {
      if (result.value !== undefined) return result.value;
    } else {
      // Stop trusting a failing IndexedDB this session.
      demoteDb();
    }
  }
  const local = lsGet<T>(key);
  if (local !== undefined) return local;
  return memory.get(key) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  memory.set(key, value);
  const db = await openDb();
  if (db) {
    const ok = await idbSet(db, key, value);
    if (ok) return;
    demoteDb();
  }
  lsSet(key, value);
}

export async function kvDel(key: string): Promise<void> {
  memory.delete(key);
  const db = await openDb();
  if (db) {
    const ok = await idbDelete(db, key);
    if (!ok) demoteDb();
  }
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(LS_PREFIX + key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Profile state                                                       */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drops records with unusable merge keys so corrupt local data can't crash the merge. */
function sanitizeStoredRecords<T extends Stamped>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is T =>
      isPlainObject(entry) &&
      typeof entry.id === "string" &&
      entry.id.length > 0 &&
      typeof entry.updatedAt === "number" &&
      Number.isFinite(entry.updatedAt),
  );
}

export function emptyState(profileId: string): ProfileState {
  return { profileId, watchlist: [], history: [], prefs: {}, updatedAt: 0 };
}

export async function loadState(profileId: string): Promise<ProfileState> {
  const stored = await kvGet<ProfileState>(stateKey(profileId));
  if (!stored || stored.profileId !== profileId) return emptyState(profileId);
  return {
    profileId,
    watchlist: sanitizeStoredRecords<WatchItem>(stored.watchlist),
    history: sanitizeStoredRecords<HistoryItem>(stored.history),
    prefs: isPlainObject(stored.prefs) ? (stored.prefs as ProfilePrefs) : {},
    updatedAt:
      typeof stored.updatedAt === "number" && Number.isFinite(stored.updatedAt)
        ? stored.updatedAt
        : 0,
  };
}

export async function saveState(state: ProfileState): Promise<void> {
  await kvSet(stateKey(state.profileId), state);
}

export function touch(state: ProfileState, at = Date.now()): ProfileState {
  return { ...state, updatedAt: at };
}

/* ------------------------------------------------------------------ */
/* Keys + merging                                                      */
/* ------------------------------------------------------------------ */

export function mediaKey(type: "movie" | "tv", tmdbId: number): string {
  return `${type}:${tmdbId}`;
}

export function historyKey(
  type: "movie" | "tv",
  tmdbId: number,
  season?: number,
  episode?: number,
): string {
  if (type === "tv" && typeof season === "number" && typeof episode === "number") {
    return `tv:${tmdbId}:${season}:${episode}`;
  }
  return `${type}:${tmdbId}`;
}

/** Newest record per id wins. Ties keep the first list (remote) per BUILD.md §7. */
export function mergeById<T extends Stamped>(local: T[], remote: T[]): T[] {
  const out = new Map<string, T>();
  for (const record of [...remote, ...local]) {
    const prev = out.get(record.id);
    if (!prev || record.updatedAt > prev.updatedAt) out.set(record.id, record);
  }
  return [...out.values()];
}

/**
 * Prefs with a higher providerPrefsVersion win wholesale, so an old device
 * pushing a stale preferred server cannot undo the one-time provider migration.
 * Equal versions merge normally (remote last), preserving theme/edit behavior.
 */
function mergePrefs(local: ProfilePrefs, remote: ProfilePrefs): ProfilePrefs {
  const localVersion = local.providerPrefsVersion ?? 0;
  const remoteVersion = remote.providerPrefsVersion ?? 0;
  if (localVersion > remoteVersion) return { ...remote, ...local };
  return { ...local, ...remote };
}

export function mergeStates(local: ProfileState, remote: ProfileState): ProfileState {
  return {
    profileId: local.profileId,
    watchlist: mergeById<WatchItem>(local.watchlist, remote.watchlist),
    history: mergeById<HistoryItem>(local.history, remote.history),
    prefs: mergePrefs(local.prefs, remote.prefs),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

/** Drops tombstones from anything rendered in the UI. */
export function live<T extends Stamped>(items: T[]): T[] {
  return items.filter((item) => !item.deletedAt);
}

export function liveWatchlist(state: ProfileState): WatchItem[] {
  return live(state.watchlist).sort((a, b) => b.addedAt - a.addedAt);
}

export function liveHistory(state: ProfileState): HistoryItem[] {
  return live(state.history).sort((a, b) => b.watchedAt - a.watchedAt);
}
