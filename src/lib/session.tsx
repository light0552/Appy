import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  HistoryItem,
  Media,
  ProfileMeta,
  ProfilePrefs,
  ProfileState,
  WatchItem,
} from "../types";
import {
  emptyState,
  historyKey,
  KEY_ACTIVE,
  kvDel,
  kvGet,
  kvSet,
  loadState,
  mediaKey,
  mergeStates,
  saveState,
  stateKey,
  touch,
} from "./store";
import {
  MAX_PROFILES,
  loadProfiles,
  makeLocalProfile,
  saveProfiles,
  updateLocalProfile,
} from "./profiles";
import * as auth from "./auth";
import type { ProfileAuthMap, ProfileAuthResult } from "./auth";
import * as sync from "./sync";
import type { SyncStatus } from "./sync";

const KEY_PENDING_CREATES = "pendingProfiles";
const KEY_PENDING_DELETES = "pendingDeletes";
const KEY_PENDING_META = "pendingProfileMeta";

/** Rename/recolour patches that have not reached the server yet, by profile id. */
type PendingMeta = Record<string, { name?: string; color?: string }>;

type AddProfileResult =
  | { ok: true; profile: ProfileMeta }
  | { ok: false; error: string };

/** Error surfaced when an admin-only action is attempted without a valid key. */
function adminRequiredError(): Error {
  const error = new Error("Admin sign-in required.") as Error & { code: string };
  error.code = "admin_required";
  return error;
}

export interface SessionValue {
  ready: boolean;
  profiles: ProfileMeta[];
  activeProfile: ProfileMeta | null;
  state: ProfileState;
  syncStatus: SyncStatus;
  authMap: ProfileAuthMap;
  adminAuthed: boolean;
  chooseProfile: (id: string) => Promise<void>;
  unlockProfile: (id: string, password: string) => Promise<ProfileAuthResult>;
  /** Passwordless resume from a stored device token; false when it is gone. */
  resumeProfile: (id: string) => Promise<boolean>;
  /** Completes a forced first-login change for a one-time pass, then enters. */
  completePasswordChange: (
    profileId: string,
    newPassword: string,
    changeToken: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Self-service passcode change; the server enforces the weekly cooldown. */
  changePassword: (
    profileId: string,
    currentPassword: string,
    newPassword: string,
  ) => Promise<{ ok: boolean; error?: string; retryAt?: number }>;
  signOut: () => void;
  loginAdmin: (password: string) => Promise<boolean>;
  logoutAdmin: () => void;
  /** Admin-only screen management. Nothing else may add/remove/rename a screen. */
  adminSetProfilePassword: (
    id: string,
    password: string,
    temporary?: boolean,
  ) => Promise<void>;
  adminUnblockProfile: (id: string) => Promise<void>;
  adminRenameProfile: (
    id: string,
    patch: { name?: string; color?: string; adminName?: string },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  adminAddProfile: (
    name: string,
    color: string | undefined,
    password: string,
    options?: { adminName?: string; temporary?: boolean },
  ) => Promise<AddProfileResult>;
  adminDeleteProfile: (id: string) => Promise<void>;
  /** Rotates the server session epoch for one or many screens. */
  adminKickProfiles: (ids: string[]) => Promise<void>;
  addToWatchlist: (media: Media) => void;
  removeFromWatchlist: (id: string) => void;
  isInWatchlist: (id: string) => boolean;
  recordHistory: (media: Media, opts?: { season?: number; episode?: number }) => void;
  /** Marks history entries deleted and syncs the tombstones to every device. */
  removeHistory: (ids: string[]) => void;
  setPrefs: (patch: Partial<ProfilePrefs>) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * True when the merged state still holds something the remote snapshot lacks:
 * a length mismatch means at least one side has records the other does not, and
 * the pairwise probe catches "local has records the remote lacks" even when the
 * state-level timestamps are equal (another device pushed a newer state while
 * our offline records were still unsent — equal `updatedAt`, different content).
 */
function hasUnpushedRecords(local: ProfileState, remote: ProfileState): boolean {
  if (local.watchlist.length !== remote.watchlist.length) return true;
  if (local.history.length !== remote.history.length) return true;
  return recordsDiffer(local.watchlist, remote.watchlist) || recordsDiffer(local.history, remote.history);
}

function recordsDiffer<T extends { id: string; updatedAt: number }>(local: T[], remote: T[]): boolean {
  const remoteById = new Map<string, T>();
  for (const record of remote) remoteById.set(record.id, record);
  for (const record of local) {
    const other = remoteById.get(record.id);
    if (!other || record.updatedAt > other.updatedAt) return true;
  }
  return false;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setState] = useState<ProfileState>(() => emptyState(""));
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => sync.getStatus());
  const [authMap, setAuthMap] = useState<ProfileAuthMap>({});
  const [adminAuthed, setAdminAuthed] = useState(() => auth.hasAdminSession());

  const profilesRef = useRef<ProfileMeta[]>([]);
  const stateRef = useRef<ProfileState>(state);
  const pendingCreates = useRef<Set<string>>(new Set());
  const pendingDeletes = useRef<Set<string>>(new Set());

  const applyProfiles = useCallback(async (next: ProfileMeta[]) => {
    profilesRef.current = next;
    setProfiles(next);
    await saveProfiles(next);
  }, []);

  /**
   * Re-applies queued offline rename/recolour patches (KEY_PENDING_META) onto a
   * remote-derived list BEFORE it is persisted, so a refresh can never revert an
   * edit that has not reached the server. Each patch is then pushed: the entry is
   * dropped only once it lands on the server (or the profile is gone), so an
   * unsynced patch stays queued for the next boot/refresh. Profiles still awaiting
   * adoption carry their meta in the create payload, so those are applied locally
   * and dropped without a push.
   */
  const applyPendingMeta = useCallback(
    async (list: ProfileMeta[]): Promise<ProfileMeta[]> => {
      const queued = (await kvGet<PendingMeta>(KEY_PENDING_META)) ?? {};
      const entries = Object.entries(queued);
      if (entries.length === 0) return list;

      const next = [...list];
      const remaining: PendingMeta = {};

      for (const [id, patch] of entries) {
        const index = next.findIndex((profile) => profile.id === id);
        if (index === -1) continue; // profile removed — nothing left to apply or sync

        const profile = next[index];
        next[index] = {
          ...profile,
          name: patch.name?.trim() ? patch.name.trim().slice(0, 24) : profile.name,
          color: patch.color ?? profile.color,
        };

        if (pendingCreates.current.has(id)) continue; // adoption pushes the meta

        try {
          next[index] = await sync.updateProfileRemote(id, patch);
        } catch {
          remaining[id] = patch; // still unsynced — retry on the next boot/refresh
        }
      }

      await kvSet(KEY_PENDING_META, remaining);
      return next;
    },
    [],
  );

  /* ---------------------------------------------------------------- */
  /* Boot: local index + remote index reconciliation                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let alive = true;

    (async () => {
      const local = await loadProfiles();
      const [storedCreates, storedDeletes] = await Promise.all([
        kvGet<string[]>(KEY_PENDING_CREATES),
        kvGet<string[]>(KEY_PENDING_DELETES),
      ]);
      // StrictMode's cleanup+remount lands within the same task as this mount:
      // exit with zero side effects so the second run boots exactly once and no
      // duplicate server profiles are created from the same stale snapshot.
      if (!alive) return;
      pendingCreates.current = new Set(storedCreates ?? []);
      pendingDeletes.current = new Set(storedDeletes ?? []);

      const remote = await sync.fetchProfiles();
      // Everything past this point mutates the server — re-check before going on.
      if (!alive) return;
      let list = local;

      if (remote) {
        const remoteIds = new Set(remote.map((profile) => profile.id));
        const working = remote.slice();

        // Adopt profiles that were created while this device was offline.
        for (const profile of local) {
          if (remoteIds.has(profile.id) || !pendingCreates.current.has(profile.id)) continue;
          try {
            const created = await sync.createProfileRemote(profile.name, profile.color);
            await auth.migrateAuthRecord(profile.id, created.id);
            // The profile's id changed — carry its active slot over, or the user
            // is silently bounced to the picker on every launch (Finding 13).
            const currentActive = await kvGet<string>(KEY_ACTIVE);
            if (currentActive === profile.id) await kvSet(KEY_ACTIVE, created.id);
            const old = await loadState(profile.id);
            await saveState({ ...old, profileId: created.id });
            await kvDel(stateKey(profile.id));
            pendingCreates.current.delete(profile.id);
            working.push(created);
            remoteIds.add(created.id);
          } catch {
            working.push(profile);
          }
        }

        // Retry deletes that were queued while offline — deletes must actually stick.
        for (const id of [...pendingDeletes.current]) {
          try {
            await sync.deleteProfileRemote(id);
            pendingDeletes.current.delete(id);
          } catch (err) {
            if (err instanceof sync.ApiError && err.status === 404) {
              pendingDeletes.current.delete(id);
            }
          }
        }

        list = working.filter((profile) => !pendingDeletes.current.has(profile.id));
      }

      if (!alive) return;
      // Apply queued offline renames/recolours before this list is persisted.
      const withMeta = await applyPendingMeta(list);
      if (!alive) return;
      await applyProfiles(withMeta);
      await kvSet(KEY_PENDING_CREATES, [...pendingCreates.current]);
      await kvSet(KEY_PENDING_DELETES, [...pendingDeletes.current]);

      const nextAuth = auth.hasAdminSession()
        ? await auth.loadAdminPasswords(profilesRef.current.map((profile) => profile.id)).catch(() => auth.ensureAuthSeeds(withMeta.map((profile) => profile.id)))
        : await auth.ensureAuthSeeds(withMeta.map((profile) => profile.id));
      if (!alive) return;
      setAuthMap(nextAuth);

      const storedActive = await kvGet<string>(KEY_ACTIVE);
      let active =
        storedActive && auth.isProfileUnlocked(storedActive)
          ? withMeta.find(
              (profile) => profile.id === storedActive && !nextAuth[profile.id]?.blocked,
            )
          : undefined;

      // Closing the browser clears sessionStorage but not the HttpOnly session
      // cookie. Try the server resume for the last active profile; the cookie
      // is sent automatically.
      if (!active && storedActive) {
        const candidate = withMeta.find(
          (profile) => profile.id === storedActive && !nextAuth[profile.id]?.blocked,
        );
        if (candidate && (await auth.resumeProfile(storedActive))) {
          active = candidate;
        }
      }

      if (active) {
        const stored = await loadState(active.id);
        if (!alive) return;
        stateRef.current = stored;
        setState(stored);
        setActiveId(active.id);
      } else {
        await kvDel(KEY_ACTIVE);
      }

      if (alive) setReady(true);
    })().catch(() => {
      if (alive) setReady(true);
    });

    return () => {
      alive = false;
    };
  }, [applyProfiles, applyPendingMeta]);

  /* ---------------------------------------------------------------- */
  /* Sync status + active-profile lifecycle                            */
  /* ---------------------------------------------------------------- */

  useEffect(() => sync.subscribeStatus(setSyncStatus), []);

  useEffect(() => {
    if (!activeId) return;

    return sync.startSync(activeId, (remote) => {
      const merged = mergeStates(stateRef.current, remote);
      stateRef.current = merged;
      setState(merged);
      void saveState(merged);
      // Local holds something the server lacks (or a newer copy of) — converge
      // the other device. Equal state-level timestamps with differing content
      // still need a push: another device's newer state does not carry records
      // this one created offline.
      if (merged.updatedAt > remote.updatedAt || hasUnpushedRecords(merged, remote)) {
        sync.queuePush(merged);
      }
    });
  }, [activeId]);

  useEffect(() => {
    if (!ready) return;

    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      // Captured BEFORE the fetch: a local profile created after this moment
      // cannot be in the snapshot we are about to receive, so its absence from
      // remote proves nothing and it must never be dropped.
      const startedAt = Date.now();
      const remote = await sync.fetchProfiles();
      if (!remote) return;

      const working = remote.filter((profile) => !pendingDeletes.current.has(profile.id));

      for (const profile of profilesRef.current) {
        if (working.some((candidate) => candidate.id === profile.id)) continue;
        if (!pendingCreates.current.has(profile.id)) continue;
        try {
          const created = await sync.createProfileRemote(profile.name, profile.color);
          await auth.migrateAuthRecord(profile.id, created.id);
          // Carry the active slot across the id migration, or the user bounces
          // to the picker on every launch (Finding 13).
          const currentActive = await kvGet<string>(KEY_ACTIVE);
          if (currentActive === profile.id) await kvSet(KEY_ACTIVE, created.id);
          const old = await loadState(profile.id);
          await saveState({ ...old, profileId: created.id });
          await kvDel(stateKey(profile.id));
          pendingCreates.current.delete(profile.id);
          working.push(created);
        } catch {
          working.push(profile);
        }
      }

      // Keep every local profile created after the snapshot was taken. Only
      // profiles that predate `startedAt`, are absent from remote, and are not
      // pending adoption may be dropped (deleted on another device).
      for (const profile of profilesRef.current) {
        if (working.some((candidate) => candidate.id === profile.id)) continue;
        if (profile.createdAt >= startedAt) working.push(profile);
      }

      // Apply queued offline renames/recolours before this list is persisted.
      const withMeta = await applyPendingMeta(working);
      await applyProfiles(withMeta);
      setAuthMap(
        auth.hasAdminSession()
          ? await auth.loadAdminPasswords(profilesRef.current.map((profile) => profile.id)).catch(() => auth.ensureAuthSeeds(withMeta.map((profile) => profile.id)))
          : await auth.ensureAuthSeeds(withMeta.map((profile) => profile.id)),
      );
    };

    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [ready, applyProfiles, applyPendingMeta]);

  // If the active profile is deleted on another device, drop back to the picker.
  useEffect(() => {
    if (!ready || !activeId) return;
    if (profiles.some((profile) => profile.id === activeId)) return;

    void kvDel(KEY_ACTIVE);
    setActiveId(null);
    stateRef.current = emptyState("");
    setState(emptyState(""));
  }, [ready, profiles, activeId]);

  /* ---------------------------------------------------------------- */
  /* Profile actions                                                   */
  /* ---------------------------------------------------------------- */

  const chooseProfile = useCallback(async (id: string) => {
    // Flush the outgoing profile's queued edits first; the per-profile queue
    // means the incoming profile's edits can never overwrite them.
    void sync.flushPush();
    const profile = profilesRef.current.find((candidate) => candidate.id === id);
    if (!profile) return;

    const stored = await loadState(id);
    stateRef.current = stored;
    setState(stored);
    setActiveId(id);
    await kvSet(KEY_ACTIVE, id);
  }, []);

  const unlockProfile = useCallback(
    async (id: string, password: string): Promise<ProfileAuthResult> => {
      const { result, map } = await auth.verifyProfilePassword(id, password);
      setAuthMap({ ...map });
      // A one-time pass must not enter the app; Profiles shows the forced
      // change step and calls completePasswordChange next.
      if (result.ok && !result.mustChange) await chooseProfile(id);
      return result;
    },
    [chooseProfile],
  );

  /** Passwordless resume for a device that already has a valid token. */
  const resumeProfile = useCallback(
    async (id: string): Promise<boolean> => {
      const ok = await auth.resumeProfile(id);
      if (ok) await chooseProfile(id);
      return ok;
    },
    [chooseProfile],
  );

  const completePasswordChange = useCallback(
    async (
      profileId: string,
      newPassword: string,
      changeToken: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      const result = await auth.completePasswordChange(
        profileId,
        newPassword,
        changeToken,
      );
      if (result.ok) await chooseProfile(profileId);
      return result;
    },
    [chooseProfile],
  );

  const changePassword = useCallback(
    async (
      profileId: string,
      currentPassword: string,
      newPassword: string,
    ): Promise<{ ok: boolean; error?: string; retryAt?: number }> => {
      return auth.changePassword(profileId, currentPassword, newPassword);
    },
    [],
  );

  const signOut = useCallback(() => {
    void sync.flushPush();
    if (activeId) {
      auth.setProfileUnlocked(activeId, false);
      void auth.revokeDeviceToken(activeId);
    }
    setActiveId(null);
    stateRef.current = emptyState("");
    setState(emptyState(""));
    void kvDel(KEY_ACTIVE);
  }, [activeId]);

  const addProfile = useCallback(
    async (name: string, color?: string): Promise<AddProfileResult> => {
      const trimmed = name.trim();
      if (!trimmed) return { ok: false, error: "Enter a name first." };
      if (profilesRef.current.length >= MAX_PROFILES) {
        return { ok: false, error: `Profile limit reached (${MAX_PROFILES}).` };
      }

      try {
        const profile = await sync.createProfileRemote(trimmed, color);
        await applyProfiles([...profilesRef.current, profile]);
        return { ok: true, profile };
      } catch (err) {
        if (err instanceof sync.ApiError && err.status === 409) {
          return { ok: false, error: `Profile limit reached (${MAX_PROFILES}).` };
        }
        if (err instanceof sync.ApiError && err.status === 403) {
          return { ok: false, error: "The server rejected the family passphrase." };
        }

        // Offline: create locally and adopt it on the server next time we connect.
        const profile = makeLocalProfile(trimmed, color);
        pendingCreates.current.add(profile.id);
        await kvSet(KEY_PENDING_CREATES, [...pendingCreates.current]);
        await applyProfiles([...profilesRef.current, profile]);
        return { ok: true, profile };
      }
    },
    [applyProfiles],
  );

  const updateProfile = useCallback(
    async (id: string, patch: { name?: string; color?: string }) => {
      // Any patch that failed to sync earlier must go up together with this one,
      // or the server would keep the stale half of the edit.
      const queued = (await kvGet<PendingMeta>(KEY_PENDING_META)) ?? {};
      const merged: { name?: string; color?: string } = { ...queued[id], ...patch };
      // A blank name is rejected by the server — never queue it, or it would be
      // retried (and fail) on every boot and refresh forever.
      if (merged.name !== undefined && merged.name.trim().length === 0) delete merged.name;

      try {
        const updated = await sync.updateProfileRemote(id, merged);
        if (queued[id]) {
          const remaining = { ...queued };
          delete remaining[id];
          await kvSet(KEY_PENDING_META, remaining);
        }
        await applyProfiles(
          profilesRef.current.map((profile) => (profile.id === id ? updated : profile)),
        );
      } catch {
        // Offline: keep the edit locally AND queue it — without the queue the
        // next boot or online refresh would rebuild the index from the remote
        // copy (old name/colour) and silently discard the edit.
        if (merged.name !== undefined || merged.color !== undefined) {
          const nextQueue: PendingMeta = { ...queued, [id]: merged };
          await kvSet(KEY_PENDING_META, nextQueue);
        }
        const next = await updateLocalProfile(id, merged);
        await applyProfiles(next);
      }
    },
    [applyProfiles],
  );

  const deleteProfile = useCallback(
    async (id: string) => {
      // Drop any queued push for this profile first, so a pending flush can
      // never resurrect profiles/<id>.json after the delete.
      sync.dropPending(id);
      try {
        await sync.deleteProfileRemote(id);
      } catch (err) {
        if (!(err instanceof sync.ApiError) || err.status !== 404) {
          pendingDeletes.current.add(id);
          await kvSet(KEY_PENDING_DELETES, [...pendingDeletes.current]);
        }
      }

      await kvDel(stateKey(id));
      await applyProfiles(profilesRef.current.filter((profile) => profile.id !== id));

      if (activeId === id) {
        setActiveId(null);
        stateRef.current = emptyState("");
        setState(emptyState(""));
        await kvDel(KEY_ACTIVE);
      }
    },
    [activeId, applyProfiles],
  );

  /* ---------------------------------------------------------------- */
  /* Admin / screen access                                             */
  /* ---------------------------------------------------------------- */

  const loginAdmin = useCallback(async (password: string): Promise<boolean> => {
    const ok = await auth.verifyAdminPassword(password);
    if (!ok) return false;

    // The password doubles as the x-admin-key for this tab only.
    auth.setAdminKey(password);

    // One-time push of passwords that only ever lived in this device's old
    // records. Best-effort: a failure must not block a valid sign-in.
    try {
      await auth.migrateLegacyAuth();
    } catch {
      /* migration retries after a later sign-in */
    }

    // Load the readable passcodes BEFORE flipping to the dashboard, so the
    // registry never renders a frame of "Unavailable".
    try {
      setAuthMap(await auth.loadAdminPasswords(profilesRef.current.map((profile) => profile.id)));
    } catch {
      /* keep the status-only map; the registry will fill in on the next refresh */
    }
    setAdminAuthed(true);
    return true;
  }, []);

  const logoutAdmin = useCallback(() => {
    auth.setAdminKey(null);
    setAdminAuthed(false);
  }, []);

  const adminSetProfilePassword = useCallback(
    async (id: string, password: string, temporary = false) => {
      const trimmed = password.trim();
      if (!trimmed) return;
      await auth.adminSetPassword(id, trimmed, temporary);
      auth.clearDeviceToken(id);
      setAuthMap(await auth.loadAdminPasswords(profilesRef.current.map((profile) => profile.id)));
    },
    [],
  );

  const adminUnblockProfile = useCallback(async (id: string) => {
    await auth.adminUnblock(id);
    setAuthMap(await auth.loadAdminPasswords(profilesRef.current.map((profile) => profile.id)));
  }, []);

  /**
   * Admin-only rename/recolour/ref-label. Name and colour go to the profiles
   * API (visible to everyone); adminName goes to the auth record and is only
   * ever returned to an admin-authenticated caller.
   */
  const adminRenameProfile = useCallback(
    async (
      id: string,
      patch: { name?: string; color?: string; adminName?: string },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const trimmedName = patch.name?.trim();
      if (trimmedName !== undefined && trimmedName.length === 0) {
        return { ok: false, error: "A screen needs a name." };
      }
      if (trimmedName !== undefined && trimmedName.length > 24) {
        return { ok: false, error: "Names are capped at 24 characters." };
      }
      if (patch.adminName !== undefined && patch.adminName.trim().length > 48) {
        return { ok: false, error: "Reference names are capped at 48 characters." };
      }

      try {
        if (trimmedName !== undefined || patch.color !== undefined) {
          await updateProfile(id, {
            ...(trimmedName !== undefined ? { name: trimmedName } : {}),
            ...(patch.color !== undefined ? { color: patch.color } : {}),
          });
        }
        if (patch.adminName !== undefined) {
          await auth.adminSetRefName(id, patch.adminName);
        }
        setAuthMap(await auth.loadAdminPasswords(profilesRef.current.map((profile) => profile.id)));
        return { ok: true };
      } catch {
        return { ok: false, error: "Couldn't update that screen." };
      }
    },
    [updateProfile],
  );

  const adminAddProfile = useCallback(
    async (
      name: string,
      color: string | undefined,
      password: string,
      options: { adminName?: string; temporary?: boolean } = {},
    ): Promise<AddProfileResult> => {
      // Check before creating anything: the screen would otherwise be left on
      // the server with no password the admin asked for.
      if (!auth.hasAdminSession()) throw adminRequiredError();

      const result = await addProfile(name, color);
      if (result.ok) {
        await auth.adminAddRecord(
          result.profile.id,
          password.trim() || auth.DEFAULT_SCREEN_PASSWORD,
          options,
        );
        setAuthMap(await auth.loadAdminPasswords(profilesRef.current.map((profile) => profile.id)));
      }
      return result;
    },
    [addProfile],
  );

  const adminKickProfiles = useCallback(
    async (ids: string[]) => {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return;
      setAuthMap(await auth.adminKick(unique));

      // Kicking the screen this tab is using signs it out immediately as well;
      // other devices are caught by SessionGuard within one poll.
      if (activeId && unique.includes(activeId)) {
        auth.clearLocalSession(activeId);
        setActiveId(null);
        stateRef.current = emptyState("");
        setState(emptyState(""));
        await kvDel(KEY_ACTIVE);
      }
    },
    [activeId],
  );

  const adminDeleteProfile = useCallback(
    async (id: string) => {
      // Same ordering concern: removing the screen first and only then failing
      // the auth cleanup would leave a screen whose password nobody can manage.
      if (!auth.hasAdminSession()) throw adminRequiredError();

      await deleteProfile(id);
      await auth.adminRemoveRecord(id);
      setAuthMap(await auth.loadAdminPasswords(profilesRef.current.map((profile) => profile.id)));
    },
    [deleteProfile],
  );

  /* ---------------------------------------------------------------- */
  /* Watchlist / history / prefs                                       */
  /* ---------------------------------------------------------------- */

  const commit = useCallback(
    (
      updater: (prev: ProfileState) => ProfileState,
      includePrefs = false,
      flush = false,
    ) => {
      if (!activeId) return;
      const next = touch(updater(stateRef.current));
      stateRef.current = next;
      setState(next);
      void saveState(next).then(() => {
        sync.queuePush(next, includePrefs);
        // History tombstones should reach the server immediately so other
        // devices cannot re-merge a title the user just removed.
        if (flush) void sync.flushPush();
      });
    },
    [activeId],
  );

  const addToWatchlist = useCallback(
    (media: Media) => {
      const id = mediaKey(media.type, media.tmdbId);
      commit((prev) => {
        if (prev.watchlist.some((item) => item.id === id && !item.deletedAt)) return prev;
        const now = Date.now();
        const item: WatchItem = {
          id,
          mediaType: media.type,
          tmdbId: media.tmdbId,
          imdbId: media.imdbId,
          title: media.title,
          posterPath: media.posterPath,
          addedAt: now,
          updatedAt: now,
        };
        return {
          ...prev,
          watchlist: [item, ...prev.watchlist.filter((entry) => entry.id !== id)],
        };
      });
    },
    [commit],
  );

  const removeFromWatchlist = useCallback(
    (id: string) => {
      commit((prev) => {
        if (!prev.watchlist.some((item) => item.id === id)) return prev;
        const now = Date.now();
        return {
          ...prev,
          watchlist: prev.watchlist.map((item) =>
            item.id === id ? { ...item, deletedAt: now, updatedAt: now } : item,
          ),
        };
      });
    },
    [commit],
  );

  const isInWatchlist = useCallback(
    (id: string) => state.watchlist.some((item) => item.id === id && !item.deletedAt),
    [state.watchlist],
  );

  const recordHistory = useCallback(
    (media: Media, opts?: { season?: number; episode?: number }) => {
      const id = historyKey(media.type, media.tmdbId, opts?.season, opts?.episode);
      const now = Date.now();
      commit((prev) => {
        const item: HistoryItem = {
          id,
          mediaType: media.type,
          tmdbId: media.tmdbId,
          imdbId: media.imdbId,
          title: media.title,
          posterPath: media.posterPath,
          season: opts?.season,
          episode: opts?.episode,
          watchedAt: now,
          updatedAt: now,
        };
        return {
          ...prev,
          history: [item, ...prev.history.filter((entry) => entry.id !== id)],
        };
      });
    },
    [commit],
  );

  /**
   * Removes history by writing tombstones, not by deleting locally: the
   * tombstones are part of the pushed state, so the removal reaches every
   * device and survives a cache wipe. Home and Library both hide them.
   */
  const removeHistory = useCallback(
    (ids: string[]) => {
      if (!activeId) return;
      const targets = new Set(ids);
      if (targets.size === 0) return;
      if (
        !stateRef.current.history.some(
          (item) => targets.has(item.id) && !item.deletedAt,
        )
      ) {
        return;
      }
      const now = Date.now();
      commit(
        (prev) => ({
          ...prev,
          history: prev.history.map((item) =>
            targets.has(item.id) && !item.deletedAt
              ? { ...item, deletedAt: now, updatedAt: now }
              : item,
          ),
        }),
        false,
        true,
      );
    },
    [activeId, commit],
  );

  const setPrefs = useCallback(
    (patch: Partial<ProfilePrefs>) => {
      commit((prev) => ({ ...prev, prefs: { ...prev.prefs, ...patch } }), true);
    },
    [commit],
  );

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeId) ?? null,
    [profiles, activeId],
  );

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      profiles,
      activeProfile,
      state,
      syncStatus,
      authMap,
      adminAuthed,
      chooseProfile,
      unlockProfile,
      resumeProfile,
      completePasswordChange,
      changePassword,
      signOut,
      loginAdmin,
      logoutAdmin,
      adminSetProfilePassword,
      adminUnblockProfile,
      adminRenameProfile,
      adminAddProfile,
      adminDeleteProfile,
      adminKickProfiles,
      addToWatchlist,
      removeFromWatchlist,
      isInWatchlist,
      recordHistory,
      removeHistory,
      setPrefs,
    }),
    [
      ready,
      profiles,
      activeProfile,
      state,
      syncStatus,
      authMap,
      adminAuthed,
      chooseProfile,
      unlockProfile,
      resumeProfile,
      completePasswordChange,
      changePassword,
      signOut,
      loginAdmin,
      logoutAdmin,
      adminSetProfilePassword,
      adminUnblockProfile,
      adminRenameProfile,
      adminAddProfile,
      adminDeleteProfile,
      adminKickProfiles,
      addToWatchlist,
      removeFromWatchlist,
      isInWatchlist,
      recordHistory,
      removeHistory,
      setPrefs,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside <SessionProvider>.");
  return context;
}
