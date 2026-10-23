import type { Media, MediaType } from "../types";

const BASE = "https://api.themoviedb.org/3";
const TOKEN = (import.meta.env.VITE_TMDB_TOKEN as string | undefined)?.trim() ?? "";
const API_KEY = (import.meta.env.VITE_TMDB_API_KEY as string | undefined)?.trim() ?? "";
const TTL = 10 * 60 * 1000;

export class TmdbError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TmdbError";
    this.status = status;
  }
}

type Params = Record<string, string | number | boolean | undefined>;

const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function get<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  if (!TOKEN && API_KEY) url.searchParams.set("api_key", API_KEY);

  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data as T;

  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const headers: Record<string, string> = { accept: "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const request = (async () => {
    let res: Response;
    try {
      res = await fetch(key, { headers, signal });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      throw new TmdbError("Could not reach TMDB. Check your connection.", 0);
    }
    if (!res.ok) {
      throw new TmdbError(
        res.status === 401
          ? "TMDB rejected the API key."
          : `TMDB request failed (${res.status}).`,
        res.status,
      );
    }
    const data = (await res.json()) as T;
    cache.set(key, { at: Date.now(), data });
    return data;
  })();

  inflight.set(key, request);
  try {
    return (await request) as T;
  } finally {
    inflight.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* Raw shapes                                                          */
/* ------------------------------------------------------------------ */

interface RawMedia {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
}

interface RawMediaList {
  page?: number;
  results?: RawMedia[];
  total_pages?: number;
  total_results?: number;
}

interface RawCast {
  id: number;
  name?: string;
  character?: string;
  profile_path?: string | null;
}

interface RawDetail extends RawMedia {
  tagline?: string | null;
  runtime?: number | null;
  episode_run_time?: number[];
  genres?: { id: number; name: string }[];
  status?: string | null;
  external_ids?: { imdb_id?: string | null };
  credits?: { cast?: RawCast[] };
  seasons?: {
    season_number: number;
    name?: string;
    episode_count?: number;
    air_date?: string | null;
    poster_path?: string | null;
  }[];
}

interface RawSeason {
  season_number: number;
  name?: string;
  episodes?: {
    episode_number: number;
    name?: string;
    overview?: string;
    still_path?: string | null;
    air_date?: string | null;
    runtime?: number | null;
  }[];
}

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

function toMedia(raw: RawMedia, fallback?: MediaType): import("../types").Media | null {
  const type: MediaType | undefined =
    raw.media_type === "movie" || raw.media_type === "tv" ? raw.media_type : fallback;
  if (!type) return null;

  const date = raw.release_date || raw.first_air_date || "";
  return {
    type,
    tmdbId: raw.id,
    title: raw.title || raw.name || "Untitled",
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    year: date ? date.slice(0, 4) : null,
    overview: raw.overview ?? "",
    rating: typeof raw.vote_average === "number" ? raw.vote_average : 0,
  };
}

function mapList(raw: RawMediaList, fallback?: MediaType, limit = 20): import("../types").Media[] {
  const out: import("../types").Media[] = [];
  for (const item of raw.results ?? []) {
    const media = toMedia(item, fallback);
    if (media) out.push(media);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function getTrending(): Promise<import("../types").Media[]> {
  return mapList(await get<RawMediaList>("/trending/all/week"), undefined, 20);
}

export async function getPopularMovies(): Promise<import("../types").Media[]> {
  return mapList(await get<RawMediaList>("/movie/popular"), "movie", 20);
}

export async function getPopularTv(): Promise<import("../types").Media[]> {
  return mapList(await get<RawMediaList>("/tv/popular"), "tv", 20);
}

/* ------------------------------------------------------------------ */
/* Catalogue pagination                                                */
/* ------------------------------------------------------------------ */

export type CatalogKind = "trending" | "movies" | "tv";

export interface CatalogPage {
  items: Media[];
  page: number;
  totalPages: number;
}

const CATALOG_SOURCES: Record<CatalogKind, { path: string; fallback?: MediaType }> = {
  trending: { path: "/trending/all/week" },
  movies: { path: "/movie/popular", fallback: "movie" },
  tv: { path: "/tv/popular", fallback: "tv" },
};

/** One page of a full catalogue list. `page` is clamped to >= 1. */
export async function getCatalogPage(kind: CatalogKind, page: number): Promise<CatalogPage> {
  const source = CATALOG_SOURCES[kind];
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const data = await get<RawMediaList>(source.path, { page: safePage });
  const totalPages =
    typeof data.total_pages === "number" && data.total_pages >= 1 ? Math.floor(data.total_pages) : 1;
  const currentPage =
    typeof data.page === "number" && data.page >= 1 ? Math.floor(data.page) : safePage;
  return {
    items: mapList(data, source.fallback, 20),
    page: currentPage,
    totalPages,
  };
}

export async function searchMulti(
  query: string,
  signal?: AbortSignal,
): Promise<import("../types").Media[]> {
  const q = query.trim();
  if (!q) return [];
  const data = await get<RawMediaList>(
    "/search/multi",
    { query: q, include_adult: false, language: "en-US", page: 1 },
    signal,
  );
  return mapList(data, undefined, 40).filter((m) => m.title !== "Untitled");
}

export async function getTitle(
  type: MediaType,
  id: number,
): Promise<import("../types").TitleDetail> {
  const raw = await get<RawDetail>(`/${type}/${id}`, {
    append_to_response: "credits,external_ids",
    language: "en-US",
  });

  const base = toMedia(raw, type);
  if (!base) throw new TmdbError("Unknown title.", 404);

  const runtime =
    typeof raw.runtime === "number" && raw.runtime > 0
      ? raw.runtime
      : Array.isArray(raw.episode_run_time) && raw.episode_run_time.length
        ? raw.episode_run_time[0]
        : null;

  const imdbId = raw.external_ids?.imdb_id ?? undefined;

  return {
    ...base,
    imdbId: imdbId ?? undefined,
    tagline: raw.tagline?.trim() ? raw.tagline : null,
    runtime,
    genres: (raw.genres ?? []).map((g) => g.name),
    status: raw.status ?? null,
    cast: (raw.credits?.cast ?? []).slice(0, 20).map((c) => ({
      id: c.id,
      name: c.name ?? "Unknown",
      character: c.character ?? "",
      profilePath: c.profile_path ?? null,
    })),
    seasons: (raw.seasons ?? [])
      .filter((s) => s.season_number > 0 || (s.episode_count ?? 0) > 0)
      .map((s) => ({
        seasonNumber: s.season_number,
        name: s.name || `Season ${s.season_number}`,
        episodeCount: s.episode_count ?? 0,
        airDate: s.air_date ?? null,
        posterPath: s.poster_path ?? null,
      })),
  };
}

export async function getSeason(tvId: number, seasonNumber: number): Promise<import("../types").SeasonDetail> {
  const raw = await get<RawSeason>(`/tv/${tvId}/season/${seasonNumber}`, { language: "en-US" });
  return {
    seasonNumber: raw.season_number,
    name: raw.name || `Season ${raw.season_number}`,
    episodes: (raw.episodes ?? []).map((e) => ({
      episodeNumber: e.episode_number,
      name: e.name || `Episode ${e.episode_number}`,
      overview: e.overview ?? "",
      stillPath: e.still_path ?? null,
      airDate: e.air_date ?? null,
      runtime: e.runtime ?? null,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

export type PosterSize = "w185" | "w342" | "w500" | "w780" | "original";
export type BackdropSize = "w300" | "w780" | "w1280" | "original";

export function posterUrl(path: string | null | undefined, size: PosterSize = "w342"): string | undefined {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

export function backdropUrl(
  path: string | null | undefined,
  size: BackdropSize = "w780",
): string | undefined {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

export function profileUrl(path: string | null | undefined): string | undefined {
  return path ? `https://image.tmdb.org/t/p/w185${path}` : undefined;
}
