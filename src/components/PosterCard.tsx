import { Link } from "react-router-dom";
import { posterUrl, type PosterSize } from "../lib/tmdb";
import type { MediaType } from "../types";

export interface PosterCardProps {
  type: MediaType;
  tmdbId: number;
  title: string;
  posterPath: string | null;
  year?: string | null;
  /** Secondary line under the title; falls back to the year. */
  subtitle?: string;
  /** Small pill over the art, e.g. "Trending" or an episode label. */
  badge?: string;
  size?: PosterSize;
  /** Overrides the default /title/:type/:id link. */
  to?: string;
  /** Renders as a plain button instead of a link (removal menus, pickers). */
  onClick?: () => void;
}

export default function PosterCard({
  type,
  tmdbId,
  title,
  posterPath,
  year,
  subtitle,
  badge,
  size = "w342",
  to,
  onClick,
}: PosterCardProps) {
  const src = posterUrl(posterPath, size);
  const href = to ?? `/title/${type}/${tmdbId}`;
  const line = subtitle ?? (year ?? "");
  const art = (
    <>
      <div className="poster-media">
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="poster-fallback">{title}</div>
        )}
        {badge && <span className="poster-badge">{badge}</span>}
      </div>
      <div className="poster-title clamp-2">{title}</div>
      {line && <div className="poster-sub">{line}</div>}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="poster-card" onClick={onClick} style={{ padding: 0 }}>
        {art}
      </button>
    );
  }

  return (
    <Link className="poster-card" to={href} aria-label={title}>
      {art}
    </Link>
  );
}
