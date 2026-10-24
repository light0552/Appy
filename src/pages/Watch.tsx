import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Player from "../components/Player";
import HlsPlayer from "../components/HlsPlayer";
import ServerChips from "../components/ServerChips";
import { availableProviders, preferredUrl, providerById, type ProviderOption } from "../lib/providers";
import { backdropUrl, getTitle } from "../lib/tmdb";
import { resolveRip, type RipOk } from "../lib/rip";
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

/* ---------------------------------------------------------------- */
/* Lighthook playback modes (2026-10-24)                            */
/* "preparing" = resolving the ad-free stream via the sidecar,      */
/* "owned" = playing our own proxied stream in HlsPlayer,           */
/* "embed" = today's cross-origin iframe providers, unchanged.      */
/* ---------------------------------------------------------------- */

const LIGHTHOOK_ID = "lighthook";

type PlayMode = "preparing" | "owned" | "embed";

/** True when the stored pick names a real embed provider (not Lighthook). */
function isEmbedPref(id: string | undefined): boolean {
  return !!id && id !== LIGHTHOOK_ID && !!providerById(id);
}

/** Mount/param/reload entry rule: an explicit provider pick wins; else rip. */
function initialMode(pref: string | undefined): PlayMode {
  return isEmbedPref(pref) ? "embed" : "preparing";
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

  /* ---------------------------------------------------------------- */
  /* Lighthook — rip-first playback (2026-10-24)                      */
  /* ---------------------------------------------------------------- */

  const preferredProvider = session.state.prefs.preferredProvider;
  // First render may predate session hydration (async boot) — the
  // "prefs hydrate" effect below applies a stored provider pick as soon as
  // it lands, so an explicit past choice still wins over ripping.
  const [mode, setMode] = useState<PlayMode>(() => initialMode(preferredProvider));
  const [rip, setRip] = useState<RipOk | null>(null);
  const [ripElapsed, setRipElapsed] = useState(0);
  const [ripNote, setRipNote] = useState<string | null>(null);
  const ripFailedRef = useRef(false);
  const ripNoteTimerRef = useRef(0);

  /** Shows the one-line fallback note for ~4.5s, replacing any pending timer. */
  const flashRipNote = useCallback((text: string) => {
    window.clearTimeout(ripNoteTimerRef.current);
    setRipNote(text);
    ripNoteTimerRef.current = window.setTimeout(() => setRipNote(null), 4500);
  }, []);

  // Unmount: never leave the note timer firing into a dead page.
  useEffect(() => {
    return () => window.clearTimeout(ripNoteTimerRef.current);
  }, []);

  // Latest stored preference without re-triggering the param-reset effect
  // (prefs also change on chip picks and cross-device sync merges).
  const prefRef = useRef(preferredProvider);
  useEffect(() => {
    prefRef.current = preferredProvider;
  }, [preferredProvider]);

  // A new title/episode restarts the machine. A resolve that already failed
  // for THIS media is remembered so "Continue" re-enters embed directly
  // instead of burning another 45s sidecar timeout.
  useEffect(() => {
    ripFailedRef.current = false;
    window.clearTimeout(ripNoteTimerRef.current);
    setRipNote(null);
    setRip(null);
    setRipElapsed(0);
    setShowWatchdog(false);
    setMode(initialMode(prefRef.current));
  }, [type, tmdbId, season, episode]);

  // Session prefs hydrate asynchronously after mount, so an explicit past
  // provider pick is honored the moment it lands: still "preparing" and a
  // real stored provider → embed. Explicit chip picks during this session
  // set embed mode themselves, so this never fights the user.
  useEffect(() => {
    if (mode !== "preparing") return;
    if (isEmbedPref(preferredProvider)) setMode("embed");
  }, [mode, preferredProvider]);

  // The sidecar resolve. Gated on detail (or a definitive detail failure):
  // imdbId unlocks VidFast/Vidsrc resolution server-side. Any mode flip,
  // param change or unmount aborts silently (AbortController + alive flag).
  useEffect(() => {
    if (mode !== "preparing") return;
    if (!detail && !detailFailed) return;
    if (ripFailedRef.current) {
      setMode("embed"); // already failed here — don't re-burn the timeout
      return;
    }

    const controller = new AbortController();
    let alive = true;
    resolveRip(mediaRef, { signal: controller.signal }).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setRip(result);
        setMode("owned");
      } else {
        ripFailedRef.current = true;
        // Honest one-line reason before the embed takes over (any of: the
        // providers genuinely have no stream, the sidecar timed out, or the
        // extractor crashed even after its auto-retry).
        flashRipNote("No ad-free source for this title right now — regular servers below.");
        setMode("embed");
      }
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [mode, mediaRef, detail, detailFailed, flashRipNote]);

  // Live elapsed counter while resolving; the display caps at 40s.
  useEffect(() => {
    if (mode !== "preparing") return;
    const timer = window.setInterval(() => setRipElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [mode]);

  // Background reachability check. It never delays the first iframe — the first
  // server paints immediately and this may only swap it before the user
  // interacts. Registry order is playability order (harness-verified 2026-10-22:
  // only VidLink actually plays), so raw latency may not demote the first server.
  // A swap happens only when the first server does not answer at all.
  // 2026-10-24: the probe is an embed-mode tiebreaker — it must not fetch
  // provider hosts while the ad-free path is preparing/playing.
  useEffect(() => {
    if (mode !== "embed") return;
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
  }, [options, preferred, mode]);

  const currentOption: ProviderOption | undefined = useMemo(() => {
    if (preferred) return options.find((option) => option.url === preferred);
    if (probeWinner) return options.find((option) => option.provider.id === probeWinner);
    return options[0];
  }, [options, preferred, probeWinner]);

  const url = currentOption?.url;

  const frameTitle = detail
    ? `${detail.title}${season !== undefined && episode !== undefined ? ` — S${season} E${episode}` : ""}`
    : "Player";

  /** Poster shown by the ad-free player while the stream spins up (2026-10-24). */
  const framePoster = backdropUrl(detail?.backdropPath, "w780");

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
      // 2026-10-24 — the Lighthook chip (re-)enters ad-free mode and
      // re-resolves; a warm sidecar cache answers instantly and skips
      // straight back to "owned". Persisted like provider picks so the next
      // visit starts ad-free too — never falls through to the embed logic.
      if (id === LIGHTHOOK_ID) {
        ripFailedRef.current = false; // an explicit pick always retries
        setRip(null);
        setRipElapsed(0);
        setMode("preparing");
        if (prefRef.current !== LIGHTHOOK_ID) {
          session.setPrefs({ preferredProvider: LIGHTHOOK_ID });
        }
        return;
      }
      // A real provider chip always lands in iframe mode (2026-10-24).
      setMode("embed");
      if (id !== currentOption?.provider.id) {
        session.setPrefs({ preferredProvider: id }); // url changes -> Player restarts its 6s timer
      } else {
        setReloadKey((value) => value + 1); // same server re-picked -> force reload + fresh timer
      }
    },
    [currentOption, session],
  );

  /**
   * Cycles to the next available server in registry order, wrapping around.
   * 2026-10-24: `options` only ever holds real providers — "lighthook" is a
   * chip, not an option — so this can never advance onto it, and the prefs
   * it persists always name a real embed provider.
   */
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
    // 2026-10-24 — a reloadKey bump restarts the mode machine with the same
    // entry rule as mount: an explicit stored provider goes straight to
    // embed; otherwise re-prepare the ad-free stream. Once a resolve has
    // failed for this media, embed stays (no repeated 45s timeouts).
    if (!isEmbedPref(prefRef.current) && !ripFailedRef.current) {
      setRip(null);
      setRipElapsed(0);
      setMode("preparing");
    }
  }, []);

  // 2026-10-24 — the ad-free engine gave up (fatal error, no recovery):
  // fall back to the iframe providers WITHOUT persisting a provider pick —
  // the user never chose one. The normal watchdog cycle in embed mode takes
  // over from here.
  const handleRipUnrecoverable = useCallback(() => {
    ripFailedRef.current = true; // this media's stream is dead — don't retry on Continue
    flashRipNote("Ad-free stream ended — switched to regular servers.");
    setMode("embed");
  }, [flashRipNote]);

  // 2026-10-24 — manual "Play with regular servers →": aborts the in-flight
  // resolve (the resolve effect's cleanup) and switches to embed. Counts as
  // an interaction so the background probe can't swap servers afterwards.
  const switchToEmbed = useCallback(() => {
    ripFailedRef.current = true; // the user explicitly chose embed — remember for Continue
    interactedRef.current = true;
    setMode("embed");
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
        {mode === "preparing" ? (
          // 2026-10-24 — same frame geometry as the players; the elapsed
          // counter is capped at 40s but the abort button works throughout.
          <div className="rip-stage" role="status">
            <span className="rip-spinner" aria-hidden="true" />
            <p className="rip-text">Preparing ad-free stream&hellip;</p>
            <p className="rip-elapsed tiny muted">{Math.min(ripElapsed, 90)}s</p>
            {ripElapsed >= 25 && (
              <p className="rip-elapsed tiny muted">
                Waking the source on your home server&hellip;
              </p>
            )}
            <button type="button" className="btn btn-secondary" onClick={switchToEmbed}>
              Play with regular servers &rarr;
            </button>
          </div>
        ) : mode === "owned" && rip ? (
          <HlsPlayer
            key={`${rip.playlistUrl}#${reloadKey}`}
            kind={rip.kind}
            src={rip.playlistUrl}
            title={frameTitle}
            poster={framePoster}
            subs={rip.subs}
            onUnrecoverable={handleRipUnrecoverable}
          />
        ) : url ? (
          <Player key={reloadKey} url={url} title={frameTitle} onTimeout={handleTimeout} />
        ) : (
          <div className="empty-state">
            <h3>No server can play this title</h3>
          </div>
        )}

        {/* Honest fallback note flashed when the ad-free handoff to embed
            happens for a reason the user can act on (2026-10-24). */}
        {ripNote && mode === "embed" && (
          <div className="rip-note" role="status">{ripNote}</div>
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
              mode={mode === "preparing" ? "ripping" : mode === "owned" ? "owned" : "embed"}
              activeId={mode === "embed" ? currentOption?.provider.id : LIGHTHOOK_ID}
              onSelect={onSelectServer}
            />
          </div>

          {showWatchdog && mode === "embed" && (
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
          {mode === "owned" ? (
            "You're watching the ad-free Lighthook stream — served locally, nothing to block."
          ) : type === "tv" ? (
            "Opens the episode you picked. The player\u2019s position can\u2019t be read back."
          ) : (
            "Opens the title you picked. The player\u2019s position can\u2019t be read back."
          )}
        </p>
      </footer>
    </div>
  );
}
