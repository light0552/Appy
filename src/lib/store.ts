import type { HistoryItem, ProfileState, Stamped, WatchItem } from "../types";

const DB_NAME = "lighthook";
const DB_VERSION = 1;
const STORE_NAME = "kv";
const LS_PREFIX = "lighthook:";

export const KEY_PROFILES = "profiles";
export const KEY_ACTIVE = "activeProfile";
export const KEY_PENDING = "pendingProfiles";

export function stateKey(profileId: string): string {
  return `state:${profileId}`;
}

/* ------------------------------------------------------------------ */
/* IndexedDB with localStorage + memory fallbacks                      */
/* ------------------------------------------------------------------ */

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function lsGet<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota or private mode — memory copy below is still authoritative for this session */
  }
}

const memory = new Map<string, unknown>();

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (db) {
    try {
      const value = await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      });
      if (value !== undefined) return value;
    } catch {
      /* fall through */
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
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return;
    } catch {
      /* fall through */
    }
  }
  lsSet(key, value);
}

export async function kvDel(key: string): Promise<void> {
  memory.delete(key);
  const db = await openDb();
  if (db) {
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* fall through */
    }
  }
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Profile state                                                       */
/* ------------------------------------------------------------------ */

export function emptyState(profileId: string): ProfileState {
  return { profileId, watchlist: [], history: [], prefs: {}, updatedAt: 0 };
}

export async function loadState(profileId: string): Promise<ProfileState> {
  const stored = await kvGet<ProfileState>(stateKey(profileId));
  if (!stored || stored.profileId !== profileId) return emptyState(profileId);
  return {
    profileId,
    watchlist: Array.isArray(stored.watchlist) ? stored.watchlist : [],
    history: Array.isArray(stored.history) ? stored.history : [],
    prefs: stored.prefs ?? {},
    updatedAt: stored.updatedAt ?? 0,
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

export function mergeStates(local: ProfileState, remote: ProfileState): ProfileState {
  return {
    profileId: local.profileId,
    watchlist: mergeById<WatchItem>(local.watchlist, remote.watchlist),
    history: mergeById<HistoryItem>(local.history, remote.history),
    prefs: { ...local.prefs, ...remote.prefs },
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
