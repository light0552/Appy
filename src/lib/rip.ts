import type { MediaRef } from "../types";

/**
 * Client for the Lighthook sidecar (`/rip/*`, proxied by the Vite dev server —
 * same origin over the LAN, 2026-10-24). The sidecar resolves a real stream
 * URL by driving a headless browser at home, and the bytes themselves ride
 * the same home server, so the phone never contacts an ad host: no provider
 * page ever loads in this mode. First resolve costs ~10–40s (headless browser
 * spin-up + provider handshake); the sidecar caches results for ~2h so
 * repeats resolve instantly. Everything is defensive: any fetch error, abort,
 * timeout or shape mismatch degrades to `{ ok: false }` and the caller falls
 * back to the iframe providers.
 */
/** One external WebVTT track snarfed from the provider player (2026-10-24). */
export interface RipSub {
  kind: "vtt";
  label: string;
  /** Root-relative proxy path, e.g. `/rip/hls/<enc>VTT`. */
  src: string;
}

export interface RipOk {
  ok: true;
  provider: string;
  providerName: string;
  kind: "hls" | "mp4";
  /** Root-relative proxy path, e.g. `/rip/hls/<enc>`. */
  playlistUrl: string;
  resolvedAt: number;
  /** External CC tracks for the player's subtitle sheet (may be empty). */
  subs: RipSub[];
}
export type RipResult = RipOk | { ok: false };

/**
 * Sidecar resolves are slow on a cold cache (headless browser at home). The
 * server's worst self-healing path is one 44s race + one fresh-Chrome retry;
 * 95s covers that so a transient browser death can never surface as a false
 * "No ad-free source" (2026-10-24 user report: S5E5 failed at 45s, then the
 * Lighthook chip played it from cache seconds later).
 */
const RESOLVE_TIMEOUT_MS = 95_000;

/** Query string for one resolve call — also exported for later pre-warm use. */
export function buildRipQuery(ref: MediaRef): string {
  const params = new URLSearchParams();
  params.set("type", ref.type);
  params.set("tmdbId", String(ref.tmdbId));
  if (ref.season !== undefined) params.set("s", String(ref.season));
  if (ref.episode !== undefined) params.set("e", String(ref.episode));
  if (ref.imdbId !== undefined) params.set("imdbId", ref.imdbId);
  return params.toString();
}

/**
 * Combines the resolve timeout with an optional caller abort (navigation /
 * manual "regular servers" switch). Uses `AbortSignal.any` when available;
 * the manual fallback covers Safari < 17.4 where it is missing.
 */
function linkSignals(timeout: AbortSignal, outer: AbortSignal | undefined): AbortSignal {
  if (!outer) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, outer]);
  const controller = new AbortController();
  if (timeout.aborted || outer.aborted) {
    controller.abort();
    return controller.signal;
  }
  const forward = () => controller.abort();
  timeout.addEventListener("abort", forward, { once: true });
  outer.addEventListener("abort", forward, { once: true });
  return controller.signal;
}

/** Shape guard — the sidecar is a separate process; never trust its JSON blindly. */
function isRipOk(value: unknown): value is RipOk {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.ok === true &&
    typeof v.provider === "string" &&
    typeof v.providerName === "string" &&
    (v.kind === "hls" || v.kind === "mp4") &&
    typeof v.playlistUrl === "string" &&
    v.playlistUrl.length > 0 &&
    typeof v.resolvedAt === "number"
  );
}

/**
 * Sidecar shape guard for the snarfed-WebVTT list: keep only well-formed
 * items, absolutize the leading slash, dedupe by src. Anything invalid
 * simply drops out of the CC list.
 */
function normalizeVttSubs(value: unknown): RipSub[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: RipSub[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.playlistUrl !== "string" || record.playlistUrl.length === 0) continue;
    const src = record.playlistUrl.startsWith("/") ? record.playlistUrl : `/${record.playlistUrl}`;
    if (seen.has(src)) continue;
    seen.add(src);
    const label =
      typeof record.label === "string" && record.label.trim() !== ""
        ? record.label.trim()
        : "Subtitles";
    out.push({ kind: "vtt", label, src });
  }
  return out;
}

/**
 * Resolves an ad-free stream for `ref` via the sidecar. Never throws: fetch
 * failures, a non-200, malformed JSON, shape mismatches and the 45s timeout
 * all resolve to `{ ok: false }` so the Watch page can fall back to iframe
 * providers without special-casing any error.
 */
export async function resolveRip(
  ref: MediaRef,
  opts?: { signal?: AbortSignal },
): Promise<RipResult> {
  const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  const signal = linkSignals(timeout, opts?.signal);
  try {
    const response = await fetch(`/rip/resolve?${buildRipQuery(ref)}`, {
      signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return { ok: false };
    const data: unknown = await response.json();
    if (!isRipOk(data)) return { ok: false };
    // Tolerate a sidecar that returns a bare path without the leading slash,
    // and normalize the snarfed-subtitle list defensively (separate process,
    // never trust its JSON blindly).
    const playlistUrl =
      data.playlistUrl.startsWith("/") || /^https?:\/\//.test(data.playlistUrl)
        ? data.playlistUrl
        : `/${data.playlistUrl}`;
    return { ...data, playlistUrl, subs: normalizeVttSubs(data.subs) };
  } catch {
    return { ok: false };
  }
}
