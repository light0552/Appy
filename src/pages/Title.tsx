import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { backdropUrl, getSeason, getTitle, posterUrl, profileUrl } from "../lib/tmdb";
import { useSession } from "../lib/session";
import { liveHistory, mediaKey } from "../lib/store";
import type { Media, MediaType, SeasonDetail, TitleDetail } from "../types";
import "../styles/title.css";

/* Formatting ---------------------------------------------------------- */

function formatRuntime(minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function messageFor(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong.";
}

/* Icons ---------------------------------------------------------------- */

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

const PlayIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z" />
  </svg>
);

const StarIcon = (
  <svg
    className="title-pill__star"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M12 2.7l2.7 5.9 6.4.7-4.8 4.3 1.4 6.3L12 16.7l-5.7 3.2 1.4-6.3-4.8-4.3 6.4-.7L12 2.7Z" />
  </svg>
);

const PlusIcon = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
);

const CheckIcon = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ChevronIcon = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path d="m9 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const StillIcon = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M3 15.5l4.2-3.4a2 2 0 0 1 2.6 0L13 15l2.2-1.8a2 2 0 0 1 2.6 0L21 15.6" />
    <circle cx="9" cy="9.6" r="1.2" />
  </svg>
);

const BeamIcon = (
  <svg
    width="30"
    height="30"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <path d="M12 3.2v6.4" strokeLinecap="round" />
    <path d="M8.4 9.6h7.2l3.2 9.6H5.2l3.2-9.6Z" strokeLinejoin="round" />
    <path d="M6.6 16.4h10.8" strokeLinecap="round" opacity=".55" />
    <path d="M7.8 19.2h8.4" strokeLinecap="round" opacity=".3" />
  </svg>
);

/* Presentational helpers ----------------------------------------------- */

interface MetaPill {
  key: string;
  label: string;
  tone?: "accent" | "quiet";
  star?: boolean;
}

/** The quiet badge row under the title: year · runtime · rating · status. */
function MetaPills({ pills }: { pills: MetaPill[] }) {
  if (pills.length === 0) return null;
  return (
    <ul className="title-pills">
      {pills.map((pill) => (
        <li
          key={pill.key}
          className={`title-pill${pill.tone ? ` title-pill--${pill.tone}` : ""}`}
        >
          {pill.star && StarIcon}
          {pill.label}
        </li>
      ))}
    </ul>
  );
}

/** Mirrors the episode row exactly while a season loads. */
function EpisodeSkeleton() {
  return (
    <div className="episode-row" aria-hidden="true">
      <div className="skeleton sk-episode-thumb" />
      <div className="episode-body">
        <div className="skeleton sk-episode-kicker" />
        <div className="skeleton sk-episode-title" />
        <div className="skeleton sk-episode-meta" />
      </div>
    </div>
  );
}

export default function Title() {
  const params = useParams();
  const navigate = useNavigate();
  const session = useSession();

  const type: MediaType | null =
    params.type === "movie" || params.type === "tv" ? params.type : null;
  const tmdbId = Number.parseInt(params.id ?? "", 10);
  const validId = Number.isInteger(tmdbId) && tmdbId > 0;

  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);

  const [seasonDetail, setSeasonDetail] = useState<SeasonDetail | null>(null);
  const [seasonLoading, setSeasonLoading] = useState(false);
  const [seasonError, setSeasonError] = useState<string | null>(null);
  const [seasonAttempt, setSeasonAttempt] = useState(0);

  useEffect(() => {
    if (!type || !validId) return;
    let alive = true;

    setLoading(true);
    setError(null);
    setDetail(null);
    setOverviewOpen(false);
    setSelectedSeason(null);

    getTitle(type, tmdbId)
      .then((data) => {
        if (!alive) return;
        setDetail(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(messageFor(err));
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [type, tmdbId, validId, attempt]);

  // Default the season picker to the first season that has episodes.
  useEffect(() => {
    if (!detail || detail.type !== "tv") return;
    const first = detail.seasons.find((s) => s.episodeCount > 0);
    setSelectedSeason((prev) => prev ?? first?.seasonNumber ?? null);
  }, [detail]);

  useEffect(() => {
    if (!validId || selectedSeason === null) return;
    let alive = true;

    setSeasonLoading(true);
    setSeasonError(null);

    getSeason(tmdbId, selectedSeason)
      .then((data) => {
        if (!alive) return;
        setSeasonDetail(data);
        setSeasonLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setSeasonDetail(null);
        setSeasonError(messageFor(err));
        setSeasonLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [tmdbId, selectedSeason, seasonAttempt, validId]);

  const goBack = useCallback(() => {
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === "number" && state.idx > 0) navigate(-1);
    else navigate("/", { replace: true });
  }, [navigate]);

  const retry = () => setAttempt((value) => value + 1);
  const retrySeason = () => setSeasonAttempt((value) => value + 1);

  if (!type || !validId) return <Navigate to="/" replace />;

  if (loading) {
    return (
      <div className="title-page" aria-busy="true">
        <button
          type="button"
          className="icon-btn title-back"
          onClick={goBack}
          aria-label="Back"
        >
          {BackIcon}
        </button>
        <div className="title-art">
          <div className="skeleton sk-hero" />
        </div>
        <div className="title-body">
          <div className="skeleton sk-eyebrow" />
          <div className="skeleton sk-title" />
          <div className="sk-pills">
            <div className="skeleton sk-pill" />
            <div className="skeleton sk-pill" />
            <div className="skeleton sk-pill" />
          </div>
          <div className="skeleton sk-tagline" />
          <div className="sk-genres">
            <div className="skeleton sk-pill sk-pill--genre" />
            <div className="skeleton sk-pill sk-pill--genre" />
            <div className="skeleton sk-pill sk-pill--genre" />
          </div>
          <div className="sk-actions">
            <div className="skeleton sk-btn" />
            <div className="skeleton sk-btn sk-btn--narrow" />
          </div>
          <div className="skeleton sk-line sk-line--full" />
          <div className="skeleton sk-line sk-line--long" />
          <div className="skeleton sk-line sk-line--short" />
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="page title-page">
        <button
          type="button"
          className="icon-btn title-back"
          onClick={goBack}
          aria-label="Back"
        >
          {BackIcon}
        </button>
        <div className="empty-state title-empty">
          <span className="title-empty__icon" aria-hidden="true">
            {BeamIcon}
          </span>
          <h3>Couldn&rsquo;t load this title</h3>
          <p>{error ?? "Something went wrong."}</p>
          <button type="button" className="btn btn-primary" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const backdrop = backdropUrl(detail.backdropPath, "w1280");
  // No backdrop: fall back to the poster like Home's hero — blurred and let
  // the scrim carry the stage.
  const hero = backdrop ?? posterUrl(detail.posterPath, "w780");
  const media: Media = detail;
  const listId = mediaKey(detail.type, detail.tmdbId);
  const inList = session.isInWatchlist(listId);

  const toggleList = () => {
    if (inList) session.removeFromWatchlist(listId);
    else session.addToWatchlist(media);
  };

  const latestHistory = liveHistory(session.state).find(
    (item) => item.mediaType === detail.type && item.tmdbId === detail.tmdbId,
  );

  // Resume from the latest watch position when history has one; otherwise
  // default to the selected season's first episode.
  let playHref = `/watch/${detail.type}/${detail.tmdbId}`;
  if (detail.type === "tv" && selectedSeason !== null) {
    playHref = `/watch/tv/${detail.tmdbId}?s=${selectedSeason}&e=1`;
  }
  if (
    latestHistory &&
    latestHistory.mediaType === "tv" &&
    typeof latestHistory.season === "number" &&
    typeof latestHistory.episode === "number"
  ) {
    playHref = `/watch/tv/${latestHistory.tmdbId}?s=${latestHistory.season}&e=${latestHistory.episode}`;
  }

  // The same history entry marks the exact episode to pick up from.
  const resumePoint =
    latestHistory &&
    latestHistory.mediaType === "tv" &&
    typeof latestHistory.season === "number" &&
    typeof latestHistory.episode === "number"
      ? { season: latestHistory.season, episode: latestHistory.episode }
      : null;

  // The badge row: year · runtime · rating · status, as quiet pills.
  const pills: MetaPill[] = [];
  if (detail.year) pills.push({ key: "year", label: detail.year });
  if (detail.type === "tv") {
    const count = detail.seasons.length;
    pills.push({ key: "seasons", label: count === 1 ? "1 season" : `${count} seasons` });
  } else {
    const runtime = formatRuntime(detail.runtime);
    if (runtime) pills.push({ key: "runtime", label: runtime });
  }
  if (detail.rating > 0) {
    pills.push({ key: "rating", label: detail.rating.toFixed(1), tone: "accent", star: true });
  }
  if (detail.status) pills.push({ key: "status", label: detail.status, tone: "quiet" });

  const visibleSeasons = detail.seasons.filter((s) => s.episodeCount > 0);

  return (
    <div className="title-page">
      <button
        type="button"
        className="icon-btn title-back"
        onClick={goBack}
        aria-label="Back"
      >
        {BackIcon}
      </button>

      <div className="title-art">
        <div
          className={`title-hero${hero ? "" : " title-hero--empty"}${
            hero && !backdrop ? " title-hero--poster" : ""
          }`}
        >
          {hero && (
            <div className="title-hero__art">
              <img src={hero} alt="" decoding="async" />
            </div>
          )}
          <div className="title-hero__beam" aria-hidden="true" />
          <div className="title-hero__scrim" aria-hidden="true" />
          {detail.imdbId && (
            <p className="title-hero__plate">
              <span className="title-plate__key">IMDb</span>
              <span className="title-plate__id">{detail.imdbId}</span>
            </p>
          )}
        </div>
      </div>

      <div className="title-body">
        <p className="eyebrow title-eyebrow">
          {detail.type === "tv" ? "Series" : "Movie"}
        </p>
        <h1 className="display title-heading">{detail.title}</h1>

        <MetaPills pills={pills} />

        {detail.tagline && <p className="title-tagline">{detail.tagline}</p>}

        {detail.genres.length > 0 && (
          <div className="chip-row title-genres" role="group" aria-label="Genres">
            {detail.genres.map((genre) => (
              <span key={genre} className="chip">
                {genre}
              </span>
            ))}
          </div>
        )}

        <div className="cluster title-actions">
          <Link className="btn btn-primary" to={playHref}>
            {PlayIcon}
            Play
          </Link>
          <button
            type="button"
            className="btn btn-secondary"
            aria-pressed={inList}
            onClick={toggleList}
          >
            {inList ? CheckIcon : PlusIcon}
            {inList ? "In My List" : "My List"}
          </button>
        </div>

        {detail.overview && (
          <div className="title-overview">
            <p className={overviewOpen ? undefined : "clamp-3"}>{detail.overview}</p>
            {detail.overview.length > 180 && (
              <button
                type="button"
                className="title-more"
                aria-expanded={overviewOpen}
                onClick={() => setOverviewOpen((open) => !open)}
              >
                {overviewOpen ? "Less" : "More"}
              </button>
            )}
          </div>
        )}

        {detail.type === "tv" && visibleSeasons.length > 0 && (
          <section className="title-section">
            <div className="title-section-head">
              <h2 className="title-section-title">Episodes</h2>
              {seasonDetail && !seasonError && (
                <span className="title-section-count">
                  {seasonDetail.episodes.length} episodes
                </span>
              )}
              <span className="title-section-rule" aria-hidden="true" />
            </div>

            <div className="chip-row title-seasons" role="group" aria-label="Seasons">
              {visibleSeasons.map((s) => (
                <button
                  key={s.seasonNumber}
                  type="button"
                  className={`chip${selectedSeason === s.seasonNumber ? " chip--active" : ""}`}
                  aria-pressed={selectedSeason === s.seasonNumber}
                  onClick={() => setSelectedSeason(s.seasonNumber)}
                >
                  {s.name}
                </button>
              ))}
            </div>

            {seasonLoading && (
              <div className="episode-list" aria-busy="true">
                <EpisodeSkeleton />
                <EpisodeSkeleton />
                <EpisodeSkeleton />
              </div>
            )}

            {!seasonLoading && seasonError && (
              <div className="empty-state title-empty title-empty--inline">
                <p>{seasonError}</p>
                <button type="button" className="btn btn-sm" onClick={retrySeason}>
                  Try again
                </button>
              </div>
            )}

            {!seasonLoading && !seasonError && seasonDetail && (
              <ul className="episode-list">
                {seasonDetail.episodes.length === 0 && (
                  <li className="episode-empty">No episodes listed for this season.</li>
                )}
                {seasonDetail.episodes.map((ep) => {
                  const still = backdropUrl(ep.stillPath, "w300");
                  const runtime = formatRuntime(ep.runtime);
                  const air = formatDate(ep.airDate);
                  const isResume =
                    resumePoint !== null &&
                    resumePoint.season === seasonDetail.seasonNumber &&
                    resumePoint.episode === ep.episodeNumber;
                  return (
                    <li key={ep.episodeNumber}>
                      <Link
                        className={`episode-row${isResume ? " episode-row--resume" : ""}`}
                        to={`/watch/tv/${detail.tmdbId}?s=${seasonDetail.seasonNumber}&e=${ep.episodeNumber}`}
                      >
                        <span className="episode-thumb">
                          {still ? (
                            <img src={still} alt="" loading="lazy" decoding="async" />
                          ) : (
                            <span className="episode-thumb-fallback" aria-hidden="true">
                              {StillIcon}
                            </span>
                          )}
                        </span>
                        <span className="episode-body">
                          <span className="episode-kicker">
                            Episode {ep.episodeNumber}
                          </span>
                          <span className="episode-title clamp-2">
                            {ep.name || `Episode ${ep.episodeNumber}`}
                          </span>
                          <span className="episode-meta">
                            {runtime && <span>{runtime}</span>}
                            {air && <span>{air}</span>}
                            {isResume && <span className="episode-flag">Resume</span>}
                          </span>
                        </span>
                        <span className="episode-go" aria-hidden="true">
                          {ChevronIcon}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {detail.cast.length > 0 && (
          <section className="title-section">
            <div className="title-section-head">
              <h2 className="title-section-title">Cast</h2>
              <span className="title-section-count">{detail.cast.length} credited</span>
              <span className="title-section-rule" aria-hidden="true" />
            </div>
            <ul className="cast-row scroll-x">
              {detail.cast.map((member) => {
                const src = profileUrl(member.profilePath);
                return (
                  <li key={member.id} className="cast-card">
                    <span className="cast-avatar" aria-hidden="true">
                      {src ? (
                        <img src={src} alt="" loading="lazy" decoding="async" />
                      ) : (
                        member.name.slice(0, 1)
                      )}
                    </span>
                    <span className="cast-name truncate" title={member.name}>
                      {member.name}
                    </span>
                    {member.character && (
                      <span className="cast-character truncate" title={member.character}>
                        {member.character}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
