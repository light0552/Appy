import { Fragment, useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { backdropUrl, getSeason, getTitle, posterUrl, profileUrl } from "../lib/tmdb";
import { useSession } from "../lib/session";
import { liveHistory, mediaKey } from "../lib/store";
import type { Media, MediaType, SeasonDetail, TitleDetail } from "../types";
import "../styles/title.css";

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
        <div className="skeleton sk-hero" />
        <div className="title-body">
          <div className="skeleton sk-title" />
          <div className="skeleton sk-meta" />
          <div className="skeleton sk-line sk-line--full" />
          <div className="skeleton sk-line sk-line--long" />
          <div className="skeleton sk-line sk-line--short" />
          <div className="sk-btn-row">
            <div className="skeleton sk-btn" />
            <div className="skeleton sk-btn sk-btn--narrow" />
          </div>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="page title-page">
        <button type="button" className="icon-btn title-back" onClick={goBack} aria-label="Back">
          {BackIcon}
        </button>
        <div className="empty-state">
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

  // Resume from the latest watch position when history has one; otherwise
  // default to the selected season's first episode.
  let playHref = `/watch/${detail.type}/${detail.tmdbId}`;
  if (detail.type === "tv" && selectedSeason !== null) {
    playHref = `/watch/tv/${detail.tmdbId}?s=${selectedSeason}&e=1`;
  }
  const latestHistory = liveHistory(session.state).find(
    (item) => item.mediaType === detail.type && item.tmdbId === detail.tmdbId,
  );
  if (
    latestHistory &&
    latestHistory.mediaType === "tv" &&
    typeof latestHistory.season === "number" &&
    typeof latestHistory.episode === "number"
  ) {
    playHref = `/watch/tv/${latestHistory.tmdbId}?s=${latestHistory.season}&e=${latestHistory.episode}`;
  }

  const metaParts: string[] = [];
  if (detail.year) metaParts.push(detail.year);
  if (detail.type === "tv") {
    const count = detail.seasons.length;
    metaParts.push(count === 1 ? "1 season" : `${count} seasons`);
  } else {
    const runtime = formatRuntime(detail.runtime);
    if (runtime) metaParts.push(runtime);
  }
  if (detail.rating > 0) metaParts.push(`★ ${detail.rating.toFixed(1)}`);
  if (detail.status) metaParts.push(detail.status);

  const visibleSeasons = detail.seasons.filter((s) => s.episodeCount > 0);

  return (
    <div className="title-page">
      <button type="button" className="icon-btn title-back" onClick={goBack} aria-label="Back">
        {BackIcon}
      </button>

      <div
        className={`title-hero${hero ? "" : " title-hero--empty"}${
          hero && !backdrop ? " title-hero--poster" : ""
        }`}
      >
        {hero && <img src={hero} alt="" decoding="async" />}
      </div>

      <div className="title-body">
        <p className="eyebrow title-eyebrow">{detail.type === "tv" ? "Series" : "Movie"}</p>
        <h1 className="display title-heading">{detail.title}</h1>

        {metaParts.length > 0 && (
          <div className="title-meta">
            {metaParts.map((part, index) => (
              <Fragment key={part}>
                {index > 0 && <span aria-hidden="true">·</span>}
                <span className={part.startsWith("★") ? "title-rating" : undefined}>{part}</span>
              </Fragment>
            ))}
            {detail.imdbId && (
              <Fragment>
                <span aria-hidden="true">·</span>
                <span>IMDb {detail.imdbId}</span>
              </Fragment>
            )}
          </div>
        )}

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
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z" />
            </svg>
            Play
          </Link>
          <button
            type="button"
            className="btn btn-secondary"
            aria-pressed={inList}
            onClick={toggleList}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              {inList ? (
                <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              )}
            </svg>
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
            <h2 className="title-section-title">Episodes</h2>
            <div className="chip-row" role="group" aria-label="Seasons">
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
              <div className="stack" style={{ marginTop: 14, gap: 10 }} aria-busy="true">
                <div className="skeleton episode-sk" />
                <div className="skeleton episode-sk" />
                <div className="skeleton episode-sk" />
              </div>
            )}

            {!seasonLoading && seasonError && (
              <div className="empty-state">
                <p>{seasonError}</p>
                <button type="button" className="btn btn-sm" onClick={retrySeason}>
                  Try again
                </button>
              </div>
            )}

            {!seasonLoading && !seasonError && seasonDetail && (
              <ul className="episode-list" style={{ marginTop: 14 }}>
                {seasonDetail.episodes.map((ep) => {
                  const still = backdropUrl(ep.stillPath, "w300");
                  const runtime = formatRuntime(ep.runtime);
                  const air = formatDate(ep.airDate);
                  return (
                    <li key={ep.episodeNumber}>
                      <Link
                        className="episode-row"
                        to={`/watch/tv/${detail.tmdbId}?s=${seasonDetail.seasonNumber}&e=${ep.episodeNumber}`}
                      >
                        <div className="episode-thumb">
                          {still ? (
                            <img src={still} alt="" loading="lazy" decoding="async" />
                          ) : (
                            <div className="episode-thumb-fallback">E{ep.episodeNumber}</div>
                          )}
                        </div>
                        <div className="episode-body">
                          <p className="episode-title clamp-2">
                            E{ep.episodeNumber} · {ep.name}
                          </p>
                          <p className="episode-meta tiny">
                            {[runtime, air].filter(Boolean).join(" · ")}
                          </p>
                        </div>
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
            <h2 className="title-section-title">Cast</h2>
            <ul className="cast-row scroll-x">
              {detail.cast.map((member) => {
                const src = profileUrl(member.profilePath);
                return (
                  <li key={member.id} className="cast-card">
                    <div className="cast-avatar">
                      {src ? (
                        <img src={src} alt="" loading="lazy" decoding="async" />
                      ) : (
                        member.name.slice(0, 1)
                      )}
                    </div>
                    <p className="cast-name truncate" title={member.name}>
                      {member.name}
                    </p>
                    {member.character && (
                      <p className="cast-character truncate" title={member.character}>
                        {member.character}
                      </p>
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
