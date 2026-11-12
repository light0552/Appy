import { useCallback, useEffect, useState } from "react";
import PosterCard from "../components/PosterCard";
import SearchBar from "../components/SearchBar";
import { getTrending, searchMulti } from "../lib/tmdb";
import type { Media } from "../types";
import "../styles/search.css";

const SearchGlyph = (
  <svg
    width="30"
    height="30"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
);

const FaultIcon = (
  <svg
    width="24"
    height="24"
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
      <header className="search-head">
        <p className="eyebrow search-eyebrow">
          <span className="search-eyebrow-dot" aria-hidden="true" />
          Search
        </p>
        <h1 className="search-title">
          Search the whole <span className="search-title-accent">shelf</span>
        </h1>
        <p className="search-lede">
          Movies and series from the house catalogue — results arrive as you type.
        </p>
      </header>

      <div className="search-sticky">
        <SearchBar key={barKey} value={input} onChange={commit} />
      </div>

      <div className="search-body">
        {trimmed ? (
          <>
            <p className="search-meta" role="status">
              {loading ? (
                <>
                  <span className="search-meta__pulse" aria-hidden="true" />
                  Searching for “{trimmed}”…
                </>
              ) : error ? (
                "Search didn’t finish."
              ) : results ? (
                <>
                  <span className="search-meta__count">{count}</span>{" "}
                  <span className="search-meta__label">
                    {count === 1 ? "title" : "titles"} for “{trimmed}”.
                  </span>
                </>
              ) : null}
            </p>

            {error && (
              <div className="empty-state search-empty">
                <span className="search-empty__icon" aria-hidden="true">
                  {FaultIcon}
                </span>
                <div className="search-empty__copy">
                  <p className="eyebrow search-empty__eyebrow">The line went quiet</p>
                  <h3>Search hit a snag.</h3>
                  <p>{error}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm search-empty__cta"
                  onClick={() => setAttempt((a) => a + 1)}
                >
                  Try again
                </button>
              </div>
            )}

            {!error && loading && results === null && (
              <div className="poster-grid search-results" aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => (
                  <div className="skeleton skeleton--poster" key={index} />
                ))}
              </div>
            )}

            {!error && !loading && results && results.length === 0 && (
              <div className="empty-state search-empty">
                <span className="search-empty__icon" aria-hidden="true">
                  {SearchGlyph}
                </span>
                <div className="search-empty__copy">
                  <p className="eyebrow search-empty__eyebrow">Nothing in the stacks</p>
                  <h3>No matches for “{trimmed}”.</h3>
                  <p>Check the spelling, or try the title’s original name.</p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm search-empty__cta"
                  onClick={() => commit("")}
                >
                  Clear search
                </button>
              </div>
            )}

            {!error && results && results.length > 0 && (
              <div
                className={`poster-grid search-results${loading ? " search-results--busy" : ""}`}
              >
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
                {SearchGlyph}
              </span>
              <div className="search-idle__copy">
                <p className="eyebrow search-idle__eyebrow">The house shelf</p>
                <p className="search-idle__title">The whole shelf, one line away.</p>
                <p className="search-idle__sub muted">
                  Titles, series and the people in them — results arrive as you type.
                </p>
              </div>
            </div>

            <section className="section search-section">
              <div className="section-head search-section-head">
                <h2>Popular right now</h2>
                <p className="search-section-sub">Tap a title to search it</p>
              </div>

              {ideas === null ? (
                <div className="cluster search-chips" aria-hidden="true">
                  {Array.from({ length: 6 }, (_, index) => (
                    <span className="skeleton search-chip-skeleton" key={index} />
                  ))}
                </div>
              ) : ideas.length === 0 ? (
                <div className="empty-state search-empty">
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
    </div>
  );
}
