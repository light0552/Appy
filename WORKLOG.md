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
