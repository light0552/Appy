import { useEffect, useRef } from "react";
import { IFRAME_ALLOW } from "../lib/providers";
import "../styles/player.css";

export interface PlayerProps {
  url: string;
  title: string;
  onTimeout?: () => void;
  timeoutMs?: number;
}

/**
 * A single cross-origin iframe. No `sandbox` attribute: every provider detects
 * it and refuses to play (harness-verified 2026-10-22 — see lib/providers),
 * so sandboxing and playback are mutually exclusive. A cross-origin failure is
 * indistinguishable from success, so a watchdog timer calls `onTimeout` once
 * per URL instead of spinning forever.
 */
export default function Player({ url, title, onTimeout, timeoutMs = 6000 }: PlayerProps) {
  const onTimeoutRef = useRef(onTimeout);

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
  }, [url, timeoutMs]);

  return (
    <div className="player-frame">
      <iframe
        src={url}
        title={title}
        allow={IFRAME_ALLOW}
        allowFullScreen
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
