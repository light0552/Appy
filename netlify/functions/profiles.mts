import { getStore } from "@netlify/blobs";

/**
 * Profile sync endpoint (Netlify Functions v2).
 *
 * Blob layout (store "lighthook", strong consistency):
 *   profiles/index.json -> ProfileMeta[]
 *   profiles/<id>.json  -> ProfileState
 *
 * The x-family-key header is a gate, not authentication: it only protects
 * watchlist/history/preferences data for a private household.
 */

type MediaType = "movie" | "tv";

interface Stamped {
  id: string;
  updatedAt: number;
  deletedAt?: number;
}

interface WatchItem extends Stamped {
  mediaType: MediaType;
  tmdbId: number;
  imdbId?: string;
  title: string;
  posterPath: string | null;
  addedAt: number;
}

interface HistoryItem extends Stamped {
  mediaType: MediaType;
  tmdbId: number;
  imdbId?: string;
  title: string;
  posterPath: string | null;
  season?: number;
  episode?: number;
  watchedAt: number;
}

interface ProfilePrefs {
  preferredProvider?: string;
  theme?: "dark" | "amoled";
  [key: string]: unknown;
}

interface ProfileMeta {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

interface ProfileState {
  profileId: string;
  watchlist: WatchItem[];
  history: HistoryItem[];
  prefs: ProfilePrefs;
  updatedAt: number;
}

const INDEX_KEY = "profiles/index.json";
const MAX_PROFILES = 10;
const MAX_RECORDS_PER_PUSH = 2000;
const MAX_NAME_LENGTH = 24;
const MAX_RECORD_ID_LENGTH = 200;
const DEFAULT_COLOR = "#8b5cf6";
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const SEEDS = [
  { id: "sam", name: "Sam", color: "#00acc1" },
  { id: "mellu", name: "Mellu", color: "#ff6b9d" },
] satisfies ReadonlyArray<Omit<ProfileMeta, "createdAt">>;

type BlobStore = ReturnType<typeof getStore>;

type ParsedBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: "invalid_json" | "invalid_body" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function emptyState(profileId: string): ProfileState {
  return { profileId, watchlist: [], history: [], prefs: {}, updatedAt: 0 };
}

function stateKey(profileId: string): string {
  return `profiles/${profileId}.json`;
}

function seedIndex(): ProfileMeta[] {
  const createdAt = Date.now();
  return SEEDS.map((seed) => ({ ...seed, createdAt }));
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return slug.length > 0 ? slug : "profile";
}

function nextProfileId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  const stamp = Date.now().toString(36);
  let candidate = `${base}-${stamp}`;
  let counter = 1;

  // Guard against two creates landing in the same millisecond.
  while (taken.has(candidate)) {
    candidate = `${base}-${stamp}-${counter.toString(36)}`;
    counter += 1;
  }

  return candidate;
}

function sanitizeIndex(value: unknown): ProfileMeta[] | null {
  if (!Array.isArray(value)) return null;

  const out: ProfileMeta[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id) || seen.has(entry.id)) continue;

    const name = normalizeName(entry.name) ?? entry.id;
    const color = isColor(entry.color) ? entry.color : DEFAULT_COLOR;
    const createdAt =
      typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
        ? entry.createdAt
        : Date.now();

    seen.add(entry.id);
    out.push({ id: entry.id, name, color, createdAt });
  }

  return out;
}

/**
 * Structural check for the fields the merge relies on. Remaining fields
 * (posterPath, deletedAt, season, ...) pass through untouched.
 */
function isStamped<T extends Stamped>(value: unknown): value is T {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > MAX_RECORD_ID_LENGTH
  ) {
    return false;
  }
  return typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt);
}

function sanitizeRecords<T extends Stamped>(value: unknown, limit?: number): T[] | null {
  if (!Array.isArray(value)) return null;

  const out: T[] = [];
  for (const entry of value) {
    if (isStamped<T>(entry)) out.push(entry);
  }

  if (limit !== undefined && out.length > limit) {
    // Tombstones must survive truncation first: dropping one would let the next
    // pull resurrect a record the server never held a delete for (deletes are
    // tombstones and are never physically deleted). Then keep the newest.
    out.sort(
      (a, b) => Number(!!b.deletedAt) - Number(!!a.deletedAt) || b.updatedAt - a.updatedAt,
    );
    return out.slice(0, limit);
  }

  return out;
}

function sanitizePrefs(value: unknown): ProfilePrefs | null {
  if (!isRecord(value)) return null;

  const prefs: ProfilePrefs = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    prefs[key] = entry;
  }
  return prefs;
}

function sanitizeState(value: unknown, profileId: string): ProfileState | null {
  if (!isRecord(value)) return null;

  const watchlist = sanitizeRecords<WatchItem>(value.watchlist) ?? [];
  const history = sanitizeRecords<HistoryItem>(value.history) ?? [];
  const prefs = sanitizePrefs(value.prefs) ?? {};
  const updatedAt =
    typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;

  return { profileId, watchlist, history, prefs, updatedAt };
}

function mergeById<T extends Stamped>(incoming: T[], stored: T[]): T[] {
  const out = new Map<string, T>();

  // Stored records win ties, so a delayed older push cannot overwrite them.
  for (const record of [...stored, ...incoming]) {
    const previous = out.get(record.id);
    if (!previous || record.updatedAt > previous.updatedAt) out.set(record.id, record);
  }

  return [...out.values()];
}

async function readBody(req: Request): Promise<ParsedBody> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  return { ok: true, body: value };
}

async function loadIndex(store: BlobStore): Promise<ProfileMeta[]> {
  let raw: unknown = null;
  try {
    raw = await store.get(INDEX_KEY, { type: "json" });
  } catch (error) {
    console.error("profiles: failed to read index", error);
  }

  const parsed = sanitizeIndex(raw);
  if (parsed !== null) return parsed;

  const seeded = seedIndex();
  await store.setJSON(INDEX_KEY, seeded);
  return seeded;
}

async function loadState(store: BlobStore, profileId: string): Promise<ProfileState | null> {
  let raw: unknown = null;
  try {
    raw = await store.get(stateKey(profileId), { type: "json" });
  } catch (error) {
    console.error(`profiles: failed to read state for ${profileId}`, error);
    return null;
  }

  return sanitizeState(raw, profileId);
}

async function route(req: Request): Promise<Response> {
  const method = (req.method ?? "").toUpperCase();
  const url = new URL(req.url);
  const rawId = url.searchParams.get("id");

  if (rawId !== null && !ID_PATTERN.test(rawId)) {
    return json({ error: "invalid_id" }, 400);
  }

  const id = rawId;
  const store = getStore({ name: "lighthook", consistency: "strong" });
  const index = await loadIndex(store);

  if (method === "GET") {
    if (id === null) return json({ profiles: index });

    const state = await loadState(store, id);
    return json(state ?? emptyState(id));
  }

  if (method === "POST") {
    if (id === null) {
      if (index.length >= MAX_PROFILES) {
        return json({ error: "profile_limit", max: MAX_PROFILES }, 409);
      }

      const parsed = await readBody(req);
      if (!parsed.ok) return json({ error: parsed.error }, 400);

      const name = normalizeName(parsed.body.name);
      if (name === null) return json({ error: "name_required" }, 400);

      const color = parsed.body.color === undefined ? DEFAULT_COLOR : parsed.body.color;
      if (!isColor(color)) return json({ error: "invalid_color" }, 400);

      const profile: ProfileMeta = {
        id: nextProfileId(name, new Set(index.map((entry) => entry.id))),
        name,
        color,
        createdAt: Date.now(),
      };

      await store.setJSON(INDEX_KEY, [...index, profile]);
      return json({ profile }, 201);
    }

    const parsed = await readBody(req);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    // Rename / recolour is index-only work and must be handled before merging state.
    if (parsed.body.meta !== undefined) {
      const metaValue = parsed.body.meta;
      if (!isRecord(metaValue)) return json({ error: "invalid_meta" }, 400);

      const existing = index.find((entry) => entry.id === id);
      if (!existing) return json({ error: "not_found" }, 404);

      let name = existing.name;
      if (metaValue.name !== undefined) {
        const normalized = normalizeName(metaValue.name);
        if (normalized === null) return json({ error: "name_required" }, 400);
        name = normalized;
      }

      let color = existing.color;
      if (metaValue.color !== undefined) {
        if (!isColor(metaValue.color)) return json({ error: "invalid_color" }, 400);
        color = metaValue.color;
      }

      const profile: ProfileMeta = { ...existing, name, color };
      await store.setJSON(
        INDEX_KEY,
        index.map((entry) => (entry.id === id ? profile : entry)),
      );

      return json({ profile });
    }

    const patchWatchlist =
      parsed.body.watchlist === undefined
        ? []
        : sanitizeRecords<WatchItem>(parsed.body.watchlist, MAX_RECORDS_PER_PUSH);
    if (patchWatchlist === null) return json({ error: "invalid_watchlist" }, 400);

    const patchHistory =
      parsed.body.history === undefined
        ? []
        : sanitizeRecords<HistoryItem>(parsed.body.history, MAX_RECORDS_PER_PUSH);
    if (patchHistory === null) return json({ error: "invalid_history" }, 400);

    const patchPrefs =
      parsed.body.prefs === undefined ? {} : sanitizePrefs(parsed.body.prefs);
    if (patchPrefs === null) return json({ error: "invalid_prefs" }, 400);

    const current = (await loadState(store, id)) ?? emptyState(id);
    const next: ProfileState = {
      ...current,
      profileId: id,
      watchlist: mergeById(patchWatchlist, current.watchlist),
      history: mergeById(patchHistory, current.history),
      prefs: { ...current.prefs, ...patchPrefs },
      updatedAt: Date.now(),
    };

    await store.setJSON(stateKey(id), next);
    return json(next);
  }

  if (method === "DELETE") {
    if (id === null) return json({ error: "id_required" }, 400);

    if (!index.some((entry) => entry.id === id)) {
      return json({ error: "not_found" }, 404);
    }

    await store.setJSON(
      INDEX_KEY,
      index.filter((entry) => entry.id !== id),
    );
    await store.delete(stateKey(id));

    return json({ ok: true, deleted: id });
  }

  return json({ error: "method_not_allowed" }, 405, {
    allow: "GET, POST, DELETE",
  });
}

export default async function handler(req: Request): Promise<Response> {
  const expectedKey = process.env.FAMILY_KEY ?? "samandmellu";
  if (req.headers.get("x-family-key") !== expectedKey) {
    return json({ error: "forbidden" }, 403);
  }

  try {
    return await route(req);
  } catch (error) {
    console.error("profiles: unhandled error", error);
    return json({ error: "internal_error" }, 500);
  }
}

export const config = { path: "/api/profiles" };
