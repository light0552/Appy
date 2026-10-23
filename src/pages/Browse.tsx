import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import PosterCard from "../components/PosterCard";
import { getCatalogPage, type CatalogKind } from "../lib/tmdb";
import type { Media } from "../types";
import "../styles/browse.css";

const KIND_TITLES: Record<CatalogKind, string> = {
  trending: "Trending",
  movies: "Popular movies",
  tv: "Popular TV",
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
      <button type="button" className="icon-btn" onClick={goBack} aria-label="Back">
        {BackIcon}
      </button>
      <div className="browse-head-text">
        <p className="eyebrow browse-eyebrow">
          <span className="browse-eyebrow-dot" aria-hidden="true" />
          Browse
        </p>
        <h1 className="browse-title">{KIND_TITLES[kind]}</h1>
      </div>
    </header>
  );

  if (loading) {
    return (
      <div className="page browse-page">
        {header}
        <div className="browse-grid" aria-busy="true" aria-label="Loading catalogue">
          {Array.from({ length: 12 }, (_, index) => (
            <div className="skeleton skeleton--poster" key={index} aria-hidden="true" />
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="page browse-page">
        {header}
        <div className="empty-state">
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

      <div className="browse-grid">
        {items.map((media) => (
          <PosterCard
            key={mediaKeyOf(media)}
            type={media.type}
            tmdbId={media.tmdbId}
            title={media.title}
            posterPath={media.posterPath}
            year={media.year}
          />
        ))}
      </div>

      <div className="browse-foot">
        {moreError && (
          <div className="browse-more-error" role="status">
            <p className="muted">{moreError}</p>
          </div>
        )}
        {atEnd ? (
          <p className="browse-end">
            <span className="browse-end-beam" aria-hidden="true" />
            That&rsquo;s everything.
            <span className="browse-end-beam" aria-hidden="true" />
          </p>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : moreError ? "Try again" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
