import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import PosterCard from "../components/PosterCard";
import { getCatalogPage, type CatalogKind } from "../lib/tmdb";
import type { Media } from "../types";
import "../styles/browse.css";

const KIND_TITLES: Record<CatalogKind, string> = {
  trending: "Trending this week",
  movies: "Popular movies",
  tv: "Popular TV",
};

/** One supporting line under the title — the page's reason for existing. */
const KIND_BLURBS: Record<CatalogKind, string> = {
  trending: "What the house is watching right now, refreshed every week.",
  movies: "The films that keep coming back around.",
  tv: "Series after series, ready whenever you are.",
};

function isCatalogKind(value: string | undefined): value is CatalogKind {
  return value === "trending" || value === "movies" || value === "tv";
}

function messageFor(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong.";
}

function mediaKeyOf(media: Media): string {
  return `${media.type}-${media.tmdbId}`;
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

const ChevronDown = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const FaultIcon = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 4.4 21 19.6H3L12 4.4Z" />
    <path d="M12 10.2v3.9" />
    <path d="M12 16.9v.5" />
  </svg>
);

/** An empty shelf — the glyph for a catalogue that came back with nothing. */
const ShelfIcon = (
  <svg
    width="30"
    height="30"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="5" height="7" rx="1.6" />
    <rect x="10" y="4" width="5" height="7" rx="1.6" />
    <rect x="17" y="4" width="4" height="7" rx="1.6" />
    <rect x="3" y="13" width="5" height="7" rx="1.6" />
    <rect x="10" y="13" width="11" height="7" rx="1.6" />
  </svg>
);

export default function Browse() {
  const { kind: kindParam } = useParams();
  const navigate = useNavigate();
  const kind: CatalogKind | null = isCatalogKind(kindParam) ? kindParam : null;

  const [items, setItems] = useState<Media[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Bumped on every kind change / retry so late responses from a previous
  // catalogue can never land on the current one.
  const requestSeq = useRef(0);

  // Initial load + full reset whenever the kind changes.
  useEffect(() => {
    if (!kind) return;
    const seq = ++requestSeq.current;

    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(null);
    setItems([]);
    setPage(1);
    setTotalPages(1);
    window.scrollTo({ top: 0, behavior: "auto" });

    getCatalogPage(kind, 1)
      .then((data) => {
        if (seq !== requestSeq.current) return;
        setItems(data.items);
        setPage(data.page);
        setTotalPages(data.totalPages);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        setError(messageFor(err));
        setLoading(false);
      });
  }, [kind, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const loadMore = useCallback(async () => {
    if (!kind || loading || loadingMore || page >= totalPages) return;
    const seq = requestSeq.current;
    const next = Math.min(page + 1, totalPages);

    setLoadingMore(true);
    setMoreError(null);
    try {
      const data = await getCatalogPage(kind, next);
      if (seq !== requestSeq.current) return; // kind changed mid-flight
      // Popular lists shift between requests; drop any duplicate the new
      // page overlaps with.
      setItems((prev) => {
        const seen = new Set(prev.map(mediaKeyOf));
        return [...prev, ...data.items.filter((m) => !seen.has(mediaKeyOf(m)))];
      });
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      setMoreError(messageFor(err));
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
    }
  }, [kind, loading, loadingMore, page, totalPages]);

  const goBack = useCallback(() => {
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === "number" && state.idx > 0) navigate(-1);
    else navigate("/", { replace: true });
  }, [navigate]);

  if (!kind) return <Navigate to="/" replace />;

  const header = (
    <header className="browse-head">
      <button type="button" className="icon-btn browse-back" onClick={goBack} aria-label="Back">
        {BackIcon}
      </button>
      <div className="browse-head-text">
        <p className="eyebrow browse-eyebrow">
          <span className="browse-eyebrow-dot" aria-hidden="true" />
          Browse
        </p>
        <h1 className="browse-title">{KIND_TITLES[kind]}</h1>
        <p className="browse-lede">{KIND_BLURBS[kind]}</p>
      </div>
    </header>
  );

  if (loading) {
    return (
      <div className="page browse-page">
        {header}
        <div
          className="browse-grid"
          role="status"
          aria-busy="true"
          aria-label="Loading the catalogue"
        >
          {Array.from({ length: 12 }, (_, index) => (
            <div className="browse-skeleton" key={index} aria-hidden="true">
              <div className="skeleton skeleton--poster" />
              <div className="skeleton skeleton--text browse-skeleton-line" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="page browse-page">
        {header}
        <div className="empty-state browse-empty">
          <span className="browse-empty__icon" aria-hidden="true">
            {error ? FaultIcon : ShelfIcon}
          </span>
          <h3>{error ? "Couldn't load this catalogue" : "Nothing came back"}</h3>
          <p>{error ?? "The shelf is bare for a moment. Give it another go."}</p>
          <button type="button" className="btn btn-primary" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const atEnd = page >= totalPages;

  return (
    <div className="page browse-page">
      {header}

      <p className="browse-status">
        <span className="browse-status__pip" aria-hidden="true" />
        {items.length} {items.length === 1 ? "title" : "titles"}
        {page > 1 ? ` · page ${page}` : ""}
      </p>

      <div className="browse-grid">
        {items.map((media) => (
          <PosterCard
            key={mediaKeyOf(media)}
            type={media.type}
            tmdbId={media.tmdbId}
            title={media.title}
            posterPath={media.posterPath}
            // The trending shelf mixes films and series, so the kind is
            // spelled out under the title instead of stamped on every poster.
            subtitle={
              kind === "trending"
                ? media.year
                  ? `${media.type === "tv" ? "TV" : "Film"} · ${media.year}`
                  : media.type === "tv"
                    ? "TV"
                    : "Film"
                : undefined
            }
            year={media.year}
          />
        ))}
      </div>

      <footer className="browse-foot">
        {moreError && (
          <div className="browse-more-error" role="status">
            <span className="browse-more-error__icon" aria-hidden="true">
              {FaultIcon}
            </span>
            <p className="browse-more-error__text">{moreError}</p>
          </div>
        )}

        {atEnd ? (
          <div className="browse-end">
            <p className="browse-end-label">
              <span className="browse-end-beam" aria-hidden="true" />
              <span>That&rsquo;s the whole catalogue</span>
              <span className="browse-end-beam" aria-hidden="true" />
            </p>
            <Link className="browse-end-link" to="/">
              Back to the front page
            </Link>
          </div>
        ) : (
          <button
            type="button"
            className="btn browse-load"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            aria-busy={loadingMore}
          >
            {loadingMore ? <span className="browse-spinner" aria-hidden="true" /> : null}
            <span>{loadingMore ? "Loading…" : moreError ? "Try again" : "Load more"}</span>
            {!loadingMore && !moreError ? ChevronDown : null}
          </button>
        )}
      </footer>
    </div>
  );
}
