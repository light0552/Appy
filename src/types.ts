export type MediaType = "movie" | "tv";

/** Minimal reference used by the provider registry. */
export interface MediaRef {
  type: MediaType;
  tmdbId: number;
  imdbId?: string;
  season?: number;
  episode?: number;
}

/** Every synced record carries its own timestamp so merges are deterministic. */
export interface Stamped {
  id: string; // stable key, e.g. "movie:603" or "tv:1399:2:4"
  updatedAt: number; // ms epoch
  deletedAt?: number; // tombstone — never physically delete
}

export interface WatchItem extends Stamped {
  mediaType: MediaType;
  tmdbId: number;
  imdbId?: string;
  title: string;
  posterPath: string | null;
  addedAt: number;
}

export interface HistoryItem extends Stamped {
  mediaType: MediaType;
  tmdbId: number;
  imdbId?: string;
  title: string;
  posterPath: string | null;
  season?: number;
  episode?: number;
  watchedAt: number;
}

export interface ProfileMeta {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface ProfilePrefs {
  preferredProvider?: string;
  theme?: "dark" | "amoled";
}

export interface ProfileState {
  profileId: string;
  watchlist: WatchItem[];
  history: HistoryItem[];
  prefs: ProfilePrefs;
  updatedAt: number;
}

/** Normalised catalogue item produced by lib/tmdb.ts. */
export interface Media {
  type: MediaType;
  tmdbId: number;
  imdbId?: string;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  year: string | null;
  overview: string;
  rating: number;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
  posterPath: string | null;
}

export interface TitleDetail extends Media {
  tagline: string | null;
  runtime: number | null;
  genres: string[];
  status: string | null;
  cast: CastMember[];
  seasons: SeasonSummary[];
}

export interface Episode {
  episodeNumber: number;
  name: string;
  overview: string;
  stillPath: string | null;
  airDate: string | null;
  runtime: number | null;
}

export interface SeasonDetail {
  seasonNumber: number;
  name: string;
  episodes: Episode[];
}
