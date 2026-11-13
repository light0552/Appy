import { useEffect, useRef, useState } from "react";
import { IFRAME_ALLOW } from "../lib/providers";
import "../styles/player.css";

export interface PlayerProps {
  url: string;
  title: string;
  /**
   * Bumped by the caller for every deliberate fresh request (server switch,
   * "try another server", Reload). It keys the iframe and stamps the URL, so
   * React tears the frame down instead of re-pointing it — no stale document,
   * no reused provider state.
   */
  nonce?: number | string;
  onTimeout?: () => void;
  timeoutMs?: number;
}

/**
 * Providers that answer an unknown query parameter with the same player page.
 * Verified 2026-11-13 with curl against both routes: VidSpark
 * (`/movie/550`, `/tv/1399/1/1`) and VidLink answer 200 `text/html` with and
 * without `?cb=…`, identical body. VidFast answers 403 and Videasy fails TLS on
 * every request, so nothing can be verified there — those two get the remount
 * without a parameter (BUILD.md §3.2: do not add unverified query strings).
 */
const CACHE_BUST_HOSTS = new Set(["vidspark.to", "vidlink.pro"]);

/** Appends `cb=<tag>` for a URL whose host tolerates it; otherwise untouched. */
function freshRequestUrl(url: string, tag: string): string {
  try {
    const parsed = new URL(url);
    if (!CACHE_BUST_HOSTS.has(parsed.hostname)) return url;
    parsed.searchParams.set("cb", tag);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * A single cross-origin iframe. No `sandbox` attribute: every provider detects
 * it and refuses to play (harness-verified 2026-10-22 — see lib/providers),
 * so sandboxing and playback are mutually exclusive. A cross-origin failure is
 * indistinguishable from success, so a watchdog timer calls `onTimeout` once
 * per URL instead of spinning forever.
 *
 * Every mount is a fresh document: the frame is keyed on the URL + nonce and
 * the request carries a per-mount tag, so returning to a title or re-picking a
 * server can never resume the previous provider's session.
 */
export default function Player({
  url,
  title,
  nonce = 0,
  onTimeout,
  timeoutMs = 6000,
}: PlayerProps) {
  const onTimeoutRef = useRef(onTimeout);
  /** Unique per mount: remounting is exactly what a fresh request means. */
  const [requestTag] = useState(() =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  );

  const src = freshRequestUrl(url, `${requestTag}${nonce ? `-${nonce}` : ""}`);

  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  // Restart whenever the URL changes so switching servers gets a fresh grace period.
  // Returning to the foreground restarts the SAME single timer: providers fire
  // popunders ~1s after the tap (cross-origin — unwedgeable from here), so the
  // 6s grace period must not keep counting while the user is in the ad tab.
  // The frame is cross-origin and its <video> is unreadable, so the only honest
  // recovery signal is a fresh grace window, not an inspection of playback.
  useEffect(() => {
    if (!onTimeoutRef.current) return;

    // Exactly one timer: every restart clears the previous id first.
    let timer = window.setTimeout(() => {
      onTimeoutRef.current?.();
    }, timeoutMs);

    const startGracePeriod = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        onTimeoutRef.current?.();
      }, timeoutMs);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") startGracePeriod();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", startGracePeriod);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", startGracePeriod);
    };
  }, [src, timeoutMs]);

  return (
    <div className="player-frame">
      <iframe
        key={src}
        src={src}
        title={title}
        allow={IFRAME_ALLOW}
        allowFullScreen
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
