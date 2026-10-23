# Appy — Build Handoff Spec

> **Read this whole document before writing code.** It is self-contained. Every fact in
> section 3 was verified against the live sites; do not re-research it, and do not
> re-introduce the two source sites at runtime.

---

## 1. What this is

A personal, iOS-first streaming front-end deployed as a **static PWA on Netlify**.

It does **not** load `ssflix.pro` or `1hd.one`. Those sites were analysed and rejected:

- `ssflix.pro` loads a geo-tiered "smartlink" ad injector.
- `1hd.one` runs `aclib.runPop({ zoneId: '11679462' })` (Adcash) on every page, plus a
  `cloudvid.icu` redirector that 302s to `qemow.com/go/...`.
- On iOS Safari there is no uBlock/Poper Blocker (iOS Chrome is WebKit with no extension
  support), so those popunders and redirects make both sites unusable.
- Both are also blocked at the user's ISP.

Instead: **TMDB for metadata**, the **same third-party embed providers** those sites wrap,
loaded in a cross-origin iframe. No ad scripts ship in this repo, the embed cannot read
app data, and no blocked domain is ever requested. Playback position in a cross-origin
frame is unreadable, so "resume" means *which episode*, never *at what second*.

> **Measured 2026-10-22 in a real browser (headless Chrome, iPhone UA, cross-origin frame
> read via CDP).** All four providers detect a `sandbox` attribute on the embedding iframe
> and refuse to play: Videasy renders "Iframe Sandbox Detected", VidFast and VidLink render
> "Please Disable Sandbox", and Vidsrc reroutes to `vsembed.ru/sandbox.php` which answers
> **403**. A sandbox attribute and playback are therefore mutually exclusive with this
> provider set. **The iframe carries no `sandbox` attribute.** The original promise that
> popunders are *physically impossible* is unreachable here and is not made; what remains
> true is that no ad script ships from this repo, the frame is cross-origin, the referrer is
> suppressed, and app data is never reachable from the embed.

**Users:** Sam and Mellu, seeded. A button adds more profiles, hard-capped at 10.
Watchlists, history and preferences sync across devices via Netlify Blobs.

---

## 2. Non-negotiables

1. Two seeded profiles: **Sam**, **Mellu**. "Add profile" button, hard cap **10**
   (enforced in the UI *and* in the serverless function).
2. **Cross-device sync**: open on any device → choose a profile → watchlist, history and
   preferences are there.
3. **No ads**: ship no ad scripts, keep the frame cross-origin, suppress the referrer.
   A `sandbox` attribute is **not** an option — see §8: all four providers detect it and
   refuse to play. The watchdog's "next server" escape hatch is the working substitute.
4. Installable to the iOS Home Screen and runs standalone (no Safari chrome).
5. **Zero video bandwidth through Netlify.** Free tier only.
6. `ssflix.pro` and `1hd.one` must not appear anywhere in the source.

---

## 3. Verified facts — do not re-research

### 3.1 TMDB credentials (validated, HTTP 200 on both)

```
API Key (v3)            a011ec756814f5c4de4b9a27f989b8aa
API Read Access Token   eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhMDExZWM3NTY4MTRmNWM0ZGU0YjlhMjdmOTg5YjhhYSIsIm5iZiI6MTc5MjY4OTkwMS4xOTcsInN1YiI6IjZhZGE0NmVkYjRhYjU4Mzc1ZjA0OGJlNSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.p4iXZSI59JtTg2jlvZXhFWoLrqejTHs4RpFFs3X9s_g
```

Use the **v4 Bearer token** (`Authorization: Bearer <token>`). The v3 key is a fallback
(`?api_key=`). Both are read-only and rate-limited per key; they are safe to ship in a
client bundle. If abused, regenerate at TMDB and redeploy.

### 3.2 Provider matrix (verified 2026-10-22, iPhone UA, redirects followed)

| id | name | movie URL | TV URL | frameable |
|----|------|-----------|--------|-----------|
| `videasy` | Videasy | `https://player.videasy.to/movie/{tmdbId}` | `https://player.videasy.to/tv/{tmdbId}/{season}/{episode}` | yes — no XFO, no CSP |
| `vidfast` | VidFast | `https://vidfast.vc/movie/{imdbId}` | `https://vidfast.vc/tv/{imdbId}/{season}/{episode}` | yes |
| `vidlink` | VidLink | `https://vidlink.pro/movie/{tmdbId}` | `https://vidlink.pro/tv/{tmdbId}/{season}/{episode}` | yes |
| `vidsrc` | Vidsrc | `https://vidsrc.to/embed/movie/{imdbId}` | `https://vidsrc.to/embed/tv/{imdbId}/{season}/{episode}` | yes |

All four returned **HTTP 200** and sent **no `X-Frame-Options` and no `frame-ancestors`**.
They therefore can be framed. **Ranking was re-measured on 2026-10-22 in a real browser
(see §8) and supersedes the table order:** VidLink is the only provider proven to actually
play, so it is first in the registry; VidFast answers but 500s on its own stream endpoint;
Videasy's title loads but its stream-seed requests fail; Vidsrc is last and carries the most
popunder pressure (it loads `t.dtscout.com` and `tags.crwdcntrl.net` frames).

Note the table order above (Videasy first) reflects the original headers-only check and is
**not** the play order — `providers.ts` is authoritative.

Domain drift already observed: `player.videasy.net → player.videasy.to`,
`vidfast.pro → vidfast.vc`. Keep all URLs in one registry file so a swap is a one-line edit.

### 3.3 Providers explicitly excluded

| Host | Why |
|------|-----|
| `vidsrc.cc` | 403 + `X-Frame-Options: SAMEORIGIN` — cannot be framed |
| `embed.su` | dead (connection failure) |
| `0123movie.space` | 302s straight to an ad host (`mfw09.org`) — the popunder chain |
| `111movies.com` | works, but rotates domains (`ww17.…`) — too unstable for v1 |

### 3.4 Hard constraints discovered (design around these)

- **No stream extraction.** VidLink's player API (`/api/b/movie/{id}`) requires an
  `X-Playback-Environment` header and returns `null` for every title from datacenter IPs.
  CORS prevents calling it from your own origin. A Netlify function therefore cannot
  resolve direct streams, and the iframe is the only reliable playback path.
- **No playback position.** The player is cross-origin, so `currentTime` is unreadable.
  "Resume" means *which episode* and *when*, not *at 00:42:10*. Never claim otherwise in
  the UI.
- **No failure detection.** A cross-origin iframe that fails to load looks identical to one
  that loaded fine. Use a timer + a visible "Next server" escape hatch, not a spinner that
  hangs forever.
- **iOS content blockers do not run inside a Home Screen web app.** AdGuard / Poper
  Blocker cannot help once installed as a PWA. And a `sandbox` attribute cannot substitute
  for them either — it kills playback outright (§8). Rely on the watchdog plus the fact
  that no ad script ships from this repo.
- **Netlify Functions** have a 10s (sync) / 26s (background) timeout. Not used for video.

---

## 4. Stack

- **Vite 5** + **React 18** + **TypeScript**
- `react-router-dom` v6
- `vite-plugin-pwa` (manifest + service worker)
- `@netlify/blobs` (profile storage)
- Netlify Functions v2 (TypeScript, `netlify/functions/*.mts`)

Node 20+.

```bash
npm create vite@latest . -- --template react-ts
npm i react-router-dom @netlify/blobs
npm i -D vite-plugin-pwa
npm run dev          # http://localhost:5173
npm run build
npx netlify deploy --prod --dir=dist
```

---

## 5. File tree

```
Appy/
├── .env                         # VITE_TMDB_TOKEN (gitignored)
├── .env.example
├── .gitignore
├── index.html                   # iOS meta, theme-color, apple-touch-icon
├── netlify.toml
├── package.json
├── tsconfig.json
├── vite.config.ts               # vite-plugin-pwa config
├── public/
│   ├── manifest.webmanifest
│   └── icons/                   # 192, 512, maskable, apple-touch-icon (180)
├── netlify/functions/
│   └── profiles.mts             # GET/POST /api/profiles
└── src/
    ├── main.tsx
    ├── App.tsx                  # router + tab bar + profile guard
    ├── styles.css               # design tokens + layout
    ├── lib/
    │   ├── tmdb.ts              # v4 bearer client, typed
    │   ├── providers.ts         # the registry from §3.2
    │   ├── profiles.ts          # local profile cache + picker
    │   ├── sync.ts              # merge, debounce, pull/push
    │   └── store.ts             # IndexedDB (idb-keyval or raw)
    ├── components/
    │   ├── PosterCard.tsx
    │   ├── Row.tsx
    │   ├── SearchBar.tsx
    │   ├── Player.tsx           # cross-origin iframe + watchdog (NO sandbox — see §8)
    │   ├── ServerChips.tsx
    │   └── TabBar.tsx
    └── pages/
        ├── Profiles.tsx         # "Who's watching?" + add (cap 10)
        ├── Home.tsx
        ├── Search.tsx
        ├── Title.tsx
        ├── Watch.tsx
        └── Library.tsx
```

---

## 6. Data model

```ts
export type MediaType = "movie" | "tv";

export interface MediaRef {
  type: MediaType;
  tmdbId: number;
  imdbId?: string;
  season?: number;
  episode?: number;
}

/** Every synced record carries its own timestamp so merges are deterministic. */
export interface Stamped {
  id: string;          // stable key, e.g. "movie:603" or "tv:1399:2:4"
  updatedAt: number;   // ms epoch
  deletedAt?: number;  // tombstone — never physically delete
}

export interface WatchItem extends Stamped {
  mediaType: MediaType;
  tmdbId: number;
  imdbId?: string;
  title: string;
  posterPath: string | null;
  addedAt: number;
}

export interface HistoryItem extends Stamped {
  mediaType: MediaType;
  tmdbId: number;
  imdbId?: string;
  title: string;
  posterPath: string | null;
  season?: number;
  episode?: number;
  watchedAt: number;
}

export interface ProfileMeta {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface ProfileState {
  profileId: string;
  watchlist: WatchItem[];
  history: HistoryItem[];
  prefs: {
    preferredProvider?: string;   // provider id
    theme?: "dark" | "amoled";
  };
  updatedAt: number;
}
```

**Seed profiles** (`profiles/index.json` created on first GET if absent):

```ts
[
  { id: "sam",   name: "Sam",   color: "#00acc1", createdAt: <now> },
  { id: "mellu", name: "Mellu", color: "#ff6b9d", createdAt: <now> }
]
```

---

## 7. Sync API

Single function, two verbs. File: `netlify/functions/profiles.mts`.

| Request | Behaviour |
|---|---|
| `GET /api/profiles` | `{ profiles: ProfileMeta[] }`, seeding Sam + Mellu if the index is missing |
| `GET /api/profiles?id=sam` | `ProfileState` (empty state if the profile has no document yet) |
| `POST /api/profiles` `{ name, color? }` | creates a profile; **rejects with 409 when 10 exist** |
| `POST /api/profiles?id=sam` `{ watchlist?, history?, prefs? }` | merges and stores |

Auth: header `x-family-key` compared against `process.env.FAMILY_KEY`
(default `"samandmellu"` when unset). Not real auth — it is a gate, and that is
intentional: no accounts, no email, no password resets.

Blobs layout (store name `appy`, **strong consistency**):

```
profiles/index.json      -> ProfileMeta[]
profiles/<id>.json       -> ProfileState
```

Reference implementation:

```ts
import { getStore } from "@netlify/blobs";

const MAX_PROFILES = 10;
const SEEDS = [
  { id: "sam",   name: "Sam",   color: "#00acc1" },
  { id: "mellu", name: "Mellu", color: "#ff6b9d" },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function mergeById<T extends { id: string; updatedAt: number }>(local: T[], remote: T[]): T[] {
  const out = new Map<string, T>();
  for (const rec of [...remote, ...local]) {
    const prev = out.get(rec.id);
    if (!prev || rec.updatedAt > prev.updatedAt) out.set(rec.id, rec);
  }
  return [...out.values()];
}

export default async (req: Request) => {
  if (req.headers.get("x-family-key") !== (process.env.FAMILY_KEY ?? "samandmellu")) {
    return json({ error: "forbidden" }, 403);
  }

  const store = getStore({ name: "appy", consistency: "strong" });
  const id = new URL(req.url).searchParams.get("id");

  let index = (await store.get("profiles/index.json", { type: "json" })) as any[] | null;
  if (!index) {
    index = SEEDS.map((s) => ({ ...s, createdAt: Date.now() }));
    await store.setJSON("profiles/index.json", index);
  }

  if (req.method === "GET") {
    if (!id) return json({ profiles: index });
    const state = await store.get(`profiles/${id}.json`, { type: "json" });
    return json(state ?? { profileId: id, watchlist: [], history: [], prefs: {}, updatedAt: 0 });
  }

  if (req.method === "POST") {
    if (!id) {
      if (index.length >= MAX_PROFILES) return json({ error: "profile_limit", max: MAX_PROFILES }, 409);
      const body = await req.json();
      const name = String(body.name ?? "").trim();
      if (!name) return json({ error: "name_required" }, 400);
      const meta = {
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36),
        name: name.slice(0, 24),
        color: body.color ?? "#8b5cf6",
        createdAt: Date.now(),
      };
      index.push(meta);
      await store.setJSON("profiles/index.json", index);
      return json({ profile: meta }, 201);
    }

    const patch = await req.json();
    const current = ((await store.get(`profiles/${id}.json`, { type: "json" })) ?? {
      profileId: id, watchlist: [], history: [], prefs: {}, updatedAt: 0,
    }) as any;

    const next = {
      ...current,
      profileId: id,
      watchlist: mergeById(patch.watchlist ?? [], current.watchlist ?? []),
      history: mergeById(patch.history ?? [], current.history ?? []),
      prefs: { ...current.prefs, ...(patch.prefs ?? {}) },
      updatedAt: Date.now(),
    };
    await store.setJSON(`profiles/${id}.json`, next);
    return json(next);
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/profiles" };
```

**Client merge rules**

- Pull on app start and when returning to the foreground (`visibilitychange`).
- Push debounced 2s after any change; IndexedDB is written immediately and is the
  working copy, so a lost connection never loses a click.
- Merge per record by `updatedAt` (newest wins). Deletes are tombstones: set
  `deletedAt = Date.now()` and `updatedAt = Date.now()`; filter tombstones out of the UI.
- Two devices editing the same item at once → last write wins. Acceptable at this scale.

---

## 8. Player

```tsx
<iframe
  src={src}
  title="Player"
  allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
  allowFullScreen
  referrerPolicy="no-referrer"
/>
```

**There is no `sandbox` attribute, and adding one breaks playback.** This was measured on
2026-10-22 with headless Chrome and an iPhone UA, loading each provider in an iframe and
reading the cross-origin frame via CDP:

| provider | with `sandbox` (spec v1) | without `sandbox` |
|---|---|---|
| vidlink | "Please Disable Sandbox" | **plays** — `<video>` present, timeline "0:00 / 2:16:20" |
| vidfast | "Please Disable Sandbox" | `<video>` present, but provider's own stream endpoint 500s |
| player.videasy.to | "Iframe Sandbox Detected …" | title renders, stream-seed requests fail |
| vidsrc.to | frame reroutes to `vsembed.ru/sandbox.php` → **403** | blank; loads ad frames |

§3.2 verified these providers can be *framed* (no `X-Frame-Options`, no `frame-ancestors`).
That is a headers check and it is a different question from surviving a sandbox check —
**framing does not imply sandbox survival.** Re-add the sandbox and the app shows a dead
player on every server.

What still protects us without a sandbox: no ad script ships from this repo, the frame is
cross-origin so it cannot reach app state or IndexedDB, `referrerPolicy="no-referrer"`
suppresses the referrer, and neither blocked domain is ever requested. Popunders are no
longer *impossible*, so the watchdog below is the working substitute for a hard guarantee.

### 8.1 Ads and the "own player" question (measured 2026-10-23 — do not re-attempt)

A user asked for a homemade `<video>` player to remove ads. Both the client-side and
server-side paths were measured and are **dead ends**. Recorded here so no future build
burns time re-attempting them.

- **Zero video ads.** Across 2 runs × 4 providers there were **no pre-roll / VAST ads** —
  the video is never interrupted or replaced. The real intrusion is popunders/new tabs
  (~1s after tap), tracking-pixel farms, and one invisible click-ad overlay on VidLink.
- **Client-side extraction is impossible.** The parent cannot read a cross-origin frame
  (SOP). VidLink's `currentSrc` is a `blob:` MSE URL (meaningless outside its own document);
  the real `.m3u8` transport is fetched *inside* the frame and never reaches the parent's
  resource timing. A control experiment measured CSP headers, Service Workers, and parent
  event listeners all **ineffective** — the frame still loaded its ad hosts and the popunder
  still fired. `postMessage` would need provider cooperation (it doesn't exist).
- **Server-side extraction is impractical here.** VidLink's API needs
  `X-Playback-Environment`, returns `null` from datacenter IPs, and is CORS-walled (§3.4);
  Vidsrc's stream JWT embeds `ip_cidr` + a 4h expiry (a server-resolved URL breaks for any
  viewer outside the resolver's IP range); VidLink's stream rides CloudFront-signed cookies
  (→ the byte-proxying §15 forbids); Netlify's 10s/26s function timeouts cannot run headless
  Chrome. A working version needs a VPS browser-farm — a different, brittle product.
- **The iframe is the only viable playback path.** Ads are managed (watchdog, focus-return
  recovery, `no-referrer`, no ad script from our origin), not eliminated. Zero
  `window.top.location` hijack attempts were observed in 8 provider sessions.
- Raw data: `qa/ad-measure-results*.json`; ranking — VidLink (plays, moderate tracking) is
  the default; Vidsrc plays but carries the worst ad infrastructure (20 ad hosts, 6–7 ad
  frames) so it stays a distant last resort.

**Selection logic**

1. If the profile has `prefs.preferredProvider` and it builds a URL → use it.
2. Else probe the top three with a 2.5s `no-cors` fetch and pick the fastest that answers:

```ts
async function probe(url: string, timeout = 2500): Promise<number> {
  const t0 = performance.now();
  try {
    await fetch(url, { mode: "no-cors", cache: "reload", signal: AbortSignal.timeout(timeout) });
    return performance.now() - t0;
  } catch {
    return Infinity;
  }
}
```

   This measures DNS + TLS + headers, not video readiness. It is a tiebreaker, nothing more.
3. After 6s, show a dismissible "Not playing? Try next server" bar. Never a spinner that
   hangs forever — a failed cross-origin iframe is indistinguishable from a working one.

**Server chips** sit above the player: one chip per provider that builds a URL for the
current media (VidFast/Vidsrc need `imdbId`; hide them when it is missing). Selecting a chip
writes `prefs.preferredProvider`.

**Progress semantics** (be explicit in the UI): opening an episode writes a `HistoryItem`
with `season`, `episode`, `watchedAt`. There is no second-level resume, because the iframe's
`currentTime` is unreadable. Label it "Continue", not "Resume at 42:10".

---

## 9. Screens

| Route | Contents |
|---|---|
| `/profiles` | "Who's watching?" grid, avatar tiles, **Add profile** (hidden at 10), delete/edit menu |
| `/` | Hero (trending #1) + rows: Continue Watching, Trending, Popular Movies, Popular TV |
| `/search` | Debounced `/search/multi`, poster grid, keyboard-safe |
| `/title/:type/:id` | Backdrop, title, year, runtime, rating, overview, cast strip, **Add to list**, **Play**, season/episode picker for TV |
| `/watch/:type/:id` | Full-bleed player, server chips, back button, next-episode button |
| `/library` | Tabs: Watchlist / History, per active profile |

TMDB endpoints:

```
GET /3/trending/all/week
GET /3/movie/popular
GET /3/tv/popular
GET /3/search/multi?query=…&include_adult=false
GET /3/movie/{id}?append_to_response=credits,external_ids
GET /3/tv/{id}?append_to_response=credits,external_ids
GET /3/tv/{id}/season/{n}
```

Images: `https://image.tmdb.org/t/p/w342{poster_path}`,
`https://image.tmdb.org/t/p/w780{backdrop_path}`. `imdb_id` comes from
`external_ids.imdb_id`.

---

## 10. Netlify config

`netlify.toml`:

```toml
[build]
  command = "npm run build"
  publish = "dist"
  functions = "netlify/functions"

[build.environment]
  NODE_VERSION = "20"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

Functions v2 with `config.path` needs no `/api/*` rewrite. The SPA catch-all must stay last.

Environment variables (Netlify UI → Site settings → Environment):

| Key | Scope | Value |
|---|---|---|
| `VITE_TMDB_TOKEN` | build (public) | the v4 read token from §3.1 |
| `FAMILY_KEY` | functions (secret) | family passphrase, default `samandmellu` |

Locally: `netlify dev` injects Blobs and function env. Plain `npm run dev` will not have
Blobs — the sync layer must degrade gracefully to local-only when `/api/profiles` is
unreachable (show "Offline — changes saved on this device").

---

## 11. iOS / PWA requirements

`index.html`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="theme-color" content="#0b0f14" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
```

`manifest.webmanifest`: `display: "standalone"`, `start_url: "/"`, `background_color` and
`theme_color: "#0b0f14"`, icons 192 + 512 + `purpose: "maskable"`.

CSS: use `100dvh`, pad the tab bar with `env(safe-area-inset-bottom)`, and set
`overscroll-behavior: none` on the player page so a swipe does not bounce the whole app.

Install: **Safari** → Share → Add to Home Screen. (Chrome/Firefox on iOS cannot install
PWAs.) The app must still work in normal Safari tabs.

---

## 12. Design system

```
--bg          #0b0f14
--surface     #111722
--surface-2   #151d2a
--border      rgba(255,255,255,0.10)
--text        #ffffff
--muted       #9ba5b3
--accent      #00acc1
--danger      #ff5c5c
--radius      16px
font          -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
```

Poster grid: 2 columns at phone width, 3–4 at tablet, 6 at desktop. Rows scroll
horizontally with `scroll-snap-type: x mandatory` and hidden scrollbars.

---

## 13. Build order + acceptance tests

1. **Scaffold** — Vite + TS + router + tokens. `npm run dev` renders a dark shell.
2. **Profiles** — picker, Sam + Mellu seeded locally, add button capped at 10.
   *Test:* adding an 11th is impossible from the UI.
3. **Catalogue** — home rows, search, title page, episode list. *Test:* search "matrix"
   returns results; a TV show lists seasons.
4. **Player** — provider registry, chips, probe, watchdog. *Test:* open a movie, the
   iframe loads, tapping around never opens a new tab or leaves the app.
5. **Sync** — Blobs function, passphrase gate, offline fallback, tombstone merge.
   *Test:* add a title on the phone, open the app on a second device, pick the same
   profile, the title is there.
6. **PWA + deploy** — manifest, icons, service worker, `netlify deploy`, install on both
   phones.

**Definition of done**

- [ ] Sam and Mellu exist on first launch; a third and fourth profile can be added; the
      add button disappears at 10 and the API returns 409 beyond that.
- [ ] Watchlist and history survive a full reload and appear on a second device.
- [ ] No `ssflix.pro` or `1hd.one` string anywhere in `src/` or `dist/`.
- [ ] Tapping anywhere in the player never opens a tab, App Store page, or giveaway site.
- [ ] App installs to the Home Screen and launches without an address bar.
- [ ] Netlify deploy is under the free tier and no video bytes pass through it.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| A provider changes domain (`vidfast.pro → vidfast.vc`) | single registry file, one-line edit |
| A provider adds `X-Frame-Options` | that server goes blank; chips let you switch; watch the console |
| Blobs eventual consistency | `consistency: "strong"` on the store |
| Passphrase is not real auth | acceptable — watchlist data only; do not store anything sensitive |
| iOS evicts site data | optional JSON export/import of a profile in Settings |
| TMDB key in bundle | read-only, free, rate-limited; regenerate if abused |

---

## 15. Do not do

- Do not proxy video bytes through Netlify.
- Do not attempt server-side stream extraction (see §3.4 — geo-blocked and CORS-walled).
- Do not try to style or script inside the provider iframe.
- Do not promise second-level resume; the position is unreadable.
- Do not add an "educational purposes" banner, disclaimer, or ad-blocker upsell.
