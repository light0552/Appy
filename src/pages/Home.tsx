import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Link } from "react-router-dom";
import PosterCard from "../components/PosterCard";
import Row from "../components/Row";
import {
  backdropUrl,
  getPopularMovies,
  getPopularTv,
  getTrending,
  posterUrl,
} from "../lib/tmdb";
import { initials } from "../lib/profiles";
import { liveHistory, mediaKey } from "../lib/store";
import { useSession } from "../lib/session";
import type { HistoryItem, Media } from "../types";
import "../styles/home.css";

interface SectionState {
  items: Media[] | null;
  error: string | null;
  loading: boolean;
}

const INITIAL_SECTION: SectionState = { items: null, error: null, loading: true };

function relativeTime(at: number): string {
  const elapsed = Date.now() - at;
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function episodeBadge(item: HistoryItem): string {
  if (item.mediaType === "tv") {
    if (typeof item.season === "number" && typeof item.episode === "number") {
      return `S${item.season} · E${item.episode}`;
    }
    return "TV";
  }
  return "Movie";
}

function playerHref(item: HistoryItem): string {
  if (item.mediaType === "tv") {
    if (typeof item.season === "number" && typeof item.episode === "number") {
      return `/watch/tv/${item.tmdbId}?s=${item.season}&e=${item.episode}`;
    }
    return `/watch/tv/${item.tmdbId}`;
  }
  return `/watch/movie/${item.tmdbId}`;
}

/* Icons ---------------------------------------------------------------- */

function IconPlay() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z" />
    </svg>
  );
}

function IconPlus() {
  return (
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
}

function IconCheck() {
  return (
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
}

function IconInfo() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11.2v5M12 7.9v.4" />
    </svg>
  );
}

function IconStar() {
  return (
    <svg
      className="hero-rating__star"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2.7l2.7 5.9 6.4.7-4.8 4.3 1.4 6.3L12 16.7l-5.7 3.2 1.4-6.3-4.8-4.3 6.4-.7L12 2.7Z" />
    </svg>
  );
}

function IconBeam() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M12 3.2v6.4" strokeLinecap="round" />
      <path d="M8.4 9.6h7.2l3.2 9.6H5.2l3.2-9.6Z" strokeLinejoin="round" />
      <path d="M6.6 16.4h10.8" strokeLinecap="round" opacity=".55" />
      <path d="M7.8 19.2h8.4" strokeLinecap="round" opacity=".3" />
    </svg>
  );
}

function IconFault() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4.4 21 19.6H3L12 4.4Z" />
      <path d="M12 10.2v3.9" />
      <path d="M12 16.9v.5" />
    </svg>
  );
}

/* Header --------------------------------------------------------------- */

function HomeHeader({ name, color }: { name: string; color: string }) {
  return (
    <header className="home-header">
      <Link className="home-brand" to="/" aria-label="LIGHTH00K, back to the front page">
        <span className="home-brand__mark" aria-hidden="true">
          L
        </span>
        <span className="home-brand__name">LIGHTH00K</span>
      </Link>

      <p className="home-greeting truncate">Back on the shelf, {name}.</p>

      <Link
        className="home-profile"
        to="/profiles"
        aria-label={`Active profile ${name}. Switch profile.`}
      >
        <span
          className="avatar home-profile__avatar"
          style={color ? ({ "--profile-color": color } as CSSProperties) : undefined}
          aria-hidden="true"
        >
          {initials(name)}
        </span>
        <span className="home-profile__name truncate">{name}</span>
      </Link>
    </header>
  );
}

/* Hero ----------------------------------------------------------------- */

function Hero({ media, playHref }: { media: Media; playHref: string }) {
  const session = useSession();
  const backdrop = backdropUrl(media.backdropPath, "w1280");
  const poster = posterUrl(media.posterPath, "w780");
  const art = backdrop ?? poster;

  const listId = mediaKey(media.type, media.tmdbId);
  const inList = session.isInWatchlist(listId);
  const toggleList = () => {
    if (inList) session.removeFromWatchlist(listId);
    else session.addToWatchlist(media);
  };

  return (
    <section className="hero" aria-label={`Featured: ${media.title}`}>
      {art && (
        <div className="hero-art">
          <img
            className={backdrop ? "hero-img" : "hero-img hero-img--poster"}
            src={art}
            alt=""
            decoding="async"
          />
        </div>
      )}
      <div className="hero-beam" aria-hidden="true" />
      <div className="hero-scrim" aria-hidden="true" />
      <div className="hero-body">
        <p className="eyebrow hero-eyebrow">
          <span className="hero-eyebrow-dot" aria-hidden="true" />
          In the spotlight
        </p>
        <h1 className="hero-title">{media.title}</h1>
        {(media.year || media.rating > 0) && (
          <p className="hero-meta">
            {media.year && <span className="hero-meta__year">{media.year}</span>}
            {media.year && media.rating > 0 && (
              <span className="hero-meta__dot" aria-hidden="true" />
            )}
            {media.rating > 0 && (
              <span className="hero-rating">
                <IconStar />
                {media.rating.toFixed(1)}
              </span>
            )}
          </p>
        )}
        {media.overview && <p className="hero-overview clamp-3">{media.overview}</p>}
        <div className="cluster hero-actions">
          <Link className="btn btn-primary" to={playHref}>
            <IconPlay />
            Play
          </Link>
          <button
            type="button"
            className="btn btn-secondary"
            aria-pressed={inList}
            onClick={toggleList}
          >
            {inList ? <IconCheck /> : <IconPlus />}
            {inList ? "In My List" : "My List"}
          </button>
          <Link className="btn btn-secondary" to={`/title/${media.type}/${media.tmdbId}`}>
            <IconInfo />
            More info
          </Link>
        </div>
      </div>
    </section>
  );
}

function HeroSkeleton() {
  return (
    <div className="hero hero--skeleton" aria-hidden="true">
      <div className="skeleton hero-skeleton-fill" />
      <div className="hero-body">
        <div className="skeleton skeleton--text hero-skeleton-eyebrow" />
        <div className="skeleton skeleton--text hero-skeleton-title" />
        <div className="skeleton skeleton--text hero-skeleton-meta" />
        <div className="skeleton skeleton--text hero-skeleton-line" />
        <div className="skeleton skeleton--text hero-skeleton-line hero-skeleton-line--short" />
        <div className="hero-skeleton-actions">
          <div className="skeleton hero-skeleton-btn" />
          <div className="skeleton hero-skeleton-btn" />
          <div className="skeleton hero-skeleton-btn" />
        </div>
      </div>
    </div>
  );
}

/* Shelf states --------------------------------------------------------- */

function ShelfError({
  message,
  onRetry,
  className = "",
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div className={`row-error ${className}`.trim()}>
      <span className="row-error__icon" aria-hidden="true">
        <IconFault />
      </span>
      <div className="row-error__copy">
        <p className="row-error__title">That shelf stayed dark.</p>
        <p className="row-error__text">{message}</p>
      </div>
      <button type="button" className="btn btn-sm row-error__retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function MediaRow({
  title,
  to,
  section,
  onRetry,
}: {
  title: string;
  /** Route for the "See all" link; the Continue Watching row passes none. */
  to: string;
  section: SectionState;
  onRetry: () => void;
}) {
  if (section.loading && !section.items) {
    return (
      <Row title={title}>
        {Array.from({ length: 6 }, (_, index) => (
          <div className="row-poster" key={index} aria-hidden="true">
            <div className="skeleton skeleton--poster" />
            <div className="skeleton skeleton--text home-sk-title" />
            <div className="skeleton skeleton--text home-sk-sub" />
          </div>
        ))}
      </Row>
    );
  }

  if (!section.items) {
    return (
      <section className="row">
        <div className="section-head">
          <h2>{title}</h2>
        </div>
        <ShelfError message={section.error ?? "Couldn't load this row."} onRetry={onRetry} />
      </section>
    );
  }

  if (section.items.length === 0) return null;

  return (
    <Row
      title={title}
      action={section.error ? { label: "Retry", onClick: onRetry } : { label: "See all", to }}
    >
      {section.items.map((media) => (
        <div className="row-poster" key={`${media.type}-${media.tmdbId}`}>
          <PosterCard
            type={media.type}
            tmdbId={media.tmdbId}
            title={media.title}
            posterPath={media.posterPath}
            year={media.year}
          />
        </div>
      ))}
    </Row>
  );
}

export default function Home() {
  const { state, activeProfile } = useSession();
  const [trending, setTrending] = useState<SectionState>(INITIAL_SECTION);
  const [movies, setMovies] = useState<SectionState>(INITIAL_SECTION);
  const [tv, setTv] = useState<SectionState>(INITIAL_SECTION);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const results: PromiseSettledResult<Media[]>[] = await Promise.allSettled([
        getTrending(),
        getPopularMovies(),
        getPopularTv(),
      ]);
      const setters: Dispatch<SetStateAction<SectionState>>[] = [setTrending, setMovies, setTv];
      results.forEach((result, index) => {
        const set = setters[index];
        if (result.status === "fulfilled") {
          set({ items: result.value, error: null, loading: false });
        } else {
          const message =
            result.reason instanceof Error
              ? result.reason.message
              : "Couldn't reach the catalogue.";
          // Keep whatever we already had on screen; only flag the failure.
          set((prev) => ({ ...prev, error: message, loading: false }));
        }
      });
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-fetch the lists when the app returns to the foreground, keeping old data.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const continueItems = useMemo<HistoryItem[]>(() => {
    const seen = new Set<string>();
    const out: HistoryItem[] = [];
    for (const item of liveHistory(state)) {
      const key = mediaKey(item.mediaType, item.tmdbId);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= 8) break;
    }
    return out;
  }, [state]);

  const hero = trending.items?.[0] ?? null;
  const trendingEmpty = trending.items !== null && trending.items.length === 0;

  // Resume TV titles from the user's latest episode instead of restarting at S1E1.
  const heroPlayHref = useMemo(() => {
    if (!hero) return "/";
    const latest = liveHistory(state).find(
      (item) => item.mediaType === hero.type && item.tmdbId === hero.tmdbId,
    );
    if (
      latest &&
      latest.mediaType === "tv" &&
      typeof latest.season === "number" &&
      typeof latest.episode === "number"
    ) {
      return `/watch/tv/${latest.tmdbId}?s=${latest.season}&e=${latest.episode}`;
    }
    return `/watch/${hero.type}/${hero.tmdbId}`;
  }, [hero, state]);

  return (
    <div className="home">
      <HomeHeader
        name={activeProfile?.name ?? "friend"}
        color={activeProfile?.color ?? ""}
      />

      {hero ? (
        <Hero media={hero} playHref={heroPlayHref} />
      ) : trending.loading ? (
        <HeroSkeleton />
      ) : trendingEmpty ? (
        <div className="empty-state home-empty">
          <span className="home-empty__icon" aria-hidden="true">
            <IconBeam />
          </span>
          <h3>Nothing came back from the catalogue.</h3>
          <p>The shelves are bare for a moment. Give it another go.</p>
          <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : trending.error ? (
        <ShelfError
          message={trending.error}
          onRetry={() => void refresh()}
          className="row-error--page"
        />
      ) : null}

      {continueItems.length > 0 && (
        <Row title="Continue watching">
          {continueItems.map((item) => (
            <div className="row-poster" key={item.id}>
              <PosterCard
                type={item.mediaType}
                tmdbId={item.tmdbId}
                title={item.title}
                posterPath={item.posterPath}
                badge={episodeBadge(item)}
                subtitle={relativeTime(item.watchedAt)}
                to={playerHref(item)}
              />
            </div>
          ))}
        </Row>
      )}

      <MediaRow title="Trending this week" to="/browse/trending" section={trending} onRetry={refresh} />
      <MediaRow title="Popular movies" to="/browse/movies" section={movies} onRetry={refresh} />
      <MediaRow title="Popular TV" to="/browse/tv" section={tv} onRetry={refresh} />
    </div>
  );
}
