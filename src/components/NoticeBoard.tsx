import { useCallback, useEffect, useRef, useState } from "react";
import "../styles/notice.css";

/** Permanent, one-time acknowledgement flag for this device. */
const STORAGE_KEY = "lighthook.notice.acknowledged";

/** Old per-calendar-day key from earlier builds — migrated to the flag above. */
const LEGACY_KEY = "lighthook.notice.dismissedOn";

/** Must match the card exit animation in notice.css. */
const EXIT_MS = 240;

/**
 * Reads the permanent acknowledgement flag. Returns true when this device has
 * already said "Got it" (or carries the legacy per-day stamp, which is treated
 * as acknowledged so existing users never see the notice again).
 */
function readAcknowledged(): boolean {
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === "1") return true;

    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy !== null) {
      // Migrate: one acknowledgement from now on, no date semantics.
      window.localStorage.setItem(STORAGE_KEY, "1");
      window.localStorage.removeItem(LEGACY_KEY);
      return true;
    }
    return false;
  } catch {
    // Private mode / storage disabled — show the notice, hide it for the session.
    return false;
  }
}

function persistAcknowledged(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Still hide for this session even if the write fails.
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const BeaconIcon = (
  <svg
    className="notice-mark"
    viewBox="0 0 32 32"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient
        id="notice-beam-left"
        x1="16"
        y1="9.6"
        x2="1.5"
        y2="4.2"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="currentColor" stopOpacity="0.62" />
        <stop offset="1" stopColor="currentColor" stopOpacity="0" />
      </linearGradient>
      <linearGradient
        id="notice-beam-right"
        x1="16"
        y1="9.6"
        x2="30.5"
        y2="4.2"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="currentColor" stopOpacity="0.62" />
        <stop offset="1" stopColor="currentColor" stopOpacity="0" />
      </linearGradient>
    </defs>

    <path
      className="notice-beam"
      d="M15.6 8.4 1.5 3.6v9.7l14.1-2.5Z"
      fill="url(#notice-beam-left)"
    />
    <path
      className="notice-beam notice-beam--b"
      d="M16.4 8.4 30.5 3.6v9.7l-14.1-2.5Z"
      fill="url(#notice-beam-right)"
    />

    <path
      d="M13 11.6h6l1.3 13.2H11.7L13 11.6Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path
      d="M12.7 24.8h6.6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path
      d="M13.5 14.5h5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      opacity="0.55"
    />
    <circle className="notice-lamp" cx="16" cy="9.5" r="2.4" />
  </svg>
);

const PhoneIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <rect x="7" y="2.5" width="10" height="19" rx="2.6" stroke="currentColor" strokeWidth="1.7" />
    <path d="M10.8 18.4h2.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const DesktopIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <rect x="2.5" y="4" width="19" height="13" rx="2" stroke="currentColor" strokeWidth="1.7" />
    <path d="M8.5 21h7M12 17.5V21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

/**
 * House notice — the signal card pinned above the main content on app open.
 * It names the two ad-blocker setups the shelf is tuned for (Brave on
 * phones, uBlock Origin Lite on desktop Chrome). "Got it" is a permanent,
 * one-time acknowledgement per device: the card never returns on this
 * device, and only a new device / fresh storage sees it again. Dismissal
 * plays a short exit animation first, then unmounts.
 */
export default function NoticeBoard() {
  const [acknowledged, setAcknowledged] = useState<boolean>(() => readAcknowledged());
  const [closing, setClosing] = useState(false);
  const exitTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    };
  }, []);

  const dismiss = useCallback(() => {
    if (closing) return;

    persistAcknowledged();

    if (prefersReducedMotion()) {
      setAcknowledged(true);
      return;
    }

    setClosing(true);
    exitTimer.current = window.setTimeout(() => setAcknowledged(true), EXIT_MS);
  }, [closing]);

  if (acknowledged) return null;

  return (
    <section className="notice" role="status" aria-label="House notice">
      <div className={`notice-card${closing ? " notice-card--closing" : ""}`}>
        <span className="notice-hairline" aria-hidden="true" />
        <span className="notice-sheen" aria-hidden="true" />

        <div className="notice-beacon" aria-hidden="true">
          <span className="notice-ring" />
          <span className="notice-ring notice-ring--b" />
          {BeaconIcon}
        </div>

        <div className="notice-copy">
          <p className="notice-eyebrow">
            <span className="notice-pip" aria-hidden="true" />
            <span className="notice-eyebrow-text">House notice</span>
          </p>
          <h2 className="notice-title">
            Best watched with an{" "}
            <span className="notice-title-accent">ad blocker.</span>
          </h2>
          <p className="notice-lede">
            Two setups, one minute — then the shelf runs clean.
          </p>
          {/* Short screens (360x640, landscape phones) get one compact line
              instead of the two chips, so the notice never eats the fold. */}
          <p className="notice-compact">
            <strong>Brave Browser</strong> on iPhone &amp; Android ·{" "}
            <strong>uBlock Origin Lite</strong> on Chrome
          </p>
        </div>

        <ul className="notice-chips">
          <li className="notice-chip">
            <span className="notice-chip-icon" aria-hidden="true">
              {PhoneIcon}
            </span>
            <span className="notice-chip-body">
              <span className="notice-chip-name">Brave Browser</span>
              <span className="notice-chip-detail">
                iPhone &amp; Android · blocker built in
              </span>
            </span>
          </li>

          <li className="notice-chip">
            <span className="notice-chip-icon" aria-hidden="true">
              {DesktopIcon}
            </span>
            <span className="notice-chip-body">
              <span className="notice-chip-name">uBlock Origin Lite</span>
              <span className="notice-chip-detail">
                PC / laptop Chrome · free extension
              </span>
            </span>
          </li>
        </ul>

        <div className="notice-actions">
          <button type="button" className="notice-got" onClick={dismiss}>
            <span className="notice-got-label">Got it</span>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="m5 12.5 4.3 4.3L19 7" />
            </svg>
          </button>
        </div>
      </div>
    </section>
  );
}
