import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import PosterCard from "../components/PosterCard";
import { useSession } from "../lib/session";
import { liveHistory, liveWatchlist } from "../lib/store";
import type { HistoryItem } from "../types";
import "../styles/library.css";

const TAB_KEY = "lighthook.libraryTab";

type LibraryTab = "watchlist" | "history";

function readTab(): LibraryTab {
  try {
    return localStorage.getItem(TAB_KEY) === "history" ? "history" : "watchlist";
  } catch {
    return "watchlist"; // private mode / storage disabled
  }
}

function writeTab(tab: LibraryTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* private mode — the in-memory tab state still works */
  }
}

/** "just now", "12m ago", "3h ago", "yesterday", "5d ago". */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 60_000) return "just now";

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days <= 1) return "yesterday";
  return `${days}d ago`;
}

function historyHref(item: HistoryItem): string {
  if (item.mediaType === "tv") {
    const season = typeof item.season === "number" ? item.season : 1;
    const episode = typeof item.episode === "number" ? item.episode : 1;
    return `/watch/tv/${item.tmdbId}?s=${season}&e=${episode}`;
  }
  return `/watch/movie/${item.tmdbId}`;
}

function historySubtitle(item: HistoryItem): string {
  const when = relativeTime(item.watchedAt);
  if (item.mediaType === "tv") {
    if (typeof item.season === "number" && typeof item.episode === "number") {
      return `S${item.season} · E${item.episode} · ${when}`;
    }
    return `Episode · ${when}`;
  }
  return `Movie · ${when}`;
}

export default function Library() {
  const { activeProfile, state } = useSession();
  const [tab, setTab] = useState<LibraryTab>(readTab);

  if (!activeProfile) return null; // App's <Guard> redirects before this renders

  const watchlist = liveWatchlist(state);
  const history = liveHistory(state);

  const select = (next: LibraryTab) => {
    setTab(next);
    writeTab(next);
  };

  return (
    <div className="page library-page">
      <p className="eyebrow library-eyebrow">
        <span className="library-eyebrow-dot" aria-hidden="true" />
        Library
      </p>
      <h1
        className="display library-title"
        style={{ "--library-color": activeProfile.color } as CSSProperties}
      >
        {activeProfile.name}
      </h1>
      <p className="tiny muted library-count">
        {tab === "watchlist"
          ? `${watchlist.length} saved ${watchlist.length === 1 ? "title" : "titles"}`
          : `${history.length} ${history.length === 1 ? "entry" : "entries"}`}
      </p>

      <div className="segmented library-tabs">
        <button
          type="button"
          aria-pressed={tab === "watchlist"}
          onClick={() => select("watchlist")}
        >
          Watchlist
        </button>
        <button type="button" aria-pressed={tab === "history"} onClick={() => select("history")}>
          History
        </button>
      </div>

      {tab === "watchlist" ? (
        watchlist.length === 0 ? (
          <div className="empty-state library-empty">
            <span className="library-empty__icon" aria-hidden="true">
              <svg
                width="30"
                height="30"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z" />
              </svg>
            </span>
            <h3>Nothing saved yet</h3>
            <p>Titles you save from a title page land here, on this profile only.</p>
            <Link className="btn btn-primary" to="/search">
              Find something
            </Link>
          </div>
        ) : (
          <div className="poster-grid library-grid">
            {watchlist.map((item) => (
              <PosterCard
                key={item.id}
                type={item.mediaType}
                tmdbId={item.tmdbId}
                title={item.title}
                posterPath={item.posterPath}
                subtitle={relativeTime(item.addedAt)}
                to={`/title/${item.mediaType}/${item.tmdbId}`}
              />
            ))}
          </div>
        )
      ) : (
        <>
          {history.length === 0 ? (
            <div className="empty-state library-empty">
              <span className="library-empty__icon" aria-hidden="true">
                <svg
                  width="30"
                  height="30"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="8.5" />
                  <path d="M12 7.5V12l3 2" />
                </svg>
              </span>
              <h3>No history yet</h3>
              <p>
                Open an episode or a movie and it is saved here automatically — this is where
                you pick it back up.
              </p>
              <Link className="btn btn-primary" to="/search">
                Find something
              </Link>
            </div>
          ) : (
            <div className="poster-grid library-grid">
              {history.map((item) => (
                <PosterCard
                  key={item.id}
                  type={item.mediaType}
                  tmdbId={item.tmdbId}
                  title={item.title}
                  posterPath={item.posterPath}
                  subtitle={historySubtitle(item)}
                  to={historyHref(item)}
                />
              ))}
            </div>
          )}
          <p className="tiny muted library-note">
            Picks up at the episode you opened, not at a timestamp.
          </p>
        </>
      )}
    </div>
  );
}
