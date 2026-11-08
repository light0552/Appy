import { useEffect } from "react";
import { clearLocalSession, probeSession } from "../lib/auth";
import { useSession } from "../lib/session";

/** Set before the hard bounce to /profiles so the picker can explain why. */
export const KICKED_NOTICE_KEY = "lighthook:kicked";

/** ~15s: fast enough to stop a movie, quiet enough to stay out of the way. */
const POLL_MS = 15_000;

/**
 * Server-enforced kicks. An admin kick rotates the screen's session epoch, so
 * the next `resume` answers 401/403 even while a movie is playing. Network
 * failures are ignored: only an explicit rejection signs the screen out.
 */
export default function SessionGuard() {
  const { activeProfile } = useSession();
  const profileId = activeProfile?.id ?? null;

  useEffect(() => {
    if (!profileId) return;

    let disposed = false;
    let checking = false;

    const check = async () => {
      if (disposed || checking) return;
      if (document.visibilityState !== "visible") return;
      // The picker and the admin console are not screen playback; never yank
      // them. A dead screen session still blocks the guarded app routes.
      const path = window.location.pathname;
      if (path === "/profiles" || path === "/admin" || path.startsWith("/admin/")) return;
      checking = true;
      try {
        const state = await probeSession(profileId);
        if (disposed || state !== "rejected") return;

        clearLocalSession(profileId);
        try {
          sessionStorage.setItem(KICKED_NOTICE_KEY, "1");
        } catch {
          /* storage disabled — the bounce still happens */
        }
        // Hard navigation: unmounts /watch and its iframe immediately, and
        // rebuilds the session state from the server on the picker.
        window.location.replace("/profiles");
      } finally {
        checking = false;
      }
    };

    const timer = window.setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    void check();

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [profileId]);

  return null;
}
