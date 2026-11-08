import type { MediaRef } from "../types";

/**
 * The only place provider domains live. A domain rotation is a one-line edit here.
 * Verified 2026-10-22: all four answer 200 with no X-Frame-Options and no
 * frame-ancestors CSP, so they are frameable. Do not re-research — see BUILD.md §3.2.
 *
 * Also verified 2026-10-22 (real-browser harness, iPhone UA, iframe with and
 * without the `sandbox` attribute): all four probe for `sandbox` and refuse to
 * play when it is present — "Iframe Sandbox Detected" / "Please Disable Sandbox".
 * With `sandbox` absent, VidLink plays for real (video element + timeline);
 * VidFast, Videasy and Vidsrc frame but fail at their own stream layer.
 * Sandbox and playback are mutually exclusive: never add a `sandbox` attribute
 * back to the player iframe.
 *
 * Re-measured 2026-10-23 (fallback viability, no-tap headless + a tapped run):
 * VidLink plays movie AND tv (`/tv/{tmdbId}/{season}/{episode}` resolves, ~47min
 * for Breaking Bad S2E3). VidFast returns HTTP 500 and Videasy returns an
 * access-denied page on every title — both currently DEAD. Vidsrc plays but
 * needs a tap/slower load (its real player host drifts to an obfuscated domain).
 * So the ONLY working fallback when VidLink lacks a title is Vidsrc — hence
 * Vidsrc is ordered SECOND and the two dead servers are demoted to the bottom,
 * so "next server" reaches a working one in a single tap. VidLink's own gaps
 * surface as "content or episode is not available" rendered inside the frame
 * (a catalogue gap on their side, not an id/format bug on ours).
 *
 * 2026-11-08: the ripstream sidecar (and the whole ad-free "own player"
 * path) is deleted, so Vidsrc is no longer raced anywhere. It stays hidden
 * from the client chips — the household watches the provider frames.
 *
 * 2026-11-08 (playback outage): VidLink renders a 0:00 player for newer
 * titles (confirmed on The Odyssey, TMDB 1368337), VidFast answers 403 and
 * Videasy's TLS is broken. VidSpark (the source ssflix.pro serves in its
 * primary frame) plays that title, Fight Club and Game of Thrones S1E1 with
 * real durations, answers 200 with no X-Frame-Options/CSP, and works with no
 * sandbox. It is now the first client provider; VidLink stays as the backup
 * catalogue.
 */
export interface ProviderDefinition {
  id: string;
  name: string;
  hint: string;
  /** Excluded from all CLIENT-side lists (chips, manual fallbacks, advance order). */
  hidden?: boolean;
  /** Returns null when the provider cannot address this title. */
  movie: (ref: MediaRef) => string | null;
  tv: (ref: MediaRef) => string | null;
}

function seasonEpisode(ref: MediaRef): string {
  return `${ref.season ?? 1}/${ref.episode ?? 1}`;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "vidspark",
    name: "VidSpark",
    hint: "Plays newest titles",
    movie: (ref) => `https://vidspark.to/movie/${ref.tmdbId}`,
    tv: (ref) => `https://vidspark.to/tv/${ref.tmdbId}/${seasonEpisode(ref)}`,
  },  {
    id: "vidlink",
    name: "VidLink",
    hint: "Backup catalogue",
    movie: (ref) => `https://vidlink.pro/movie/${ref.tmdbId}`,
    tv: (ref) => `https://vidlink.pro/tv/${ref.tmdbId}/${seasonEpisode(ref)}`,
  },
  {
    id: "vidsrc",
    name: "Vidsrc",
    hint: "Hidden from clients — raced server-side only",
    hidden: true,
    movie: (ref) => (ref.imdbId ? `https://vidsrc.to/embed/movie/${ref.imdbId}` : null),
    tv: (ref) =>
      ref.imdbId
        ? `https://vidsrc.to/embed/tv/${ref.imdbId}/${seasonEpisode(ref)}`
        : null,
  },
  {
    id: "vidfast",
    name: "VidFast",
    hint: "Can hit server errors",
    movie: (ref) => (ref.imdbId ? `https://vidfast.vc/movie/${ref.imdbId}` : null),
    tv: (ref) =>
      ref.imdbId ? `https://vidfast.vc/tv/${ref.imdbId}/${seasonEpisode(ref)}` : null,
  },
  {
    id: "videasy",
    name: "Videasy",
    hint: "Can fail to start",
    movie: (ref) => `https://player.videasy.to/movie/${ref.tmdbId}`,
    tv: (ref) => `https://player.videasy.to/tv/${ref.tmdbId}/${seasonEpisode(ref)}`,
  },
];

/**
 * Bumped when the client provider list changes materially. Watch uses this to
 * ignore a saved preferred server from before the change and reset it to
 * `DEFAULT_PROVIDER_ID` once. Version 2 accompanies the VidSpark switch
 * (2026-11-08) so stale `vidfast`/`vidlink` preferences cannot keep a broken
 * player first.
 */
export const PROVIDER_PREFS_VERSION = 2;
export const DEFAULT_PROVIDER_ID = "vidspark";

/**
 * Feature policy for the player frame: playback permissions only. With no
 * `sandbox` attribute (required for playback — see the note at the top of this
 * file), `referrerPolicy="no-referrer"` on the iframe stays the referrer guard.
 */
export const IFRAME_ALLOW =
  "autoplay; fullscreen; encrypted-media; picture-in-picture";

export interface ProviderOption {
  provider: ProviderDefinition;
  url: string;
}

export function buildUrl(provider: ProviderDefinition, ref: MediaRef): string | null {
  return ref.type === "movie" ? provider.movie(ref) : provider.tv(ref);
}

export function availableProviders(ref: MediaRef): ProviderOption[] {
  const out: ProviderOption[] = [];
  for (const provider of PROVIDERS) {
    if (provider.hidden) continue; // user mandate 2026-10-24: client never sees Vidsrc
    const url = buildUrl(provider, ref);
    if (url) out.push({ provider, url });
  }
  return out;
}

export function providerById(id: string | undefined): ProviderDefinition | undefined {
  if (!id) return undefined;
  return PROVIDERS.find((provider) => provider.id === id);
}

export function preferredUrl(ref: MediaRef, preferredProvider?: string): string | null {
  const provider = providerById(preferredProvider);
  // A saved preference for a hidden/retired provider must not resurrect it.
  if (!provider || provider.hidden) return null;
  return buildUrl(provider, ref);
}
