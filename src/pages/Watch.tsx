import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Player from "../components/Player";
import ServerChips from "../components/ServerChips";
import {
  availableProviders,
  DEFAULT_PROVIDER_ID,
  preferredUrl,
  PROVIDER_PREFS_VERSION,
  type ProviderOption,
} from "../lib/providers";
import { getSeason, getTitle, posterUrl } from "../lib/tmdb";
import { useSession } from "../lib/session";
import { historyKey } from "../lib/store";
import type {
  MediaRef,
  MediaType,
  SeasonDetail,
  SeasonSummary,
  TitleDetail,
} from "../types";
import "../styles/player.css";

/**
 * DNS + TLS + headers only, not video readiness (BUILD.md §8). Used purely as
 * a tiebreaker among the first three servers, in the background.
 */
async function probe(url: string, timeout = 2500): Promise<number> {
  const t0 = performance.now();
  try {
    await fetch(url, {
      mode: "no-cors",
      cache: "reload",
      signal: AbortSignal.timeout(timeout),
    });
    return performance.now() - t0;
  } catch {
    return Infinity;
  }
}

function positiveInt(raw: string | null, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A season that prev/next may target: a regular numbered season with at least
 * one episode. TMDB lists specials as season 0 and, for some shows, a season
 * with `episode_count: 0`; neither is a legal neighbour. Without the
 * `seasonNumber > 0` guard, S1E1's "previous" lands on `?s=0&e=<specials
 * count>` instead of simply not existing.
 */
function isNavigableSeason(entry: SeasonSummary): boolean {
  return entry.seasonNumber > 0 && entry.episodeCount > 0;
}

interface EpisodeRef {
  season: number;
  episode: number;
}

const BackIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M15 5l-7 7 7 7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const PreviousIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 5v14M18 6l-8 6 8 6V6Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const NextIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M18 5v14M6 6l8 6-8 6V6Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ReloadIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CloseIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

/** Swap arrows for the watchdog's "try another source" action. */
const SwapIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Broadcast mark for the deck's source readout. */
const SourceIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="2.1" fill="currentColor" />
    <path
      d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 15.8a5.4 5.4 0 0 0 0-7.6M5.4 5.4a9.4 9.4 0 0 0 0 13.2M18.6 18.6a9.4 9.4 0 0 0 0-13.2"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

export default function Watch() {
  const params = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const [searchParams] = useSearchParams();

  const type: MediaType | null =
    params.type === "movie" || params.type === "tv" ? params.type : null;
  const tmdbId = Number.parseInt(params.id ?? "", 10);
  const validId = Number.isInteger(tmdbId) && tmdbId > 0;

  const season = type === "tv" ? positiveInt(searchParams.get("s"), 1) : undefined;
  const episode = type === "tv" ? positiveInt(searchParams.get("e"), 1) : undefined;

  /* ---------------------------------------------------------------- */
  /* Title details — the player does not wait for these.               */
  /* ---------------------------------------------------------------- */

  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  useEffect(() => {
    if (!type || !validId) return;
    let alive = true;

    setDetail(null);
    setDetailFailed(false);

    getTitle(type, tmdbId)
      .then((data) => {
        if (alive) setDetail(data);
      })
      .catch(() => {
        if (alive) setDetailFailed(true);
      });

    return () => {
      alive = false;
    };
  }, [type, tmdbId, validId]);

  /* ---------------------------------------------------------------- */
  /* Season details — episode names + prev/next without leaving Watch. */
  /* ---------------------------------------------------------------- */

  const [seasonDetail, setSeasonDetail] = useState<SeasonDetail | null>(null);

  useEffect(() => {
    if (type !== "tv" || !validId || season === undefined) {
      setSeasonDetail(null);
      return;
    }
    let alive = true;
    setSeasonDetail(null);

    getSeason(tmdbId, season)
      .then((data) => {
        if (alive) setSeasonDetail(data);
      })
      .catch(() => {
        if (alive) setSeasonDetail(null);
      });

    return () => {
      alive = false;
    };
  }, [type, tmdbId, season, validId]);

  const currentEpisode = useMemo(() => {
    if (!seasonDetail || episode === undefined) return null;
    return (
      seasonDetail.episodes.find((entry) => entry.episodeNumber === episode) ?? null
    );
  }, [seasonDetail, episode]);

  /* ---------------------------------------------------------------- */
  /* Provider selection                                                */
  /* ---------------------------------------------------------------- */

  const mediaRef = useMemo<MediaRef>(
    () => ({ type: type ?? "movie", tmdbId, imdbId: detail?.imdbId, season, episode }),
    [type, tmdbId, detail?.imdbId, season, episode],
  );

  const options = useMemo(() => availableProviders(mediaRef), [mediaRef]);
  const providerPrefsVersion = session.state.prefs.providerPrefsVersion ?? 0;
  // Ignore a saved server from before a provider-list change. The migration
  // below writes the new default once; after that a deliberate user choice is
  // honored again.
  const preferred =
    providerPrefsVersion >= PROVIDER_PREFS_VERSION
      ? preferredUrl(mediaRef, session.state.prefs.preferredProvider)
      : null;

  const setPrefs = session.setPrefs;
  useEffect(() => {
    if (providerPrefsVersion >= PROVIDER_PREFS_VERSION) return;
    setPrefs({
      providerPrefsVersion: PROVIDER_PREFS_VERSION,
      preferredProvider: DEFAULT_PROVIDER_ID,
    });
  }, [providerPrefsVersion, setPrefs]);

  const [probeWinner, setProbeWinner] = useState<string | null>(null);
  const interactedRef = useRef(false);
  const recordedRef = useRef<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showWatchdog, setShowWatchdog] = useState(false);

  // A new title/episode starts with a fresh watchdog state.
  useEffect(() => {
    setShowWatchdog(false);
  }, [type, tmdbId, season, episode]);

  // Background reachability check. It never delays the first iframe — the first
  // server paints immediately and this may only swap it before the user
  // interacts. Registry order is playability order (harness-verified 2026-10-22:
  // only VidLink actually plays), so raw latency may not demote the first server.
  // A swap happens only when the first server does not answer at all.
  useEffect(() => {
    if (preferred || options.length < 2) return;
    let cancelled = false;

    const candidates = options.slice(0, 3);
    void Promise.all(candidates.map((option) => probe(option.url))).then((times) => {
      if (cancelled || interactedRef.current) return;
      if (Number.isFinite(times[0])) return;
      let best = -1;
      for (let i = 1; i < times.length; i += 1) {
        if (Number.isFinite(times[i]) && (best === -1 || times[i] < times[best])) best = i;
      }
      if (best === -1) return;
      setProbeWinner(candidates[best].provider.id);
    });

    return () => {
      cancelled = true;
    };
  }, [options, preferred]);

  const currentOption: ProviderOption | undefined = useMemo(() => {
    if (preferred) return options.find((option) => option.url === preferred);
    if (probeWinner) return options.find((option) => option.provider.id === probeWinner);
    return options[0];
  }, [options, preferred, probeWinner]);

  const url = currentOption?.url;
  const poster = detail ? posterUrl(detail.posterPath, "w185") : null;

  const isEpisode = type === "tv" && season !== undefined && episode !== undefined;

  /** "S1 · E1" — the badge shown in the deck and in the top chrome. */
  const episodeBadge = isEpisode ? `S${season} · E${episode}` : null;

  const episodeLabel =
    type === "tv" && season !== undefined && episode !== undefined
      ? `S${season} · E${episode}${currentEpisode?.name ? ` · ${currentEpisode.name}` : ""}`
      : null;

  const frameTitle = detail
    ? `${detail.title}${episodeLabel ? ` — ${episodeLabel}` : ""}`
    : "Player";

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  const handleTimeout = useCallback(() => setShowWatchdog(true), []);

  // Providers fire popunders ~1s after the tap (cross-origin — the parent can't
  // stop them). When the user closes the ad tab and returns, a stale "Not
  // playing" bar over a working player is worse than no bar: hide it on return
  // to the foreground. Player's fresh 6s grace timer re-shows it only if the
  // player is genuinely still stuck.
  useEffect(() => {
    const handleReturnToForeground = () => {
      if (document.visibilityState === "visible") setShowWatchdog(false);
    };
    document.addEventListener("visibilitychange", handleReturnToForeground);
    window.addEventListener("focus", handleReturnToForeground);
    return () => {
      document.removeEventListener("visibilitychange", handleReturnToForeground);
      window.removeEventListener("focus", handleReturnToForeground);
    };
  }, []);

  const onSelectServer = useCallback(
    (id: string) => {
      interactedRef.current = true;
      setShowWatchdog(false);
      if (id !== currentOption?.provider.id) {
        session.setPrefs({ preferredProvider: id });
      } else {
        setReloadKey((value) => value + 1);
      }
    },
    [currentOption, session],
  );

  /** Cycles to the next available server in registry order, wrapping around. */
  const advanceServer = useCallback(() => {
    interactedRef.current = true;
    setShowWatchdog(false);
    if (options.length < 2) return;
    const index = options.findIndex(
      (option) => option.provider.id === currentOption?.provider.id,
    );
    const next = options[(index + 1) % options.length];
    session.setPrefs({ preferredProvider: next.provider.id });
  }, [currentOption, options, session]);

  const reloadStream = useCallback(() => {
    setShowWatchdog(false);
    setReloadKey((value) => value + 1);
  }, []);

  const goBack = useCallback(() => {
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === "number" && state.idx > 0) navigate(-1);
    else navigate("/", { replace: true });
  }, [navigate]);

  /* ---------------------------------------------------------------- */
  /* History — once per distinct key                                   */
  /* ---------------------------------------------------------------- */

  const recordHistory = session.recordHistory;

  useEffect(() => {
    if (!type || !validId) return;
    if (!detail && !detailFailed) return; // wait for a name, or a definitive failure
    const key = historyKey(type, tmdbId, season, episode);
    if (recordedRef.current === key) return;
    recordedRef.current = key;
    recordHistory(
      detail ?? {
        type,
        tmdbId,
        title: "Unknown title",
        posterPath: null,
        backdropPath: null,
        year: null,
        overview: "",
        rating: 0,
      },
      season !== undefined && episode !== undefined ? { season, episode } : undefined,
    );
  }, [detail, detailFailed, validId, type, tmdbId, season, episode, recordHistory]);

  /* ---------------------------------------------------------------- */
  /* Previous / next episode                                           */
  /* ---------------------------------------------------------------- */

  const previous = useMemo<EpisodeRef | null>(() => {
    if (detail?.type !== "tv" || season === undefined || episode === undefined) return null;
    if (season < 1) return null; // specials are not a regular-season neighbour
    if (episode > 1) return { season, episode: episode - 1 };
    if (season === 1) return null; // S1E1 is the true start of the show

    // Episode 1 of a later season: go to the final episode of the highest
    // earlier regular season (skipping specials and empty seasons).
    const earlier = detail.seasons
      .filter((entry) => isNavigableSeason(entry) && entry.seasonNumber < season)
      .sort((a, b) => b.seasonNumber - a.seasonNumber)[0];
    return earlier ? { season: earlier.seasonNumber, episode: earlier.episodeCount } : null;
  }, [detail, season, episode]);

  /**
   * The current season's true length. TMDB's `episode_count` is per-season,
   * but it can lag (or be 0) for a season that is still airing, so the loaded
   * season detail is used as a floor when it is available.
   */
  const seasonLength = useMemo(() => {
    if (detail?.type !== "tv" || season === undefined || season < 1) return 0;
    const summary = detail.seasons.find(
      (entry) => entry.seasonNumber === season && entry.seasonNumber > 0,
    );
    const loaded =
      seasonDetail?.seasonNumber === season
        ? seasonDetail.episodes.reduce(
            (max, entry) => Math.max(max, entry.episodeNumber),
            0,
          )
        : 0;
    return Math.max(summary?.episodeCount ?? 0, loaded);
  }, [detail, season, seasonDetail]);

  const next = useMemo<EpisodeRef | null>(() => {
    if (detail?.type !== "tv" || season === undefined || episode === undefined) return null;
    if (season < 1) return null; // specials are not a regular-season neighbour

    if (seasonLength > 0 && episode < seasonLength) {
      return { season, episode: episode + 1 };
    }

    // End of the season: the first episode of the next regular season, if any.
    const later = detail.seasons
      .filter((entry) => isNavigableSeason(entry) && entry.seasonNumber > season)
      .sort((a, b) => a.seasonNumber - b.seasonNumber)[0];
    return later ? { season: later.seasonNumber, episode: 1 } : null;
  }, [detail, season, episode, seasonLength]);

  if (!type || !validId) return <Navigate to="/" replace />;

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div className="player-page watch">
      <div className="watch-stage">
        {url ? (
          <Player key={reloadKey} url={url} title={frameTitle} onTimeout={handleTimeout} />
        ) : (
          <div className="watch-empty">
            <div className="watch-empty-card">
              <p className="eyebrow">No signal</p>
              <h3>No server can play this title</h3>
              <p className="muted">
                The provider list came back empty. Go back and try another title, or
                reopen this one in a moment.
              </p>
              <button type="button" className="btn btn-secondary" onClick={goBack}>
                Go back
              </button>
            </div>
          </div>
        )}

        {/* Luminous top chrome: a glass rail that floats over the frame. */}
        <div className="watch-top">
          <div className="watch-top-row">
            <button
              type="button"
              className="icon-btn watch-back"
              onClick={goBack}
              aria-label="Back"
            >
              {BackIcon}
            </button>

            {/* Decorative only — the deck below carries the same copy for
                screen readers. */}
            <div className="watch-top-copy" aria-hidden="true">
              <p className="watch-top-kicker">Now playing</p>
              <p className="watch-top-title truncate">{detail?.title ?? "Loading"}</p>
              {(episodeBadge || detail?.year) && (
                <p className="watch-top-meta">
                  {episodeBadge && <span className="watch-top-badge">{episodeBadge}</span>}
                  {detail?.year && <span className="watch-top-year">{detail.year}</span>}
                </p>
              )}
            </div>

            <ServerChips
              mediaRef={mediaRef}
              activeId={currentOption?.provider.id}
              onSelect={onSelectServer}
            />
          </div>

          {showWatchdog && (
            <div className="watchdog-bar" role="status">
              <span className="watchdog-beacon" aria-hidden="true">
                <span className="watchdog-beacon-core" />
              </span>
              <div className="watchdog-copy">
                <span className="watchdog-kicker">Stream not starting?</span>
                <span className="watchdog-text">
                  {currentOption ? `${currentOption.provider.name} is taking a while. ` : ""}
                  Try another server — you&rsquo;ll stay on this episode.
                </span>
              </div>
              <div className="watchdog-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary watchdog-switch"
                  onClick={options.length > 1 ? advanceServer : reloadStream}
                  disabled={options.length === 0}
                >
                  {SwapIcon}
                  {options.length > 1 ? "Switch server" : "Reload stream"}
                </button>
                <button
                  type="button"
                  className="icon-btn watchdog-close"
                  onClick={() => setShowWatchdog(false)}
                  aria-label="Dismiss"
                >
                  {CloseIcon}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* The deck: now-playing readout on the left, transport on the right. */}
      <footer className={`watch-bar watch-bar--${type === "tv" ? "tv" : "movie"}`}>
        <div className="watch-now">
          {detail ? (
            <>
              {poster ? (
                <img className="watch-poster" src={poster} alt="" decoding="async" />
              ) : (
                <span className="watch-poster watch-poster--fallback" aria-hidden="true">
                  {detail.title.slice(0, 1)}
                </span>
              )}
              <div className="watch-now-copy">
                <p className="watch-now-kicker">Now playing</p>
                <p className="watch-now-title truncate">{detail.title}</p>
                <div className="watch-now-meta">
                  {detail.year && <span className="watch-meta-year">{detail.year}</span>}
                  {episodeBadge && (
                    <span className="watch-episode-badge">{episodeBadge}</span>
                  )}
                  {currentOption && (
                    <span className="watch-provider">{currentOption.provider.name}</span>
                  )}
                </div>
                {type === "tv" && (
                  <p className="watch-now-sub tiny watch-now-episode">
                    <span className="watch-episode-name truncate">
                      {currentEpisode?.name ?? (seasonDetail ? "Episode" : "Loading episode…")}
                    </span>
                  </p>
                )}
              </div>
            </>
          ) : detailFailed ? (
            <p className="watch-now-sub tiny">
              Title details didn&rsquo;t load — playback still works.
            </p>
          ) : (
            <span className="skeleton skeleton--text watch-now-sk" aria-hidden="true" />
          )}
        </div>

        {type === "tv" ? (
          <div
            className="watch-actions watch-actions--episodes"
            role="group"
            aria-label="Episode controls"
          >
            {previous && (
              <Link
                className="btn btn-secondary watch-episode-btn"
                to={`/watch/tv/${tmdbId}?s=${previous.season}&e=${previous.episode}`}
                aria-label="Previous episode"
              >
                {PreviousIcon}
                <span className="watch-episode-btn__long">Previous episode</span>
                <span className="watch-episode-btn__short">Previous</span>
              </Link>
            )}
            <button
              type="button"
              className="btn btn-secondary watch-episode-btn"
              onClick={reloadStream}
              aria-label="Reload stream"
            >
              {ReloadIcon}
              <span className="watch-episode-btn__long">Reload stream</span>
              <span className="watch-episode-btn__short">Reload</span>
            </button>
            {next && (
              <Link
                className="btn btn-primary watch-episode-btn"
                to={`/watch/tv/${tmdbId}?s=${next.season}&e=${next.episode}`}
                aria-label="Next episode"
              >
                <span className="watch-episode-btn__long">Next episode</span>
                <span className="watch-episode-btn__short">Next</span>
                {NextIcon}
              </Link>
            )}
          </div>
        ) : (
          <div className="watch-source">
            <span className="watch-source-icon" aria-hidden="true">
              {SourceIcon}
            </span>
            <span className="watch-source-copy">
              <span className="watch-source-label">Source</span>
              <span className="watch-source-name">
                {currentOption?.provider.name ?? "No server"}
              </span>
            </span>
          </div>
        )}
      </footer>
    </div>
  );
}
