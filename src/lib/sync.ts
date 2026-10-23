import type { ProfileMeta, ProfileState } from "../types";

const FAMILY_KEY =
  (import.meta.env.VITE_FAMILY_KEY as string | undefined)?.trim() || "samandmellu";
const ENDPOINT = "/api/profiles";

export interface SyncStatus {
  online: boolean;
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = "error") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let status: SyncStatus = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  syncing: false,
  lastSyncedAt: null,
  error: null,
};

const listeners = new Set<(next: SyncStatus) => void>();

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener(status);
}

export function getStatus(): SyncStatus {
  return status;
}

export function subscribeStatus(listener: (next: SyncStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The sync service could not answer the request at all. Covers a transport-level
 * failure (fetch rejects — `TypeError`, or our synthesized status 0) and any HTTP
 * 5xx from our own `/api/profiles` endpoint, e.g. the dev proxy replying 500 when
 * no function backend is running under plain `npm run dev`. All of these mean the
 * service is unavailable and must degrade to local-only, unlike a 4xx, which is a
 * meaningful rejection from a server that did answer.
 */
function isServiceUnavailable(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (!(err instanceof ApiError)) return false;
  return err.status === 0 || err.status >= 500;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "offline":
        return "Offline — changes saved on this device.";
      case "forbidden":
        return "Family passphrase rejected.";
      case "profile_limit":
        return "Profile limit reached.";
      case "name_required":
        return "Enter a name first.";
      default:
        return `Sync failed (${err.status || err.code}).`;
    }
  }
  return "Offline — changes saved on this device.";
}

function handleError(err: unknown): void {
  if (isServiceUnavailable(err)) {
    // No usable answer from the sync service — degrade to local-only.
    setStatus({ online: false, error: "Offline — changes saved on this device." });
  } else if (err instanceof ApiError) {
    // The server answered (4xx rejection): we are online, the request was refused.
    setStatus({ online: true, error: describe(err) });
  } else {
    setStatus({ error: describe(err) });
  }
}

async function request<T>(query: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}${query}`, {
      ...init,
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-family-key": FAMILY_KEY,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError("The sync service is unreachable.", 0, "offline");
  }

  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) code = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(`Sync request failed (${res.status}).`, res.status, code);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

export async function fetchProfiles(): Promise<ProfileMeta[] | null> {
  try {
    const data = await request<{ profiles: ProfileMeta[] }>("");
    setStatus({ online: true, error: null });
    // A 200 whose body is not an array is a malformed answer, NOT an empty
    // index: returning [] here would erase every local-only profile the next
    // time the caller persists this list. `null` means "remote unknown".
    return Array.isArray(data?.profiles) ? data.profiles : null;
  } catch (err) {
    handleError(err);
    return null;
  }
}

function isProfileMeta(value: unknown): value is ProfileMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProfileMeta).id === "string" &&
    typeof (value as ProfileMeta).name === "string"
  );
}

/**
 * A 2xx whose body lacks `profile` would otherwise yield `undefined`, which the
 * caller writes straight into the profiles array and the UI then dereferences
 * (`profile.name`) — a white screen. Status 0 classifies as service-unavailable,
 * so the throw lands in the caller's offline path, which is the correct outcome.
 */
function requireProfile(value: unknown): ProfileMeta {
  if (!isProfileMeta(value)) {
    throw new ApiError("Malformed response from the sync service.", 0, "malformed");
  }
  return value;
}

export async function createProfileRemote(name: string, color?: string): Promise<ProfileMeta> {
  try {
    const data = await request<{ profile?: unknown }>("", {
      method: "POST",
      body: JSON.stringify({ name, color }),
    });
    setStatus({ online: true, error: null });
    return requireProfile(data?.profile);
  } catch (err) {
    handleError(err);
    throw err;
  }
}

export async function updateProfileRemote(
  id: string,
  patch: { name?: string; color?: string },
): Promise<ProfileMeta> {
  try {
    const data = await request<{ profile?: unknown }>(`?id=${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ meta: patch }),
    });
    setStatus({ online: true, error: null });
    return requireProfile(data?.profile);
  } catch (err) {
    handleError(err);
    throw err;
  }
}

export async function deleteProfileRemote(id: string): Promise<void> {
  try {
    await request<{ ok: boolean }>(`?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setStatus({ online: true, error: null });
  } catch (err) {
    handleError(err);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* State pull / push                                                   */
/* ------------------------------------------------------------------ */

export async function pullState(profileId: string): Promise<ProfileState> {
  return request<ProfileState>(`?id=${encodeURIComponent(profileId)}`);
}

export async function pushState(
  state: ProfileState,
  includePrefs = false,
): Promise<ProfileState> {
  const body: Record<string, unknown> = {
    watchlist: state.watchlist,
    history: state.history,
  };
  if (includePrefs) body.prefs = state.prefs;

  const data = await request<ProfileState>(`?id=${encodeURIComponent(state.profileId)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  setStatus({ online: true, lastSyncedAt: Date.now(), error: null });
  return data;
}

/* ------------------------------------------------------------------ */
/* Debounced push queue                                                */
/* ------------------------------------------------------------------ */

interface PendingPush {
  state: ProfileState;
  includePrefs: boolean;
}

let pushTimer: number | null = null;
// One slot PER PROFILE: switching profiles (or failing a flush) must never
// overwrite another profile's unsent edits.
const pendingByProfile = new Map<string, PendingPush>();

export function queuePush(state: ProfileState, includePrefs = false): void {
  const existing = pendingByProfile.get(state.profileId);
  pendingByProfile.set(state.profileId, {
    state,
    includePrefs: (existing?.includePrefs ?? false) || includePrefs,
  });
  if (pushTimer !== null) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    void flushPush();
  }, 2000);
}

export async function flushPush(): Promise<void> {
  if (pushTimer !== null) {
    window.clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (pendingByProfile.size === 0) return;

  // Clear first: edits queued while this flush is in flight must not be
  // clobbered. Failed entries are re-queued below.
  const snapshot = [...pendingByProfile.entries()];
  pendingByProfile.clear();

  setStatus({ syncing: true });
  let firstError: unknown = null;

  for (const [profileId, entry] of snapshot) {
    try {
      await pushState(entry.state, entry.includePrefs);
    } catch (err) {
      if (firstError === null) firstError = err;
      // Keep the payload so the next flush can retry after reconnecting.
      const queued = pendingByProfile.get(profileId);
      if (queued) {
        // A newer edit for this profile arrived while we were in flight — it
        // supersedes this payload; only the prefs flag needs carrying over.
        pendingByProfile.set(profileId, {
          state: queued.state,
          includePrefs: queued.includePrefs || entry.includePrefs,
        });
      } else {
        pendingByProfile.set(profileId, entry);
      }
    }
  }

  if (firstError === null) {
    setStatus({ syncing: false, lastSyncedAt: Date.now() });
  } else {
    handleError(firstError);
    setStatus({ syncing: false });
  }
}

export function cancelPush(): void {
  if (pushTimer !== null) {
    window.clearTimeout(pushTimer);
    pushTimer = null;
  }
  pendingByProfile.clear();
}

/**
 * Drops any queued push for a profile. Called before a delete so a pending
 * push can never resurrect `profiles/<id>.json` after the profile is removed.
 */
export function dropPending(id: string): void {
  pendingByProfile.delete(id);
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * Pulls on mount, whenever the app returns to the foreground, and when the network
 * comes back. The caller merges the remote snapshot into its local copy.
 */
export function startSync(
  profileId: string,
  onRemote: (remote: ProfileState) => void,
): () => void {
  let stopped = false;
  let running = false;

  const pull = async () => {
    if (stopped || running) return;
    running = true;
    setStatus({ syncing: true });
    try {
      const remote = await pullState(profileId);
      if (stopped) return;
      setStatus({ syncing: false, online: true, error: null, lastSyncedAt: Date.now() });
      onRemote(remote);
    } catch (err) {
      if (stopped) return;
      handleError(err);
      setStatus({ syncing: false });
    } finally {
      running = false;
    }
  };

  void pull();

  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      void pull();
      void flushPush();
    } else {
      void flushPush();
    }
  };
  const onOnline = () => {
    setStatus({ online: true });
    void pull();
    void flushPush();
  };
  const onOffline = () => {
    setStatus({ online: false, error: "Offline — changes saved on this device." });
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  const interval = window.setInterval(() => {
    if (document.visibilityState === "visible") void pull();
  }, 60_000);

  return () => {
    stopped = true;
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
