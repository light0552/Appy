import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
      <div className="hero-scrim" aria-hidden="true" />
      <div className="hero-body">
        <p className="eyebrow hero-eyebrow">Trending this week</p>
        <h1 className="hero-title">{media.title}</h1>
        {(media.year || media.rating > 0) && (
          <p className="hero-meta">
            {media.year && <span>{media.year}</span>}
            {media.year && media.rating > 0 && <span aria-hidden="true">·</span>}
            {media.rating > 0 && <span className="hero-rating">★ {media.rating.toFixed(1)}</span>}
          </p>
        )}
        {media.overview && <p className="hero-overview clamp-3">{media.overview}</p>}
        <div className="cluster hero-actions">
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
          <Link className="btn btn-secondary" to={`/title/${media.type}/${media.tmdbId}`}>
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
        <div className="skeleton skeleton--text hero-skeleton-line" />
        <div className="skeleton skeleton--text hero-skeleton-title" />
        <div className="skeleton skeleton--text hero-skeleton-line" />
      </div>
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
            <div className="skeleton skeleton--text" style={{ marginTop: 8, width: "78%" }} />
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
        <div className="row-error">
          <p className="muted">{section.error ?? "Couldn't load this row."}</p>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
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
      <p className="home-greeting">Back on the shelf, {activeProfile?.name ?? "friend"}.</p>

      {hero ? (
        <Hero media={hero} playHref={heroPlayHref} />
      ) : trending.loading ? (
        <HeroSkeleton />
      ) : trendingEmpty ? (
        <div className="empty-state">
          <h3>Nothing came back from the catalogue.</h3>
          <p>The shelves are bare for a moment. Give it another go.</p>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : trending.error ? (
        <div className="row-error">
          <p className="muted">{trending.error}</p>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
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
