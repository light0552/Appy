import { useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";

export interface RowAction {
  label: string;
  /** Renders a react-router Link when set… */
  to?: string;
  /** …otherwise renders a button with this handler. */
  onClick?: () => void;
}

export interface RowProps {
  title: string;
  children: ReactNode;
  /** Optional action rendered on the right of the heading. */
  action?: RowAction;
}

/** Horizontally scrolling, snap-aligned shelf. The scroller gets `.row-scroller`. */
export default function Row({ title, children, action }: RowProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const nudge = (dir: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.8, 240), behavior: "smooth" });
  };

  return (
    <section className="row">
      <div className="section-head">
        <h2>{title}</h2>
        {action &&
          (action.to ? (
            <Link to={action.to}>{action.label}</Link>
          ) : (
            <button type="button" onClick={action.onClick}>
              {action.label}
            </button>
          ))}
      </div>
      <div className="row-shell">
        <div ref={scrollerRef} className="row-scroller scroll-x">
          {children}
        </div>
        {/* Desktop-only shelf chevrons (revealed by styles.css on hover);
            touch devices keep native swipe. */}
        <button
          type="button"
          className="row-nav row-nav--prev"
          aria-label={`Scroll ${title} back`}
          onClick={() => nudge(-1)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m14.5 5.5-6.5 6.5 6.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="row-nav row-nav--next"
          aria-label={`Scroll ${title} forward`}
          onClick={() => nudge(1)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m9.5 5.5 6.5 6.5-6.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </section>
  );
}
