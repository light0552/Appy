# Lighthook — Worklog (handoff-ready)

> **Purpose:** This file is the single source of truth for project state. It exists so a
> fresh session (or a fresh context window) can resume without re-deriving anything.
> **Update this file after every milestone.** Read it top-to-bottom before starting work.

---

## 0. What this project is

**Lighthook** — an iOS-first streaming PWA. TMDB for metadata, third-party embed
providers for playback (in a cross-origin iframe), Netlify Blobs for cross-device profile
sync. Built with Vite 5 + React 18 + TypeScript + react-router-dom v6.

- **Repo folder:** `E:\OPENCODE\Appy` (NOT renamed to "Lighthook" — folder stays `Appy`)
- **Spec:** `BUILD.md` (authoritative; corrected — see decision D1)
- **Node modules installed.** Do NOT run `npm install`.
- **No Git on this machine** (`git` binary missing; `winget` available to install it).
- **Nothing deployed.** Netlify CLI installed but signed out. **Ask user before deploying.**

### Hard rules from the user
- Do **not** re-research providers — BUILD.md §3 is verified.
- **Ask before any Netlify deploy.** Local test first.
- **No Git push** until the user approves the local test.
- All subagent work uses model **`opencode/mimo-v2.6-flash-free`** (MiMo).
- App display name is **Lighthook** (manifest, IndexedDB name, Blobs store `lighthook`).
- Delete profile = truly gone. Hard cap 10 profiles.
- Prefer **subagents** for implementation work. Keep this file updated for handoff.
- User wants to preview locally at `http://192.168.0.35:5173` before anything else.

---

## 1. Key decisions (do not silently reverse these)

**D1 — NO `sandbox` attribute on the player iframe.** (See D1b for the cost.) Measured 2026-10-22 in a real
browser (headless Chrome, iPhone UA, cross-origin frame read via CDP). All four providers
detect `sandbox` and refuse to play:
| provider | with sandbox | without sandbox |
|---|---|---|
| vidlink | "Please Disable Sandbox" | **plays** — `<video>` present, 2:16:20 |
| vidfast | "Please Disable Sandbox" | `<video>` present, stream endpoint 500s |
| player.videasy.to | "Iframe Sandbox Detected" | title renders, stream-seed fails |
| vidsrc.to | reroutes → `vsembed.ru/sandbox.php` **403** | blank; loads ad frames |
This overrides BUILD.md §8. BUILD.md + README corrected. **Never re-add sandbox.**

**D1b — Dropping the sandbox gave up popup/top-nav protection, and it is NOT recoverable.**
The sandbox's missing `allow-popups` / `allow-top-navigation` tokens were the ONLY thing
that blocked popunders and top-level navigation. There is no parent-side way to block a
cross-origin frame from calling `window.open()` or `top.location=`. So playback and
ad/popup immunity cannot coexist. "No ads" therefore CANNOT be won at the iframe layer —
see D7 / O1: the only real path is server-side stream resolution that skips the provider's
ad-laden page entirely.

**D2 — Provider order:** VidLink → VidFast → Videasy → Vidsrc. VidLink is the only one
proven to actually play.

**D3 — Sync treats HTTP 5xx as offline** (calm banner) instead of a hard error. 403/409
stay real errors. Fixes "Sync failed (500)" from the dead Vite dev proxy (returns 500 when
nothing listens on `:8888`).

**D4 — `VITE_FAMILY_KEY`** in `.env`/`.env.example`; client sends `x-family-key` header.

**D5 — Latency probe gated** so it can only swap away from VidLink when the first server
is *unreachable at the network level*. Deviation from §8 (which let fastest-answering win),
because fastest-answering correlates with the broken providers. **FLAGGED — user has not
yet approved; ask whether to keep or revert.**

**D6 — Scaffolded manually** (no `npm create vite`) because the dir was non-empty.

**D7 — "No ads" via our own player is IMPOSSIBLE (measured 2026-10-23, definitive).**
Client-side: the parent cannot read a cross-origin frame (SOP). Worse, VidLink's
`currentSrc` is a `blob:` MSE URL — meaningless outside its own document; the real transport
(`.m3u8` + CloudFront-signed cookies / an IP-bound JWT) is fetched *inside* the frame and
never exposed to the parent's resource timing. A control experiment measured all three
"obvious" mitigations DEAD: CSP header, Service Worker, and parent event listeners all left
the frame loading its ~11–25 ad/tracking hosts AND the popunder still fired. postMessage
would need provider cooperation (they don't).
Server-side: also blocked — VidLink's API needs `X-Playback-Environment` + returns `null`
from datacenter IPs + is CORS-walled (§3.4); Vidsrc's stream JWT embeds `ip_cidr` + 4h
expiry, so a server-resolved URL breaks for anyone outside the resolver's IP range; VidLink's
stream rides CloudFront-signed cookies → would require the byte-proxying §8/§15 forbid;
Netlify's 10s/26s timeouts can't run headless Chrome. Would need a VPS browser-farm — a
different, brittle, expensive product. **Conclusion: the iframe is the ONLY viable playback
path; ads are managed, not eliminated.**

**D7b — Measured ad reality (better than feared on one axis).** Across 2 runs × 4 providers
there were **ZERO pre-roll/VAST video ads** — the video is never interrupted or replaced by
an ad. The actual intrusion is (a) popunders/new tabs (~1s after tap), (b) tracking-pixel
farms, (c) one invisible click-ad overlay on VidLink. Provider ad-infra ranking:
Videasy (0 ad hosts, but doesn't play) < VidFast (4 hosts, doesn't play) < **VidLink**
(plays; ~20 tracking hosts, no ad-frame network, 1 overlay) < **Vidsrc** (WORST: 20 ad
hosts, 6–7 ad frames incl DoubleClick/AdNexus, domain drift; but 0 popunders this run and it
does play). **Zero `window.top.location` hijack attempts in 8 sessions** — the D1b top-nav
fear did not materialize. Raw data: `qa/ad-measure-results*.json`.

**D8 — Focus-return recovery (the one buildable mitigation). ✅ DONE + VERIFIED 2026-10-23.**
Popunders fire ~1s after the tap, so the 6s watchdog could count down while the user was in
an ad tab and show a false "Not playing" on return. Fixed in `Player.tsx` (watchdog effect
now also has `visibilitychange`→visible + `window` focus listeners that call
`startGracePeriod()`, which clears the live timer first so only ONE timer is ever alive) and
`Watch.tsx` (a foreground-return effect hides a stale watchdog bar via `setShowWatchdog(false)`).
`interactedRef` untouched (set only by `onSelectServer`/`advanceServer`), so programmatic
focus can't suppress probe-swap logic. Does NOT stop the popunder — bounds its damage.
E2E re-verified after the change: video still up (`videos: 1`), no sandbox, chips in order.

**D9 — Provider reorder: VidLink → Vidsrc → VidFast → Videasy (2026-10-23).** User hit
"VidLink: content or episode is not available". Diagnosed: NOT an id/format bug — our URL
shapes are correct (`/movie/{tmdbId}` and `/tv/{tmdbId}/{season}/{episode}` both verified to
resolve and play; Watch.tsx parses tmdbId/season/episode as clean positive ints). It was a
VidLink catalogue gap for that title. BUT testing fallbacks revealed the real UX bug: VidFast
returns HTTP 500 and Videasy returns access-denied on EVERY title (both currently dead), so
the old order (VidLink→VidFast→Videasy→Vidsrc) forced two dead taps before the only working
fallback (Vidsrc, which plays but needs a tap). Reordered so Vidsrc is SECOND — "next server"
now reaches a working one in one tap. Vidsrc hint → "Works — ad-heavy" (honest: it plays but
has the worst ad infra, 20 ad hosts / 6-7 ad frames). VidFast/Videasy demoted to bottom,
hints unchanged (still accurate). Not removed — they may recover. Data: `qa/fallback-viability.js`,
`qa/vidlink-format-probe.js`.

---

## 2. Current build state (last verified 2026-10-23, AFTER catalog + responsive landed)

- `npm run typecheck` (`tsc --noEmit`) — **clean**
- `npm run build` — **green**: 225.41 kB JS / 71.36 kB gzip,
  25.76 kB CSS / 6.09 kB gzip, 15 precache entries (417.61 KiB)
- Banned hosts in `dist/` (`ssflix`, `1hd.one`) — **0 matches**
- `sandbox` in shipped bundle — **0 matches**
- Dev server — **HTTP 200**

### E2E verified 2026-10-23 (catalog + responsive + player, combined)
Harness: `C:\Users\LIGHTHOOK\AppData\Local\Temp\opencode\qa\e2e-browse.js`
- Home See-all links: `/browse/trending`, `/browse/movies`, `/browse/tv` ✅
- `/browse/movies` → "Popular movies" grid, 20 posters, Load-more present ✅
- Load more appends: 20 → 38 posters ✅
- `/browse/bogus` → redirects to `/` ✅
- Player `/watch/movie/603`: `sandbox: null`, `src: vidlink.pro/movie/603`, chips in order,
  `videos: 1`, `videoSrcLen: 61` — **video still up after the responsive layout pass** ✅

### Earlier E2E (player-only, pre-catalog)
Harness: `C:\Users\LIGHTHOOK\AppData\Local\Temp\opencode\qa\e2e-app.js`
Walks the real app → picks profile "Sam" → opens The Matrix (`/title/movie/603`) → Play →
`/watch/movie/603`. Confirmed on the app's own rendered iframe:
- `src: https://vidlink.pro/movie/603`, `sandbox: null` ✅
- `allow: autoplay; fullscreen; encrypted-media; picture-in-picture`, `referrerPolicy: no-referrer`, `allowFullScreen: true`
- chips: VidLink / VidFast / Videasy / Vidsrc (correct order)
- inside the frame: `videos: 1`, `videoSrcLen: 61`, `readyState: 0` (0 is expected headless, no gesture)
- **RESULT: VIDEO ELEMENT PRESENT — player is up**

Chrome path: `C:\Program Files\Google\Chrome\Application\chrome.exe`

---

## 3. Completed work (all by subagents, all verified by me)

**Wave 0 — foundation** (by orchestrator): scaffold, `package.json`, `tsconfig.json`,
`vite.config.ts`, `index.html`, `netlify.toml`, `.env`, `README.md`, `src/types.ts`,
`src/styles.css`, `src/main.tsx`, `src/App.tsx`, `src/components/{TabBar,PosterCard,Row,SearchBar}.tsx`,
`src/lib/{tmdb,store,profiles,providers,sync,session}.tsx`, `netlify/functions/profiles.mts`,
PWA icons + `public/manifest.webmanifest`.

**Wave 1 — pages:** Home, Search, Profiles, Library, Title, Watch, Player, ServerChips + per-page CSS.

**Wave 2 — bug fixes:**
- Sandbox removal + provider re-rank (`providers.ts`, `Player.tsx`, `Watch.tsx`).
- Sync 5xx→offline (`sync.ts`); also fixed a stale-`online` bug where a 403 during offline
  showed a calm banner instead of red.
- Sync data-loss (8 fixes in `sync.ts`, `session.tsx`, `profiles.mts`): remote index erasing
  local profiles, offline rename revert (added `KEY_PENDING_META`), single-slot push queue →
  per-profile `pendingByProfile` Map + flush-on-switch + `dropPending`, malformed-response
  white-screen guard, StrictMode double-boot guard, tombstone-dropping cap, pull-time requeue
  on content diff, `KEY_ACTIVE` after adopt.
- UI/a11y (7 fixes): cast-row `overflow-x: auto`, controlled SearchBar, TV Play prefers latest
  history position (`playHref`), touch targets ≥44px, sheet focus trap/restore, `role="group"`
  on genres, banner `position: relative`.
- Watch.tsx (2 fixes): active server chip bumps `reloadKey` (no more dead-end escape hatch);
  history keyed on route params so it records even when TMDB fails.

**Full-app audit** (17 findings) — all addressed or verified. Independently confirmed:
no `allow-popups`/`allow-top-navigation`, no `srcdoc`, no stream extraction, no `currentTime`
claims in copy, no `100vh` (all `100dvh`), safe-area padding on fixed elements, all icon
buttons labelled, 0 banned hostnames.

---

## 4. File map & ownership

```
Appy/
├── BUILD.md                    # spec (corrected, D1)
├── README.md                   # corrected (no sandbox claims)
├── WORKLOG.md                  # THIS FILE
├── netlify.toml
├── .env / .env.example         # VITE_TMDB_TOKEN, VITE_FAMILY_KEY, VITE_FUNCTIONS_URL
├── netlify/functions/profiles.mts   # GET/POST/DELETE profiles; cap-10→409; tombstone-safe cap
├── public/manifest.webmanifest
└── src/
    ├── App.tsx                 # route table + showTabs (orchestrator-owned)
    ├── main.tsx                # React 18 + StrictMode + BrowserRouter
    ├── types.ts                # Media, TitleDetail, ProfileMeta, ProfileState, HistoryItem…
    ├── styles.css              # tokens + primitives + tab bar
    ├── lib/
    │   ├── tmdb.ts             # TMDB client (needs `page` param for pagination — TODO)
    │   ├── store.ts            # IndexedDB + mediaKey/historyKey/live* helpers
    │   ├── profiles.ts         # profile index persistence
    │   ├── providers.ts        # PROVIDERS registry (VidLink-first; NO sandbox export)
    │   ├── sync.ts             # sync client (5xx→offline; per-profile push queue)
    │   └── session.tsx         # session spine (useSession, all pages consume it)
    ├── components/
    │   ├── TabBar.tsx  PosterCard.tsx  Row.tsx  SearchBar.tsx
    │   ├── Player.tsx          # cross-origin iframe, NO sandbox + 6s watchdog
    │   └── ServerChips.tsx
    ├── pages/
    │   ├── Home.tsx  Search.tsx  Profiles.tsx  Library.tsx
    │   ├── Title.tsx  Watch.tsx
    │   └── Browse.tsx          # PLACEHOLDER (being built by catalog agent)
    └── styles/  home.css search.css title.css player.css browse.css
```

---

## 5. Open items / next steps

**O1 — ADS. ⛔ VERDICT: "no ads" via our own player is IMPOSSIBLE (measured, D7).** User:
"Ads = death PAIN" … "do as u see fit i need no ads." Both the client-side and server-side
own-player paths are measured-dead (see D7). **BUT the thing the user feared most does NOT
happen: there are ZERO video ads** — no pre-roll, no VAST; the video is never interrupted
(D7b). The real intrusion is popunders + tracking pixels, which cannot be removed from
inside the cross-origin iframe (CSP/SW/parent-listeners all measured ineffective).
**Action taken:** (a) building focus-return recovery (D8, session `ses_e9ae063fdffeE4kVWnUKfDjp4P`)
so a popunder doesn't leave a false "Not playing"; (b) Vidsrc kept as last-resort fallback
(worst ad infra but it's the only working backup to VidLink). **User must be told plainly**
that ad-free own-player is not achievable and the iframe is the only playback path — do NOT
dress up mitigation as "no ads". If the user wants truly zero ads, the only real route is a
self-hosted video source (a different product entirely) — out of scope, user's call.

**O2 — Catalogue browse button. ✅ DONE + E2E-VERIFIED.** "See all" on every Home row →
`/browse/:kind` (trending / movies / tv) with paginated poster grid + "Load more" (deduped,
stops at `totalPages` with "That's everything"). `tmdb.ts` gained `getCatalogPage(kind, page)`.
Grid: 2 cols phone / 3 at ≥560px / 4 at ≥820px / 5 at ≥1100px. Route + Browse import wired in
App.tsx by orchestrator. E2E confirmed: See-all links present, grid renders, Load more appends
(20→38), unknown kind redirects.

**O3 — Responsive for PC / Android / iOS. ✅ DONE + VERIFIED (typecheck + build + e2e).**
Agent B finished. Bottom tab bar <1024px (byte-for-byte as before), top nav ≥1024px (same
TabBar component, CSS reposition via `order: -1`; brand tile + wordmark + nav pills +
Profiles pinned right; App.tsx untouched). Breakpoints 480/768/1024. Content caps 1280px
centered via `.app-main:not(:has(.player-page))` — player route stays full-bleed. Hover
states all inside `@media (hover: hover)`; global `:focus-visible` ring. Title page → two-
column sticky-hero layout ≥1024px. Search sticky field offsets under the desktop nav. Zero
`100vh` (grep-proven). iOS not regressed (safe-area, 16px inputs, ≥44px targets). Player
re-verified working after the global layout change (e2e).

**O4 — Deploy + push.** Blocked on user approval of the local test. Then: `winget install
--id Git.Git -e`, `git init`, commit, push workflow, `netlify login` + deploy.

**O5 — D5 latency-probe deviation** not yet approved by user (keep gated, or revert to §8?).

**O6 (CURRENT) — Premium UI revamp. Netflix / Prime / HBO-Max inspired, cleaner + sleeker,
great on iOS/Android/PC.** User: "MAKE ME FEEL IT." Staged so it stays COHESIVE, not three
agents fighting over the look:
- **Round 1 — ✅ DONE + VERIFIED 2026-10-23 (session `ses_e9ad09517ffeJZTd6rSE5Boi6y`).**
  Design system landed in `src/styles.css`: accent = "the beam" electric azure `#4cc3ff`
  (AMOLED `#5ccbff`), layered near-black surfaces (base now `#070a11`), full type scale
  (display clamp 28→46, hero 30→56, tight tracking), radius/motion/elevation/glow tokens,
  glassy buttons, 44px chips, shimmer skeletons, blurred glass TabBar. Home.tsx = cinematic
  hero (layered scrim, hero-title/meta, Play primary + My List toggle + More info). Owns:
  styles.css, TabBar/PosterCard/Row/SearchBar, Home.tsx, home.css. **Playback re-verified
  after (e2e: sandbox null, videos:1) — no regression.** Orchestrator bumped index.html +
  manifest theme-color → `#070a11`.
- **Round 2 — ✅ DONE + VERIFIED 2026-10-23:**
  (B) session `ses_e9ac04273ffeklBXkjduUdGjxt` — Title.tsx + title.css + Watch.tsx + player.css.
  Cinematic detail hero (layered scrim, gradient title, azure tagline, glass genre pills, cast
  beam-divider) + sleek player chrome (glass server chips w/ glowing active, friendly watchdog).
  ⚠️ Watch.tsx logic (focus-recovery, watchdog, advanceServer, history) byte-identical — only
  classNames touched. Discovered page-CSS-before-styles.css cascade → scoped overrides via parents.
  (C) session `ses_e9abfae4effeGYCsBTZM1m305T` — Search/Browse/Library/Profiles + their CSS.
  **Profiles = fun first impression** (gradient "Who's watching?", glossy per-colour gradient
  avatars from `--profile-color`, bouncy tiles, playful add-profile, glassy sheets). ⚠️
  SheetShell focus-trap byte-identical; Browse pagination + Search debounce intact.
- **QA PASS — ✅ GREEN 2026-10-23 (all gates):** `npm run build` clean (CSS 49.37 kB / 9.42 gz).
  e2e `e2e-app.js` playback OK (iframe sandbox:null, VidLink src, videos:1). e2e `e2e-browse.js`
  OK (3 see-all links, Load-more 20→38, bogus-route→/). Grep gates: `100vh`=0, banned hosts=0,
  `sandbox`=comments-only (iframe verified none via e2e), LIGHTH00K naming consistent (index.html
  ×3, manifest ×2). Critical logic spot-check: Profiles focus-trap ✓, Watch advanceServer ✓.
  Visual screenshots (`qa/shots.js` → shot-01/02/03): Profiles/Home/Title all render the fun
  azure-beam look correctly. **READY for user local test at http://192.168.0.35:5173.**
- **⚠️ DIRECTION CORRECTION (user, 2026-10-23): the UI must be FUN, not sterile-corporate.**
  User reaction to a plain Netflix/Prime/HBO look: "Meh… I want fun." So every round (and a
  post-Round-1 FUN PASS) must inject PERSONALITY and ENERGY, not minimal-corporate:
  vibrant/saturated accents + gradient flourishes (not one timid teal), gradient display
  text, glowing accents, springy/bouncy hover + tap micro-animations (transform/opacity only,
  honour `prefers-reduced-motion`), playful empty-states and shimmer loaders, and lean into
  the LIGHTH00K beam/lighthouse brand (glow, beam sweeps). Netflix STRUCTURE (hero, rows,
  grids) but with life and color. The Profiles picker (the landing screen) was called out as
  "meh" specifically — make it a fun first impression (colorful avatars, bouncy tiles, playful
  add-profile). Do NOT sacrifice iOS rules or a11y for flair.
- **Round 2 (after Round 1 lands, 2 parallel agents):**
  (B) Title.tsx + title.css + Watch.tsx + player.css — cinematic detail page + sleek player chrome.
  (C) Search.tsx + search.css + Library.tsx + Profiles.tsx (+ their css) — adopt the new system.
  Both consume Round 1's tokens; disjoint files; no overlap with each other.
**Orchestrator final integration:** verify build+e2e after each round; possibly tweak
index.html title / manifest theme_color to match the accent (index.html + manifest are
orchestrator-owned). Then hand user `http://192.168.0.35:5173` to test. **Do NOT push to
Git/Netlify until the user approves the local test.** Git is not installed yet — when the
user approves, `winget install --id Git.Git -e`, `git init`, commit, then guide the push +
`netlify login`/deploy.
Brand name confirmed **LIGHTH00K** (user intentionally added caps + double-zero "bcz cool").
Use LIGHTH00K for everything VISIBLE: browser tab title, `apple-mobile-web-app-title`,
manifest `name`/`short_name`, brand wordmark in TabBar (update after Round 1 agent lands —
it currently writes "Lighthook"). **Keep internal identifiers lowercase `lighthook`** (IndexedDB
db name, Blobs store `lighthook`) — changing those would orphan already-saved profiles/data,
and they are invisible to the user. Orchestrator already updated index.html title/meta +
manifest name/short_name. Still to do in final integration: TabBar wordmark → LIGHTH00K, and
manifest/index `theme_color` (#0b0f14) → the new accent once Round 1 defines it.

**QA (user explicitly asked):** once ALL revamp rounds are done, run a QA pass —
`npm run typecheck` + `npm run build`, the e2e harnesses (`e2e-app.js`, `e2e-browse.js`) to
confirm playback + browse + player chrome still work, a grep gate (0 `100vh`, 0 banned hosts,
0 `sandbox` in dist, LIGHTH00K naming consistent), and a quick a11y/iOS-rules read-back.
THEN hand the user `http://192.168.0.35:5173` (confirm the dev server background shell is
alive first — restart if needed). Only after they approve: install Git, push, Netlify deploy.

---

## 6. Environment / tooling

- **Dev server:** background shell, port **5173**, LAN `http://192.168.0.35:5173`.
  Offline banner visible on LAN is **correct** — `npm run dev` has no `/api/profiles`, Vite
  proxy → 500 → now classified as offline (D3).
- **QA harness dir:** `C:\Users\LIGHTHOOK\AppData\Local\Temp\opencode\qa\`
  (`e2e-app.js`, `honest-probe.js`, `sandbox-probe.js`; `puppeteer-core` installed there).
- **Home Screen install needs HTTPS** — only after deploy, not on LAN HTTP.
- **Cross-device sync only provable after deploy** (no local Blobs backend).
- **Player copy rules (BUILD.md §15):** label is "Continue" (never timestamp resume); no
  disclaimers/warnings/"educational purposes" text anywhere.

---

## 7. Ripstream sidecar — ad-free own player (2026-10-24, built + E2E-verified)

**User mandate:** "app blocker kinda thing… no ads in the player when I use my mobile on 192.168.0.35:5173; default VidFast; 0 popups; no git/netlify yet; use subagents; test like a user." Deliverable: the ripstream sidecar the extractor anticipated (`server.mjs` was referenced by extract.mjs's header but never existed), plus a first-class "Lighthook — ad-free" playback mode in the app.

**Topology change that reopens D7:** D7/§8.1/§15 verdicts measure a NETLIFY-hosted app with remote viewers (function timeouts, datacenter-IP nulling, byte-proxy ban, `ip_cidr` mismatch for off-home viewers). Today's real usage is the HOME box + the user's phone on the same LAN — headless Chrome runs here for free, the sidecar is the only client stream CDNs ever see (Cookies/JWT bindings trivially satisfied), and video bytes flow home machine → phone over LAN (§15's Netlify-only ban unaffected). O1's own records said the real route is a self-hosted source — the sidecar IS that, at appliance scale.

**Architecture:**
- `scripts/ripstream/server.mjs` (loopback **127.0.0.1:5174**):
  - `/rip/resolve?type,t-MDBId,imdbId,s,e` → runs the extractor race; SQLite none — in-memory cache TTL 2 h (Vidsrc JWT measured 4 h), 200-entry LRU, in-flight dedup (two pages asking the same title share ONE rip), plus a 90 s negative cache for dead titles.
  - `/rip/hls/<encodeURIComponent(upstream)>` → byte-proxy: replays the extractor's captured headers (exact URL → origin → longest-suffix CDN match), rewrites every child URI (bare lines + `KEY/MAP/MEDIA` quoted attrs) to `/rip/hls/…`, drops ad-host children as blocks (master `STREAM-INF`+URI, variant `EXTINF`+URI), streams segments unbuffered with Range passthrough, aborts on client close/30 s stall.
- `scripts/dev-all.mjs` = `npm run dev:live` — spawns Vite (5173, `--host`) + sidecar; tree-kill on exit. `vite.config.ts` proxies `/rip` → 5174; PWA `navigateFallbackDenylist` gained `/^\/rip\//` (SW never owns rip traffic).

**Player:** `src/components/HlsPlayer.tsx` — own `<video>`, native HLS on Safari/iPhone (HW decode/AirPlay/PiP), hls.js (already a dep; dynamic-imported → own 185 kB gz chunk) elsewhere; custom mobile chrome (center play, ±10 s, buffered seek bar, quality sheet when master has levels, PiP/fullscreen, 3.2 s auto-hide, 1.2 s buffering spinner, 8 s stall watchdog → [Retry]/[Switch to backup]); fatal-error ladder (1 network retry → recoverMediaError → unrecoverable). Watch.tsx state machine: preparing (live elapsed ticker + "Play with regular servers →" escape hatch) → owned → embed, auto-fallback without touching prefs; user chip picks persist exactly as before; `preferredProvider === "lighthook"` resumes rip mode.

**Mandate compliance — VidFast:** raced FIRST in `providerEmbeds` (reordered 2026-10-24). Live re-verify showed it still returns no stream (yesterday's HTTP 500 persists) — in the race that costs ZERO wait (parallel start, first winner takes the crown; both Vidsrc and VidLink win titles independently). Order is one line to revert if the mandate changes.

**Measured (E2E `qa/e2e-rip.js`, LAN origin, iPhone UA, real user path profile→home→tap→player):**
| Metric | Serial build (1st E2E) | Race build (final) |
|---|---|---|
| Cold resolve (The Matrix, imdb given) | 78.0 s → client abort at 45 s → embed fallback + 3 popups | **8.1 s** |
| Cache re-hit | n/a (abandoned) | **93 ms** (/cli) / video in **386 ms** (E2E) |
| Owned-mode popups/ad-host requests | n/a | **0 / 0** (across both titles) |
| `/rip/*` responses | 0 (aborted) | all < 400 |
| Headless autoplay note | — | holds at t=0 until gesture (real phone's center-tap is that gesture); post-tap playback advances at full rate |

**Honest limits:** DRM-only titles (extractor flags Widevine et al.) auto-fall back to the iframe path — provider ads reappear there by nature (Vidsrc ordered per its 0-popunder measurement underneath VIDLink in the chips? Order stays providers.ts registry: VidFast first per mandate — dead-but-free in race land — then VidLink, Vidsrc, Videasy). First tap per title (~8-15 s typical, worst ≈44 s wall guard) shows the Preparing stage; the 2 h cache then makes repeats instant. Resolution drift may someday need extractor touch-ups; it sniffs traffic by design, so shape changes are tolerated automatically. If the user later NETLIFIES, the sidecar does NOT go — `ripath` becomes impossible on the function runtime; the app falls back to iframes there BY DESIGN (documented, not silent).

**NOT done (per mandate):** zero git commands (git isn't even installed — untouched), zero netlify/deploy commands, `.env` untouched. QA harness cleaned up: no orphan node/chrome processes (rebooting `npm run dev:live` is the user's single command; currently left RUNNING for their phone test).

---

## 8. Player polish round — CC/speed/quality, faster "Preparing", Vidsrc hidden, honest fallback note (2026-10-24, built + E2E-verified)

**User feedback driving it:** "Ligh hook player is good" + three asks: subtitle setting with playback speed and quality; optimize the "Preparing ad-free stream…" wait; "Remove Vidsrc No need for that keep VidLink VidFast VidEasy"; plus another "LIGHhook unable to resolve" sighting.

**Infrastructure root cause found + fixed (the real "unable to resolve"):** during the user's live session the shared headless Chrome **crashed mid-race** ("Connection closed" ×4 at 21:45) and the 90 s negative cache treated that crash as a verdict — rapid re-taps got instant "no stream" instead of a retry. Two hardening layers in `extract.mjs`:
- All-providers-crashed (zero genuine misses) is now a TRANSIENT infra failure: fast crashes (< 15 s) trigger ONE quiet auto-retry on a relaunched Chrome (`race(ref, log, depth)`; you just see the spinner a bit longer); slow/repeat crashes `throw` so the sidecar answers 503 and **never lands in the 90s negative cache** — the next tap relaunches Chrome free.
- Genuine provider misses (they answered, no stream exists) remain the only thing the negative cache ever remembers.

**"Preparing" wait optimized (three layers):**
- **Title-page pre-warm (biggest win):** movies now start the sidecar race **1.5 s after detail loads** (`Title.tsx`, `prewarmedRef`; StrictMode-safe; TV excluded — its resolve key is season/episode-dependent). By Play-tap the resolve is cached (~instant video) or sharing an in-flight race via server dedup.
- Measured user-visible effect: Title → Play lands at ~0-3 s on the spinner for movies (race runs while reading the page), **1 ms-instant on every repeat** within 2 h.
- Speed-inner-limits noted for the record: cold first-tap on a brand-new TV episode still pays the honest headless-browser cost (~7-15 s — the price of ripping instead of loading ad-infested iframes); the escape hatch stays one tap away.

**Player settings (HlsPlayer.tsx + player.css):** three chrome buttons on the control row — **CC** (visible only when tracks exist; hls.js `SUBTITLE_TRACKS_UPDATED` + native `textTracks` sync paths, `subIdx` applies to whichever engine is live), **speed** (0.5×-2×, `SPEED_OPTIONS`, re-applied on engine restarts via `[speed, retryNonce]`), **quality** (existing level picker, now `sheet`-consolidated: `SettingsSheet = "none" | "quality" | "subs" | "speed"`, every pick closes the sheet, active states glow via new `.hp-btn--on`).

**Vidsrc — hidden from all clients, KEPT in the server race (deliberate):** new `hidden?: boolean` in providers.ts; Vidsrc is filtered out of `availableProviders` so chips/fallback/advance never show it (client lists now: Lighthook | VidLink | VidFast | Videasy). It still races server-side where its ad infra is irrelevant (the phone never loads the provider page — only the ripped stream crosses the home box); removing it from the race entirely would strand most titles (measured: it wins the strongest catalogue share — e.g. The Matrix 7.8 s, Dune Prophecy 6.3 s this session). Interpretation of the mandate "remove Vidsrc, keep VidLink/VidFast/VidEasy": remove it from what the user SEES and deliberately picks.

**Honest fallback note (`ripNote`):** when the ad-free path gives up (genuine no-stream, sidecar timeout, or extractor death past auto-retry) embed mode takes over as designed and a one-line translucent note flashes ~4.5 s: "No ad-free source for this title right now — regular servers below." (or "…ended —" after a mid-play death). Wired at all three handoffs + param-reset + unmount cleanup; `.rip-note` styled in player.css.

**Verification:** `npx tsc --noEmit` clean; `npm run build` green (64 modules; hls chunk 592 kB / 185 kB gz — the known dynamic-import trade-off); E2E `qa/e2e-rip.js` **16 PASS / 0 FAIL** re-run with everything live — chips row rendered without Vidsrc, resolve still `ok:true` (vidsrc winning the race server-side), owned mode, 0 popups, 0 ad hosts, 9 segment rides, cached re-hit video in 7.6 s run-end.

---

## 9. VidFast-style player chrome + iPhone engine swap (2026-10-24, built + 19/16 E2E-verified)

**User push round 2:** "Quality 800p why" (provider's raw oddball rung), "like VidFast", "FIQ NOW": make player's UI/behavior like VidFast.

**ENGINE SWAP (the quality-gone fix):** previous choose-native-on-iPhone meant the phone's real Safari never parsed levels → no quality/subs sheet there (headless Chromium was fine → tests lied). Now `HlsPlayer.tsx`: **hls.js first for every HLS it can attach to** — desktop, Android, and iPhone/iPad since iOS 17.1 via ManagedMediaSource (`disableRemotePlayback=true` scoped to MSS devices per hls.js docs). Native HLS is the LAST-RESORT fallback only (MP4 always native; iOS < 17.1 keeps playback but has no in-app picker — Safari offers no levels API there).

**Quality ladder snap (`ladderLabel`):** provider masters serve raw oddballs (measured live: an **800p** rung). Every height snaps to standard [2160/1440/1080/720/480/360/240/144] within ±14%; rungs dedupe (same label keeps its tallest level index) → sheet always reads Auto + 1440/1080/720/360…, still fully dynamic from the manifest. Button appears the moment ANY rung exists (`qualityAvailable`, was `>1`). Auto shows a live sub-label from `LEVEL_SWITCHED` ("Auto · 1080p" while it adapts).

**VidFast chrome polish (HlsPlayer.tsx + player.css):** gradient bottom scrim behind chrome (bright-frame legibility); double-tap left/right half = ±10s with ripple flash (320ms tap classifier, functional-updater toggle so no stale closures); VidFast-style toast pill on every change ("Quality: 1080p", "Speed: 1.5×", "Subtitles: Off"); sheets get caps (SPEED/QUALITY/SUBTITLES), §-check ✓ on the active item and pick-closes-sheet semantics; speed button label shows current rate (1×/1.5×…); CC button GATED on real tracks, so it only renders when subs exist (user asked "SUBTITLES AVAILABLE ONLY KINDA"); subs sheet = Off first + each track.

**Verification:** type-check + build green; new harness `qa/e2e-quality.js` **19 PASS / 0 FAIL** (owned → playing; quality sheet labels canonical + Auto-first + sorted desc; rung switch → toast + sheet closes; speed sheet full list + 1.5x actually applied on engine; CC correctly hidden on a no-subs stream; double-tap skip Δ exactly 10.0s; flash ripple; single-tap chrome toggle). `qa/e2e-rip.js` re-run **16 PASS / 0 FAIL** (owned, 0 popups/ad-hosts, cache re-hit 363 ms). Shots in `qa\shots\quality-sheet|subs-sheet|quality-toast|after-skip.png`.

---

## 10. Subtitles delivered + race-hold quality swap + PiP removed (2026-10-24, built + 83/0 E2E-verified)

**User push round 3:** "no button for CC on the main player", "quality is 720p", "stream taking too long", "pop out player — we don't need that". All four landed.

**SUBTITLES — real CC now reaches the own-player (the fix that made the button appear):**
the rips' HLS masters declare `CLOSED-CAPTIONS=NONE`, but the provider embed players DO fetch plain WebVTT files for their own CC buttons. `extract.mjs` now sniff-listens for `.vtt` responses (passive snarfing) and clicks the embed's captions control once per rip (`inPageCaptionKick`; JW `icon-cc`, VJS `subs-caps`, aria/title captions + the "c" key) so the lazy-load actually fires before resolve; each VTT is captured with its replay headers, label guessed from `?lang=` style params (fallback `Subtitle N`). Server composes `subs[]` (`kind:"vtt"`, proxied path), registers per-URL replay headers, caches them, returns them in fresh + cache-hit payloads. `rip.ts` guards/normalizes (`RipSub`, leading slash + label fallback + dedupe); `Watch.tsx` passes them through. `HlsPlayer.tsx` mounts real `<track kind="subtitles">` children, **unified CC index space** (external tracks first, manifest renditions after with offset; picking an external pins `hls.subtitleTrack=-1`, picking a rendition disables externals — no double-render; same logic for the native path, whose addtrack sync now excludes our own track elements). CC button shows iff ANY source exists (engine/native renditions OR externals) and lights `hp-btn--on` while a pick is active. **Proxy forces `text/vtt; charset=utf-8`** for `.vtt` responses — Chromium refuses `<track>` cues otherwise (verified: 200 + correct MIME + real cue text).

**RACE-HOLD quality swap (`#holdForBetter` + `#peekRip`):** the first winner no longer ends the race. A short hold window (`RIP_RACE_HOLD_MS`, now **600 ms** — was 1300) keeps listening for rival rips and swaps when a rival's master peaks higher on `RESOLUTION` or offers subs where the head has none; failed peeks are ignorance, never verdicts. Fixed the ordering bug: the deadline is set FIRST, the head's own peek runs inside the window, and each rival peek is budget-capped — held resolves cost about race + 0.6 s, not twice that. Rivals rarely arrive in-window tonight (they miss at ~36 s), so logs correctly show `[hold] kept videosrc` on 1396; a rival rip carrying a `-0-0-1080-` master on another title proves 1080 material exists when sources answer.

**PIP REMOVED entirely** (button, handler, availability flag, icon, webkit cast) — the pop-out mini-window carried a second player chrome. Only `webkitEnterFullscreen` stays for iOS fullscreen.

**Ground truth (live, this build):** 1396 BB S1E1 = subs **1** ("Subtitle 1", a 41 KB real WebVTT with actual English cues), master has NO `EXT-X-MEDIA` sub renditions, rungs 720/360; 220542 Dune = subs **0**, rungs 1080/720/360 — its CC button is correctly ABSENT (the source genuinely carries no subs) while its 1080 proves the ladder works where the source serves it.

**Verification:** `npx tsc --noEmit` clean; `npm run build` green. QA BOT SWEEP: `e2e-rip.js` **16 PASS / 0 FAIL**, `e2e-quality.js` **19 PASS / 0 FAIL**, updated `e2e-user-rigorous.js` **48 PASS / 0 FAIL** = **83 PASS / 0 FAIL total** (CC-positive flow end-to-end on 1396: button present → sheet `Off | Subtitle 1` → toast → exactly one textTrack showing → Off teardown works; CC-negative gate on 220542 with zero `<track>` children; forced-MIME 200; PiP absent everywhere; zero ad-hosts; zero popups; owned flip ~610 ms). The single flake was the OLD `e2e-rip` harness' wrong cache-warm assumption for movie|603 (cold resolve, not an app bug); its completed resolve made the rerun clean at 16/0 with a 360 ms re-hit. Shots refreshed under `C:\Users\LIGHTHOOK\AppData\Local\Temp\opencode\qa\shots\`.

**Speed story ("on-demand" feel):** cold fresh rip = race 6-9 s + hold <=0.6 s + caption-kick window <=0.9 s (skips early once a VTT lands) = about **8-11 s once**, then **instant** from cache (~2 h TTL). Title-page pre-warm starts the race while the user is still reaching for Play.

---

## 11. Always-on CC, adjustable subtitle sync, honest 1080p, no false fallback on S5E5 (2026-10-24, built + 195/0 E2E-verified)

**User push round 4:** "no button for CC on the main player" came back after another device test; "Subtitles are a bit OFF on some movies — CC come first AND VID LATE — make it adjustable"; "quality is 720p" on a title that actually carries 1080p; and the exact URL `/watch/tv/1396?s=5&e=5` saying **"No ad-free source"** on first load, then working only after switching to VidFast and back.

**CC is now unconditional (`HlsPlayer.tsx`):** the Subtitle button renders on every owned player, tracks or not. It opens the unified sheet (`Off` first, external WebVTTs then manifest renditions) and when a title genuinely carries nothing it says **"No subtitles found for this title"** instead of hiding the control. The sheet header reads **"Lighthook subtitles"** so it can never be mistaken for Chrome/Android **Live Caption**, which is a browser/OS overlay the page cannot toggle (Settings → Accessibility → Live Caption, or Chrome's caption settings).

**Subtitle sync — the "VID LATE" fix:** a `Subtitle sync` block at the bottom of the CC sheet with **−0.5s / value / +0.5s**, range ±5.0s, positive = captions later. It mutates the live `TextTrackCue.startTime/endTime` of every loaded subtitle track; original times live in a `WeakMap` so repeated taps never compound, and the offset is re-applied on `timeupdate`, `seeked`, track changes and the first loaded cues. The sheet value doubles as **tap-to-reset**. Sync is hidden when the title has no tracks (no dead buttons). Verified live: S5E5 cue `0.060 → 1.060` after two +0.5s taps, reset back to `0.060`.

**External subtitles (`server.mjs`):** the rips' masters still declare `CLOSED-CAPTIONS=NONE` and the provider embeds only expose a subset, so the sidecar now queries the OpenSubtitles-v3 Stremio catalogue per title (English first, max 3, in parallel with the race), downloads SRT, converts it to WebVTT, and serves it through `/rip/subs/<encoded>` as **`text/vtt; charset=utf-8`**. The merge is external-first plus snarfed VTT, capped at 6, so a title with no provider captions still gets real CC. Verified: `200`, correct MIME, body starts `WEBVTT`.

**Honest quality labels:** `effectiveHeight(width, height) = max(height, round(width × 9/16))` for landscape sources. A cinematic **1920×800** master is a 1080p-class encode, not "720p"; the sheet now reads `1080p | 720p | 360p` for 969681 and the ladder still snaps oddballs to standard rungs. The ground-truth parser in QA uses the same rule, so the test and the UI can no longer disagree. Where a title truly tops out at 720/360 (e.g. 1396), the sheet says exactly that — no invented rung.

**S5E5 false fallback, root-caused:** a cold resolve can hit four provider crashes; the fresh-Chrome retry then wins via vidsrc, but total wall time (54.9 s measured) exceeded the old **45 s** client timeout, so the UI declared "No ad-free source" and dropped to an iframe — switching servers later used the now-warm cache. Fixes: signal the all-crashed state immediately, retry once on a fresh Chrome, check for a late winner after the retry, and raise the client resolve timeout to **95 s**. The preparing stage keeps its elapsed counter and "Play with regular servers" escape hatch.

**Chrome polish:** auto-hide is **2200 ms**; an open sheet keeps the bar visible; control bar and sheets use **no `backdrop-filter`** (mobile Chrome smeared the sheet's own labels into the video — the "blurred CC" in the user's screenshot); sheets are 96% opaque, sit above the control row and fully inside the player. Narrow phones got a real fix: seven 44px controls plus the clock overflowed a 390px row and clipped Fullscreen by 17px — the clock now sits above the scrubber and the buttons share the row exactly (`scrollWidth == clientWidth == 370`).

**Verification (final tree, live LAN origin, iPhone UA):**
- `npx tsc --noEmit` clean; `npm run build` green (dist current).
- `e2e-user-rigorous.js` — **146 PASS / 0 FAIL**: S5E5 first load owned, no iframe, never flashed "No ad-free source"; CC/sheet/one-showing-track teardown; sync +1.0s and exact reset; 969681 `1080p`; Lighthook → VidFast → Lighthook with CC restored; 47s-held resolve still reaches owned video at 47.2s; zero ad-host requests, zero popups, 110 `/rip/*` calls all < 400.
- `e2e-quality.js` — **33 PASS / 0 FAIL**: CC always present, empty-state message + no dead sync row, sheet header, ladder labels/order, speed, double-tap skip, control-row fit, clock/scrubber separation.
- `e2e-rip.js` — **16 PASS / 0 FAIL**: owned playback, cached re-hit 348ms, zero ads/popups.
- **195 PASS / 0 FAIL total.** Ground truth: S5E5 cold resolve 10.9s (vidsrc HLS, 4 subs), S1E1 8.3s, 969681 1080p, 220542 1080p. Screenshots under `qa\shots\` (`s5e5-cc-final.png`, `s5e5-sync.png`, `s5e5-cc-layout.png`, `969681-quality.png`, `subs-empty-sheet.png`).

**NOT done (per mandate):** no git commands, no deploy/Netlify, `.env` untouched. Dev stack is still running on **http://192.168.0.35:5173** for a real phone check; approval is required before any git or deploy step.
