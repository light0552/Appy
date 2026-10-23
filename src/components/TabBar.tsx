import { NavLink } from "react-router-dom";

const tabs = [
  {
    to: "/",
    label: "Home",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path
          d="M3.5 10.5 12 3.8l8.5 6.7V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1v-9.5Z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    to: "/search",
    label: "Search",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: "/library",
    label: "Library",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M5 4.5v15M9.5 4.5v15" strokeLinecap="round" />
        <path d="m13.5 5.6 5 1.4-3.4 12.2-5-1.4 3.4-12.2Z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: "/profiles",
    label: "Profiles",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M4.8 20c.6-3.6 3.5-5.8 7.2-5.8s6.6 2.2 7.2 5.8" strokeLinecap="round" />
      </svg>
    ),
  },
];

export default function TabBar() {
  return (
    <nav className="tab-bar" aria-label="Primary">
      {/* Decorative on mobile (hidden by CSS); the wordmark for the
          desktop top nav at >= 1024px. */}
      <span className="tab-brand">
        <span className="tab-brand-mark" aria-hidden="true">
          L
        </span>
        <span className="tab-brand-name">Lighthook</span>
      </span>
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === "/"}
          className="tab-item"
        >
          {tab.icon}
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
