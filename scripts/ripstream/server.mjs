/**
 * Ripstream sidecar — the server leg.
 *
 * Two jobs, one process:
 *   1. Resolve: /rip/resolve?type=…&tmdbId=… runs the Puppeteer extractor
 *      (./extract.mjs) and returns the real HLS/MP4 URL for a title.
 *   2. Proxy:   /rip/hls/<encoded-upstream> byte-proxies that stream back
 *      through this server, replaying the request headers the provider's own
 *      player used, and rewriting playlists so every child URI comes back
 *      through here too. Segments stream straight through, unbuffered.
 *
 * Why a sidecar: the phone cannot set Referer/Origin/Cookie on a media fetch,
 * and provider manifests hide child URIs behind relative paths and ad hosts.
 * This process does both, so the LAN client just plays a plain URL.
 *
 * Binds loopback only (127.0.0.1:5174); the LAN reaches it through the Vite
 * dev-server proxy (/rip → 127.0.0.1:5174). Local-only tooling.
 *
 * Run: node scripts/ripstream/server.mjs
 */

import http from "node:http";
import { Readable } from "node:stream";
import { Extractor, AD_HOST } from "./extract.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.RIP_PORT ?? 5174);
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const CACHE_MAX = 200;
const STALL_MS = 30_000;

/**
 * External subtitle catalogue budget (2026-10-24). The provider players only
 * expose WebVTT for SOME titles; OpenSubtitles-v3 via Stremio carries the rest.
 * The lookup runs in parallel with the ripper race, so it normally costs zero
 * extra wall time. A slow catalogue never blocks a resolve for longer than this.
 */
const SUBS_FETCH_BUDGET_MS = Number(process.env.RIP_SUBS_FETCH_MS ?? 2500);
const SUBS_BODY_TTL_MS = 6 * 60 * 60 * 1000;
const SUBS_BODY_MAX = 80;

const extractor = new Extractor();

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendJson(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True when the hostname of `raw` (resolved against `base`) is an ad host. */
function isAdHost(raw, base) {
  try {
    return AD_HOST.test(new URL(raw, base).hostname);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Resolve cache + header registry                                     */
/* ------------------------------------------------------------------ */

/** Insertion-ordered resolve cache: key -> { entry, storedAt }. Oldest first for eviction. */
const cache = new Map();

/**
 * In-flight resolve promises by key (2026-10-24). Two pages asking for the
 * SAME title share ONE rip instead of stacking serial Chrome work.
 */
const inflight = new Map();

/** Short-lived negative cache (90s): a title that yielded nothing isn't re-raced on every manual chip tap. */
const negative = new Map();
const NEGATIVE_TTL_MS = 90_000;

/** Exact upstream URL -> captured request headers. */
const headersByUrl = new Map();
/** Upstream origin -> captured request headers. */
const headersByOrigin = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // A stored record without these is unusable — treat as a miss.
  if (!hit.entry?.kind || !hit.entry?.rawUrl) {
    cache.delete(key);
    return null;
  }
  return hit.entry;
}

function cacheSet(key, entry) {
  cache.delete(key);
  cache.set(key, { entry, storedAt: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function rememberHeaders(url, headers) {
  if (!headers || typeof headers !== "object") return;
  headersByUrl.set(url, headers);
  const origin = originOf(url);
  if (origin) headersByOrigin.set(origin, headers);
}

/**
 * Headers to replay for an upstream fetch.
 *
 * Lookup ladder: exact URL → exact origin → the registry origin whose host is
 * the LONGEST suffix of the upstream host (a CDN usually shares one auth set
 * across sub-domains: https://aws.foo-cdn.example covers
 * https://aws.foo-cdn.example/x/seg-1.ts and https://cdn.foo-cdn.example/y).
 * Nothing matched → no replay headers at all.
 */
function replayHeadersFor(url) {
  const exact = headersByUrl.get(url);
  if (exact) return exact;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }

  const direct = headersByOrigin.get(parsed.origin);
  if (direct) return direct;

  const upHost = parsed.hostname.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const [origin, headers] of headersByOrigin) {
    let reg;
    try {
      reg = new URL(origin);
    } catch {
      continue;
    }
    if (reg.protocol !== parsed.protocol) continue;
    const regHost = reg.hostname.toLowerCase();
    if (regHost === upHost || upHost.endsWith(`.${regHost}`)) {
      if (regHost.length > bestLen) {
        bestLen = regHost.length;
        best = headers;
      }
    }
  }
  return best ?? {};
}

/* ------------------------------------------------------------------ */
/* External subtitles (OpenSubtitles-v3 via Stremio catalogue)         */
/* ------------------------------------------------------------------ */

/** Human labels for the catalog's ISO-639 codes (subset that actually appears). */
const LANG_NAMES = {
  en: "English",
  eng: "English",
  es: "Spanish",
  spa: "Spanish",
  fr: "French",
  fre: "French",
  fra: "French",
  de: "German",
  ger: "German",
  deu: "German",
  it: "Italian",
  ita: "Italian",
  pt: "Portuguese",
  por: "Portuguese",
  ru: "Russian",
  rus: "Russian",
  ar: "Arabic",
  ara: "Arabic",
  hi: "Hindi",
  hin: "Hindi",
  ja: "Japanese",
  jpn: "Japanese",
  ko: "Korean",
  kor: "Korean",
  zh: "Chinese",
  chi: "Chinese",
  zho: "Chinese",
  tr: "Turkish",
  tur: "Turkish",
  pl: "Polish",
  pol: "Polish",
  nl: "Dutch",
  dut: "Dutch",
  nld: "Dutch",
  sv: "Swedish",
  swe: "Swedish",
  da: "Danish",
  dan: "Danish",
  no: "Norwegian",
  nor: "Norwegian",
  fi: "Finnish",
  fin: "Finnish",
  cs: "Czech",
  cze: "Czech",
  ces: "Czech",
  el: "Greek",
  gre: "Greek",
  ell: "Greek",
  he: "Hebrew",
  heb: "Hebrew",
  hu: "Hungarian",
  hun: "Hungarian",
  ro: "Romanian",
  rum: "Romanian",
  ron: "Romanian",
  uk: "Ukrainian",
  ukr: "Ukrainian",
  vi: "Vietnamese",
  vie: "Vietnamese",
  th: "Thai",
  tha: "Thai",
  id: "Indonesian",
  ind: "Indonesian",
  ms: "Malay",
  may: "Malay",
  msa: "Malay",
  fa: "Persian",
  per: "Persian",
  fas: "Persian",
  bg: "Bulgarian",
  bul: "Bulgarian",
  hr: "Croatian",
  hrv: "Croatian",
  sr: "Serbian",
  srp: "Serbian",
  sk: "Slovak",
  slo: "Slovak",
  slk: "Slovak",
  sl: "Slovenian",
  slv: "Slovenian",
  et: "Estonian",
  est: "Estonian",
  lv: "Latvian",
  lav: "Latvian",
  lt: "Lithuanian",
  lit: "Lithuanian",
  fil: "Filipino",
  tl: "Filipino",
};

function languageName(code) {
  const key = String(code ?? "").toLowerCase();
  return LANG_NAMES[key] ?? (key ? key.toUpperCase() : "Subtitles");
}

/** Catalog endpoint for a title, or null when the IMDb id is unusable. */
function subtitleCatalogUrl(ref) {
  const imdbId = typeof ref.imdbId === "string" ? ref.imdbId.trim() : "";
  if (!/^tt\d+$/i.test(imdbId)) return null;
  if (ref.type === "movie") {
    return `https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`;
  }
  if (ref.type === "tv") {
    if (!Number.isFinite(ref.season) || !Number.isFinite(ref.episode)) return null;
    return `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}:${ref.season}:${ref.episode}.json`;
  }
  return null;
}

/**
 * Rank catalogue entries English-first and cap at 3. Downloads happen lazily
 * through /rip/subs/ when a track is picked, so a title with many languages
 * costs nothing until the user asks for one.
 */
function pickExternalSubs(list) {
  const usable = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rawUrl = typeof item.url === "string" ? item.url : "";
    if (!rawUrl) continue;
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    usable.push({
      lang: typeof item.lang === "string" ? item.lang.toLowerCase() : "",
      url: rawUrl,
    });
  }

  const english = usable.filter((s) => s.lang === "en" || s.lang === "eng");
  const chosen = english.length > 0 ? english : usable;
  const seen = new Set();
  const counts = new Map();
  const out = [];
  for (const sub of chosen) {
    if (out.length >= 3) break;
    if (seen.has(sub.url)) continue;
    seen.add(sub.url);
    const base = languageName(sub.lang);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    out.push({ label: n === 1 ? base : `${base} ${n}`, url: sub.url });
  }
  return out;
}

/**
 * Fetch the external catalogue for `ref`. Never throws and never rejects:
 * a miss simply leaves the snarfed/provider tracks to stand alone.
 */
async function fetchExternalSubs(ref) {
  const catalog = subtitleCatalogUrl(ref);
  if (!catalog) return [];
  try {
    const response = await fetch(catalog, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Lighthook)" },
      redirect: "follow",
      signal: AbortSignal.timeout(Math.max(SUBS_FETCH_BUDGET_MS, 500)),
    });
    if (!response.ok) return [];
    const data = await response.json();
    const list = Array.isArray(data?.subtitles) ? data.subtitles : [];
    const picked = pickExternalSubs(list);
    if (picked.length > 0) log(`[subs] ${ref.type} ${ref.imdbId} catalogue → ${picked.length} track(s)`);
    return picked;
  } catch (err) {
    log(`[subs] catalogue miss ${ref.type}/${ref.imdbId}: ${err?.message ?? err}`);
    return [];
  }
}

/** Convert an SRT body to WebVTT (Chromium will not parse SRT in a <track>). */
function srtToVtt(text) {
  const clean = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  if (/^\s*WEBVTT\b/.test(clean)) return clean;

  const lines = clean.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // A bare cue number is SRT syntax only when the next line is a timestamp.
    if (/^\s*\d+\s*$/.test(line)) {
      const next = lines[i + 1] ?? "";
      if (next.includes("-->")) continue;
    }
    if (line.includes("-->")) {
      out.push(
        line
          // 0:00:06,000 → 00:00:06.000 (WebVTT uses a dot and 2+ hour digits).
          .replace(/(\d{1,3}):(\d{2}:\d{2}),(\d{3})/g, (_m, h, rest, ms) => `${String(h).padStart(2, "0")}:${rest}.${ms}`)
          // Some SRT files carry SubRip positioning tokens that WebVTT rejects.
          .replace(/\s+[XY][12]:\S+/g, ""),
      );
    } else {
      out.push(
        line
          // Strip ASS override blocks ({\an8} etc.) and SRT hard line breaks.
          .replace(/\{\\[^}]*\}/g, "")
          .replace(/\\N/gi, "\n"),
      );
    }
  }
  return `WEBVTT\n\n${out.join("\n").trim()}\n`;
}

const subsBodyCache = new Map(); // upstream url -> { body, storedAt }

function cachedSubsBody(url) {
  const hit = subsBodyCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.storedAt > SUBS_BODY_TTL_MS) {
    subsBodyCache.delete(url);
    return null;
  }
  return hit.body;
}

function cacheSubsBody(url, body) {
  subsBodyCache.delete(url);
  subsBodyCache.set(url, { body, storedAt: Date.now() });
  while (subsBodyCache.size > SUBS_BODY_MAX) {
    const oldest = subsBodyCache.keys().next().value;
    if (oldest === undefined) break;
    subsBodyCache.delete(oldest);
  }
}

function sendVtt(res, body) {
  if (res.headersSent || res.destroyed) return;
  const payload = Buffer.from(body, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/vtt; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

/** Fetch + convert + serve one external subtitle track. */
async function handleSubsProxy(req, res, encoded) {
  let upstream;
  try {
    upstream = decodeURIComponent(encoded);
  } catch {
    sendJson(res, 400, { ok: false, error: "bad-encode" });
    return;
  }

  let parsed;
  try {
    parsed = new URL(upstream);
  } catch {
    sendJson(res, 400, { ok: false, error: "bad-url" });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    sendJson(res, 400, { ok: false, error: "bad-scheme" });
    return;
  }

  const cached = cachedSubsBody(upstream);
  if (cached) {
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": "text/vtt; charset=utf-8",
        "Content-Length": Buffer.byteLength(cached),
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      });
      res.end();
      return;
    }
    sendVtt(res, cached);
    return;
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, {
      headers: { Accept: "*/*", "User-Agent": "Mozilla/5.0 (Lighthook)" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: "subs-fetch-failed", detail: String(err?.message ?? err) });
    return;
  }
  if (!upstreamRes.ok) {
    sendJson(res, 502, { ok: false, error: "subs-upstream", status: upstreamRes.status });
    return;
  }

  let raw;
  try {
    raw = await upstreamRes.text();
  } catch (err) {
    sendJson(res, 502, { ok: false, error: "subs-read-failed", detail: String(err?.message ?? err) });
    return;
  }
  if (!raw || /^\s*<(!doctype|html)/i.test(raw)) {
    sendJson(res, 502, { ok: false, error: "subs-not-srt" });
    return;
  }

  const vtt = srtToVtt(raw);
  if (!vtt.includes("-->")) {
    sendJson(res, 502, { ok: false, error: "subs-empty" });
    return;
  }
  cacheSubsBody(upstream, vtt);
  if (req.method === "HEAD") {
    res.writeHead(200, {
      "Content-Type": "text/vtt; charset=utf-8",
      "Content-Length": Buffer.byteLength(vtt),
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    });
    res.end();
    return;
  }
  sendVtt(res, vtt);
}

/* ------------------------------------------------------------------ */
/* Playlist rewriting                                                  */
/* ------------------------------------------------------------------ */

/**
 * Rewrite every child URI in a playlist through /rip/hls/…, dropping ad-host
 * children. Master playlists pair STREAM-INF (one line) with its URI line;
 * variants pair EXTINF with its segment line — both are dropped as a block so
 * we never leave an orphan tag. Everything else (markers, BYTERANGE, comments)
 * passes through verbatim.
 */
function rewritePlaylist(text, upstreamUrl) {
  const base = new URL(upstreamUrl);
  const isMaster =
    text.includes("#EXT-X-STREAM-INF") || text.includes("#EXT-X-I-FRAME-STREAM-INF");
  const proxify = (raw) => `/rip/hls/${encodeURIComponent(new URL(raw, base).href)}`;
  const out = [];
  let dropped = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#") || trimmed === "") {
      // Tags that carry a child URI in a quoted attribute.
      if (/^#EXT-X-(KEY|MAP|MEDIA):/i.test(trimmed)) {
        const attr = /URI="([^"]+)"/i.exec(trimmed);
        if (attr) {
          if (isAdHost(attr[1], base)) {
            dropped += 1;
            continue;
          }
          out.push(trimmed.replace(attr[0], `URI="${proxify(attr[1])}"`));
          continue;
        }
      }
      out.push(line);
      continue;
    }

    // Bare child URI line.
    if (isAdHost(trimmed, base)) {
      dropped += 1;
      const prev = out.length ? out[out.length - 1].trim().toUpperCase() : "";
      const partner = isMaster ? "#EXT-X-STREAM-INF" : "#EXTINF";
      if (prev.startsWith(partner)) {
        out.pop();
        dropped += 1;
      }
      continue;
    }

    out.push(proxify(trimmed));
  }

  return { body: out.join("\n"), dropped, isMaster };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handleResolve(res, query) {
  const type = query.get("type");
  const tmdbRaw = query.get("tmdbId");
  const tmdbId = Number.parseInt(tmdbRaw ?? "", 10);

  if (type !== "movie" && type !== "tv") {
    sendJson(res, 400, { ok: false, error: "bad-type" });
    return;
  }
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    sendJson(res, 400, { ok: false, error: "bad-tmdbId" });
    return;
  }

  const imdbId = query.get("imdbId") || "";
  const season = query.get("s") ? Number.parseInt(query.get("s"), 10) : undefined;
  const episode = query.get("e") ? Number.parseInt(query.get("e"), 10) : undefined;
  const key = `${type}|${tmdbId}|${imdbId}|${season ?? ""}|${episode ?? ""}`;

  const cached = cacheGet(key);
  if (cached) {
    log(`[resolve] cache hit ${key}`);
    sendJson(res, 200, {
      ok: true,
      provider: cached.provider,
      providerName: cached.providerName,
      kind: cached.kind,
      playlistUrl: cached.playlistUrl,
      resolvedAt: cached.resolvedAt,
      subs: cached.subs ?? [],
      cacheHit: true,
      tried: [],
    });
    return;
  }

  const neg = negative.get(key);
  if (neg && Date.now() - neg < NEGATIVE_TTL_MS) {
    log(`[resolve] negative hit ${key}`);
    sendJson(res, 200, { ok: false, tried: [] });
    return;
  }

  const ref = { type, tmdbId, imdbId: imdbId || undefined, season, episode };

  // Catalogue lookup runs alongside the browser race (2026-10-24): it only
  // affects the result if it finishes inside the race's own wall time, which
  // it almost always does. Never rejects.
  const externalPromise = fetchExternalSubs(ref);

  // Dedup: concurrent resolves of the same key share one race.
  let shared = inflight.get(key);
  if (!shared) {
    shared = extractor
      .race(ref, (msg) => log(`[resolve] ${msg}`))
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, shared);
  }

  let result;
  try {
    result = await shared;
  } catch (err) {
    log(`[resolve] extractor unavailable: ${err?.message ?? err}`);
    sendJson(res, 503, { ok: false, error: "extractor-unavailable" });
    return;
  }

  if (!result?.ok) {
    log(`[resolve] no stream for ${key}`);
    negative.set(key, Date.now());
    sendJson(res, 200, { ok: false, tried: result?.tried ?? [] });
    return;
  }

  const playlistUrl = `/rip/hls/${encodeURIComponent(result.url)}`;
  const resolvedAt = Date.now();

  // External tracks from the catalogue (English-first, max 3) come first:
  // they are usually cleaner than an embed's own ad-laden VTT. The provider's
  // snarfed WebVTT stays as a bonus, capped by the combined list length.
  const external = await externalPromise;
  const externalSubs = external.map((sub) => ({
    kind: "vtt",
    label: sub.label,
    playlistUrl: `/rip/subs/${encodeURIComponent(sub.url)}`,
  }));

  // Snarfed WebVTT tracks from the provider player (2026-10-24): register
  // per-URL replay headers so the byte proxy can fetch each one, normalize
  // labels, and ship them for the CC sheet items.
  const snarfedSubs = (result.subs ?? [])
    .map((sub, index) => {
      const subUrl = typeof sub?.url === "string" ? sub.url : "";
      if (!subUrl) return null;
      const subHeaders = sub.headers && typeof sub.headers === "object" ? sub.headers : {};
      rememberHeaders(subUrl, subHeaders);
      const label =
        typeof sub.label === "string" && sub.label.trim() !== ""
          ? sub.label.trim()
          : `Subtitle ${index + 1}`;
      return {
        kind: "vtt",
        label,
        playlistUrl: `/rip/hls/${encodeURIComponent(subUrl)}`,
      };
    })
    .filter(Boolean);

  const subs = [...externalSubs, ...snarfedSubs].slice(0, 6);

  cacheSet(key, {
    ok: true,
    provider: result.provider,
    providerName: result.providerName,
    kind: result.kind,
    playlistUrl,
    resolvedAt,
    headers: result.headers ?? {},
    rawUrl: result.url,
    subs,
  });
  rememberHeaders(result.url, result.headers ?? {});

  log(`[resolve] ${key} → ${result.provider} ${result.kind} ${result.url.slice(0, 120)}`);
  sendJson(res, 200, {
    ok: true,
    provider: result.provider,
    providerName: result.providerName,
    kind: result.kind,
    playlistUrl,
    resolvedAt,
    subs,
    cacheHit: false,
    tried: result.tried ?? [],
  });
}

/**
 * Byte proxy. Playlists are read whole, rewritten, and returned as text;
 * everything else streams through untouched (Range forwarded, status/headers
 * copied, unbuffered). Client disconnect aborts the upstream fetch.
 */
async function handleProxy(req, res, encoded) {
  let upstream;
  try {
    upstream = decodeURIComponent(encoded);
  } catch {
    sendJson(res, 400, { ok: false, error: "bad-encode" });
    return;
  }

  let parsed;
  try {
    parsed = new URL(upstream);
  } catch {
    sendJson(res, 400, { ok: false, error: "bad-url" });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    sendJson(res, 400, { ok: false, error: "bad-scheme" });
    return;
  }

  const controller = new AbortController();
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      log(`[proxy] upstream stalled 30s — aborting ${parsed.hostname}`);
      controller.abort();
    }, STALL_MS);
    stallTimer.unref?.();
  };
  const clearStall = () => clearTimeout(stallTimer);
  armStall();

  res.on("close", () => {
    if (!res.writableEnded) {
      clearStall();
      controller.abort();
    }
  });

  const headers = { ...replayHeadersFor(upstream) };
  delete headers.host;
  delete headers.connection;
  if (!headers.accept) headers.accept = "*/*";
  if (req.headers.range) headers.range = req.headers.range;

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    clearStall();
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: "upstream-fetch-failed", detail: String(err?.message ?? err) });
    } else {
      res.destroy();
    }
    return;
  }

  const contentType = String(upstreamRes.headers.get("content-type") ?? "");
  const looksPlaylist =
    /\.m3u8$/i.test(parsed.pathname) || /mpegurl/i.test(contentType);
  // WebVTT (external CC tracks): Chromium only parses text/vtt responses —
  // force the MIME so <track> cues load (2026-10-24).
  const looksVtt = /\.vtt$/i.test(parsed.pathname) || /vtt/i.test(contentType);

  if (looksPlaylist) {
    let text;
    try {
      text = await upstreamRes.text();
    } catch {
      clearStall();
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: "playlist-read-failed" });
      else res.destroy();
      return;
    }
    clearStall();

    if (!upstreamRes.ok) {
      const body = text.slice(0, 2000);
      res.writeHead(upstreamRes.status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
      return;
    }

    const { body, dropped, isMaster } = rewritePlaylist(text, upstream);
    if (dropped > 0) log(`ad-filter dropped ${dropped} lines from ${parsed.hostname}`);
    log(
      `[proxy] ${isMaster ? "master" : "variant"} ${parsed.hostname} ` +
        `${(body.match(/\/rip\/hls\//g) ?? []).length} children rewritten`,
    );

    const payload = Buffer.from(body, "utf8");
    res.writeHead(200, {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Content-Length": payload.length,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(payload);
    return;
  }

  // Segments (and direct MP4): stream straight through.
  const outHeaders = { "Access-Control-Allow-Origin": "*" };
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstreamRes.headers.get(name);
    if (value) outHeaders[name] = value;
  }
  if (!outHeaders["content-type"]) outHeaders["content-type"] = "application/octet-stream";
  // External WebVTT: force the CC-parsable MIME.
  if (looksVtt) outHeaders["content-type"] = "text/vtt; charset=utf-8";

  res.writeHead(upstreamRes.status, outHeaders);

  if (!upstreamRes.body) {
    clearStall();
    res.end();
    return;
  }

  const stream = Readable.fromWeb(upstreamRes.body);
  stream.on("data", armStall);
  stream.on("end", clearStall);
  stream.on("error", () => {
    clearStall();
    res.destroy();
  });
  res.on("error", () => {
    clearStall();
    stream.destroy();
    controller.abort();
  });
  stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const path = url.pathname;

  try {
    if (path.startsWith("/rip/")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    }

    if (req.method === "OPTIONS" && path.startsWith("/rip/")) {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "method-not-allowed" });
      return;
    }

    if (path === "/rip/health") {
      sendJson(res, 200, { ok: true, cacheSize: cache.size, ts: Date.now() });
      return;
    }

    if (path === "/rip/resolve") {
      await handleResolve(res, url.searchParams);
      return;
    }

    if (path.startsWith("/rip/subs/")) {
      const encoded = path.slice("/rip/subs/".length);
      if (!encoded) {
        sendJson(res, 400, { ok: false, error: "missing-url" });
        return;
      }
      await handleSubsProxy(req, res, encoded);
      return;
    }

    if (path.startsWith("/rip/hls/")) {
      const encoded = path.slice("/rip/hls/".length);
      if (!encoded) {
        sendJson(res, 400, { ok: false, error: "missing-url" });
        return;
      }
      await handleProxy(req, res, encoded);
      return;
    }

    sendJson(res, 404, { ok: false, error: "not-found" });
  } catch (err) {
    log(`[server] ${path} failed: ${err?.stack ?? err}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal", detail: String(err?.message ?? err) });
    else res.destroy();
  } finally {
    if (path !== "/rip/health") log(`${req.method} ${path.slice(0, 90)} ${res.statusCode} ${Date.now() - started}ms`);
  }
});

process.on("unhandledRejection", (err) => {
  log(`[server] unhandled rejection: ${err?.stack ?? err}`);
});

server.listen(PORT, HOST, () => {
  log(`[ripstream] sidecar ready on http://${HOST}:${PORT}`);
  log(`[ripstream]   GET /rip/health`);
  log(`[ripstream]   GET /rip/resolve?type=movie|tv&tmdbId=<id>&imdbId=<tt…>&s=<n>&e=<n>`);
  log(`[ripstream]   GET /rip/subs/<encodeURIComponent(srtUrl)>  (converted to WebVTT)`);
  log(`[ripstream]   GET /rip/hls/<encodeURIComponent(upstreamUrl)>`);
  log(`[ripstream] loopback only — LAN clients come through the Vite proxy at /rip`);
});

server.on("error", (err) => {
  log(`[ripstream] listen failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`[ripstream] ${signal} — closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref?.();
  });
}
