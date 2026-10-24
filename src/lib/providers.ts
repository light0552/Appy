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
 */
export interface ProviderDefinition {
  id: string;
  name: string;
  hint: string;
  /**
   * Excluded from all CLIENT-side lists (chips, manual fallbacks, advance
   * order) per user mandate 2026-10-24 ("remove Vidsrc"). The sidecar's
   * extractor still races it server-side — there its ad infra is irrelevant:
   * the phone never loads the provider page, only the ripped stream passes
   * through the home box. Removing it from the race entirely would strand
   * most titles (measured: Vidsrc won the strongest catalogue share).
   */
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
    id: "vidlink",
    name: "VidLink",
    hint: "Plays most reliably",
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
  if (!provider) return null;
  return buildUrl(provider, ref);
}
