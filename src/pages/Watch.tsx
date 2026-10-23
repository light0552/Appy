import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Player from "../components/Player";
import ServerChips from "../components/ServerChips";
import { availableProviders, preferredUrl, type ProviderOption } from "../lib/providers";
import { getTitle } from "../lib/tmdb";
import { useSession } from "../lib/session";
import { historyKey } from "../lib/store";
import type { MediaRef, MediaType, TitleDetail } from "../types";
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
  /* Provider selection                                                */
  /* ---------------------------------------------------------------- */

  const mediaRef = useMemo<MediaRef>(
    () => ({ type: type ?? "movie", tmdbId, imdbId: detail?.imdbId, season, episode }),
    [type, tmdbId, detail?.imdbId, season, episode],
  );

  const options = useMemo(() => availableProviders(mediaRef), [mediaRef]);
  const preferred = preferredUrl(mediaRef, session.state.prefs.preferredProvider);

  const [probeWinner, setProbeWinner] = useState<string | null>(null);
  const interactedRef = useRef(false);
  const recordedRef = useRef<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showWatchdog, setShowWatchdog] = useState(false);

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

  const frameTitle = detail
    ? `${detail.title}${season !== undefined && episode !== undefined ? ` — S${season} E${episode}` : ""}`
    : "Player";

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  const handleTimeout = useCallback(() => setShowWatchdog(true), []);

  // Providers fire popunders ~1s after the tap (cross-origin — the parent can't
  // stop them). When the user closes the ad tab and returns, a stale "Not
  // playing" bar over a working player is worse than no bar: hide it on return
  // to the foreground. Player's fresh 6s grace timer re-shows it only if the
  // player is genuinely still stuck. Deliberately does NOT set interactedRef —
  // a programmatic focus event is not a user interaction, so the background
  // probe swap above is unaffected.
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
        session.setPrefs({ preferredProvider: id }); // url changes -> Player restarts its 6s timer
      } else {
        setReloadKey((value) => value + 1); // same server re-picked -> force reload + fresh timer
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
    // index -1 (no current option) resolves to the first server — modulo wraps.
    const next = options[(index + 1) % options.length];
    session.setPrefs({ preferredProvider: next.provider.id });
  }, [currentOption, options, session]);

  const continueHere = useCallback(() => {
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
  /* Next episode                                                      */
  /* ---------------------------------------------------------------- */

  const next = useMemo(() => {
    if (detail?.type !== "tv" || season === undefined || episode === undefined) return null;
    const current = detail.seasons.find((s) => s.seasonNumber === season);
    if (current && episode < current.episodeCount) return { season, episode: episode + 1 };
    const nextSeason = detail.seasons.find(
      (s) => s.seasonNumber === season + 1 && s.episodeCount > 0,
    );
    if (nextSeason) return { season: season + 1, episode: 1 };
    return null;
  }, [detail, season, episode]);

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
          <div className="empty-state">
            <h3>No server can play this title</h3>
          </div>
        )}

        <div className="watch-top">
          <div className="watch-top-row">
            <button
              type="button"
              className="icon-btn"
              onClick={goBack}
              aria-label="Back"
            >
              {BackIcon}
            </button>
            {detail && (
              <p className="watch-top-title truncate" aria-hidden="true">
                {detail.title}
              </p>
            )}
            <ServerChips
              mediaRef={mediaRef}
              activeId={currentOption?.provider.id}
              onSelect={onSelectServer}
            />
          </div>

          {showWatchdog && (
            <div className="watchdog-bar" role="status">
              <span>Not playing? Try the next server</span>
              <div className="watchdog-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={advanceServer}
                  disabled={options.length < 2}
                >
                  Try next server
                </button>
                <button
                  type="button"
                  className="icon-btn watchdog-close"
                  onClick={() => setShowWatchdog(false)}
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="watch-bar">
        <div className="watch-now">
          {detail ? (
            <>
              <p className="watch-now-title truncate">{detail.title}</p>
              {type === "tv" && (
                <p className="watch-now-sub tiny">
                  Season {season} · Episode {episode}
                </p>
              )}
            </>
          ) : detailFailed ? (
            <p className="watch-now-sub tiny">
              Title details didn&rsquo;t load — playback still works.
            </p>
          ) : (
            <span className="skeleton skeleton--text watch-now-sk" aria-hidden="true" />
          )}
        </div>

        <div className="watch-actions">
          <button type="button" className="btn btn-primary" onClick={continueHere}>
            Continue
          </button>
          {type === "tv" && next && (
            <Link
              className="btn btn-secondary"
              to={`/watch/tv/${tmdbId}?s=${next.season}&e=${next.episode}`}
            >
              Next episode
            </Link>
          )}
        </div>

        <p className="tiny muted watch-note">
          {type === "tv"
            ? "Opens the episode you picked. The player\u2019s position can\u2019t be read back."
            : "Opens the title you picked. The player\u2019s position can\u2019t be read back."}
        </p>
      </footer>
    </div>
  );
}
