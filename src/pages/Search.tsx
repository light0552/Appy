import { useCallback, useEffect, useState } from "react";
import PosterCard from "../components/PosterCard";
import SearchBar from "../components/SearchBar";
import { getTrending, searchMulti } from "../lib/tmdb";
import type { Media } from "../types";
import "../styles/search.css";

export default function Search() {
  // `input` mirrors the field; `query` is what actually runs the search.
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Bumped only when a suggestion chip commits, so the uncontrolled
  // SearchBar input remounts with the chip's text.
  const [barKey, setBarKey] = useState(0);

  const [results, setResults] = useState<Media[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ideas, setIdeas] = useState<Media[] | null>(null);

  // Chip cloud for the empty-query state.
  useEffect(() => {
    let alive = true;
    getTrending()
      .then((items) => {
        if (alive) setIdeas(items);
      })
      .catch(() => {
        if (alive) setIdeas([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Search effect: aborts the previous request on every query change, so
  // stale responses can never overwrite fresher ones.
  useEffect(() => {
    const trimmed = query.trim();
    const controller = new AbortController();

    if (!trimmed) {
      setResults(null);
      setLoading(false);
      setError(null);
      return () => controller.abort();
    }

    setLoading(true);
    setError(null);

    searchMulti(trimmed, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setResults(items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Search failed. Try again.");
        setLoading(false);
      });

    return () => controller.abort();
  }, [query, attempt]);

  const commit = useCallback((value: string) => {
    setInput(value);
    setQuery(value);
  }, []);

  const pickIdea = (item: Media) => {
    setBarKey((key) => key + 1);
    commit(item.title);
  };

  const trimmed = query.trim();
  const count = results ? results.length : 0;

  return (
    <div className="search-page">
      <div className="search-sticky">
        <SearchBar key={barKey} value={input} onChange={commit} />
      </div>

      {trimmed ? (
        <>
          <p className="search-meta tiny muted" role="status">
            {loading
              ? `Searching “${trimmed}”…`
              : error
                ? "Something went wrong while searching."
                : results
                  ? `${count} ${count === 1 ? "result" : "results"} for “${trimmed}”.`
                  : ""}
          </p>

          {error && (
            <div className="empty-state">
              <h3>Search hit a snag.</h3>
              <p>{error}</p>
              <button type="button" className="btn btn-sm" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </button>
            </div>
          )}

          {!error && loading && results === null && (
            <div className="poster-grid" aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => (
                <div className="skeleton skeleton--poster" key={index} />
              ))}
            </div>
          )}

          {!error && !loading && results && results.length === 0 && (
            <div className="empty-state">
              <h3>No matches for “{trimmed}”.</h3>
              <p>Check the spelling, or try the title&rsquo;s original name.</p>
            </div>
          )}

          {!error && results && results.length > 0 && (
            <div className="poster-grid search-results">
              {results.map((media) => (
                <PosterCard
                  key={`${media.type}-${media.tmdbId}`}
                  type={media.type}
                  tmdbId={media.tmdbId}
                  title={media.title}
                  posterPath={media.posterPath}
                  year={media.year}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="search-idle">
            <span className="search-idle__icon" aria-hidden="true">
              <svg
                width="30"
                height="30"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4.5 4.5" strokeLinecap="round" />
              </svg>
            </span>
            <h1 className="search-idle__title">Start typing to find something fun&hellip;</h1>
            <p className="search-idle__sub muted">
              Movies, TV, hidden gems — the search runs as you type.
            </p>
          </div>

          <section className="section">
            <div className="section-head">
              <h2>Popular right now</h2>
            </div>

            {ideas === null ? (
              <div className="cluster search-chips" aria-hidden="true">
                {Array.from({ length: 6 }, (_, index) => (
                  <span className="skeleton search-chip-skeleton" key={index} />
                ))}
              </div>
            ) : ideas.length === 0 ? (
              <div className="empty-state">
                <h3>Nothing came back from the catalogue.</h3>
                <p>Suggestions are unavailable right now — try searching directly.</p>
              </div>
            ) : (
              <div className="cluster search-chips">
                {ideas.map((item) => (
                  <button
                    key={`${item.type}-${item.tmdbId}`}
                    type="button"
                    className="chip"
                    onClick={() => pickIdea(item)}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
