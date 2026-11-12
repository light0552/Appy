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
 * House rules — the small ticket pinned above the shelf on app open.
 * It names the three ways into the cinema: Brave on phones, uBlock Origin
 * Lite on desktop Chrome, and the private LIGHTH00K Android app. "Got it"
 * is a permanent, one-time acknowledgement per device: the card never
 * returns on this device, and only a new device / fresh storage sees it
 * again. Dismissal plays a short exit animation first, then unmounts.
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

        <div className="notice-seal" aria-hidden="true">
          <img src="/brand/lighthook-cat.jpg" alt="" />
        </div>

        <div className="notice-copy">
          <p className="notice-eyebrow">
            <span className="notice-pip" aria-hidden="true" />
            <span className="notice-eyebrow-text">House rules</span>
          </p>
          <h2 className="notice-title">
            Best watched with an{" "}
            <span className="notice-title-accent">ad blocker.</span>
          </h2>
          <p className="notice-lede">
            Two browsers, or the house app — one minute, then the shelf runs
            clean.
          </p>
        </div>

        <ul className="notice-chips" aria-label="Recommended setups">
          <li className="notice-chip">
            <span className="notice-chip-icon" aria-hidden="true">
              {PhoneIcon}
            </span>
            <span className="notice-chip-body">
              <span className="notice-chip-name">Brave Browser</span>
              <span className="notice-chip-detail">
                iPhone &amp; Android · built in
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

          <li className="notice-chip notice-chip--app">
            <span
              className="notice-chip-icon notice-chip-icon--app"
              aria-hidden="true"
            >
              <img
                src="/brand/avatar-ginger.webp"
                alt=""
                width={22}
                height={22}
                decoding="async"
              />
            </span>
            <span className="notice-chip-body">
              <span className="notice-chip-name">LIGHTH00K app</span>
              <span className="notice-chip-detail">
                Android only · request access from admin
              </span>
            </span>
          </li>
        </ul>

        <div className="notice-actions">
          <button type="button" className="notice-got" onClick={dismiss}>
            <span className="notice-got-label">Got it</span>
            <svg
              width="14"
              height="14"
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
