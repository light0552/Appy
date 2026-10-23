import type { ReactNode } from "react";
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
      <div className="row-scroller scroll-x">{children}</div>
    </section>
  );
}
