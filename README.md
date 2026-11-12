# LIGHTH00K — Private Cinema

<img src="public/brand/lighthook-cat.jpg" alt="The LIGHTH00K cat seal" width="120" align="right" />

The family's own screening room — an installable PWA with a warm midnight palette,
Bricolage display type, and the ginger cat as the house seal. TMDB for the catalogue,
a cross-origin iframe for playback (no `sandbox` — it breaks every provider, see below),
and Netlify Blobs for cross-device profile sync.

- **No ads ship from this repo.** Playback runs in a cross-origin iframe with a suppressed
  referrer. There is deliberately **no `sandbox` attribute** — all four providers detect it
  and refuse to play (BUILD.md §8), so a sandboxed player is a player that never plays.
  The 6-second watchdog with a "next server" switch is what covers us instead.
- **Zero video bytes through Netlify.** The embed points straight at the playback provider.
- **Every screen is password-locked.** Up to **50 screens** in the household. Each one has
  its own password; three wrong attempts lock that screen until the admin unblocks it.
- **One admin.** The control room (`/admin`, admin password configured with the server-only
  `ADMIN_PASSWORD` environment variable) is the only place to add a screen, remove one, set a
  password, or unblock a locked screen.

The full build specification is in [`BUILD.md`](./BUILD.md). Read it first.

## Run it

```bash
npm install
npm run dev:live        # full stack: Vite + Netlify Functions + Blobs on :8888
npm run dev             # UI only on :5173 (local-only; /api/profiles will 404)
npm run build           # tsc --noEmit && vite build -> dist/
```

`npm run dev:live` is the preview the household should use: it starts
`netlify dev`, which detects Vite, boots the app on `http://localhost:8888`, and
serves `netlify/functions/{auth,profiles}.mts` with the local Blobs sandbox. It
works offline after the first `npx netlify` run; no login or linked site is
needed for local data.

`npm run dev` serves the whole app against local storage only; the sync layer
detects the missing `/api/profiles` and degrades to "Offline — changes saved on
this device" without losing a click. On a phone on the same Wi-Fi, use
`http://<lan-ip>:8888` (or `:5173` with the Vite proxy).

## Deploy to Netlify

1. Push the repo to GitHub / GitLab / Bitbucket, then **Add new site → Import an existing
   project** and pick the repository.
2. Build settings (already encoded in [`netlify.toml`](./netlify.toml)):
   - **Base directory:** repository root (leave blank)
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
   - **Functions directory:** `netlify/functions`
   - **Node:** 20 (set through `NODE_VERSION` in `netlify.toml`)
3. **Site configuration → Environment variables** — set the following for Production (and
   Deploy Previews if used):
   - `VITE_TMDB_TOKEN` (preferred) or `VITE_TMDB_API_KEY` — one of the two is required
   - `VITE_FAMILY_KEY`
   - `FAMILY_KEY` (must equal `VITE_FAMILY_KEY`)
4. Deploy. Netlify runs the build, publishes `dist/`, and deploys
   `netlify/functions/profiles.mts` as a Functions v2 endpoint.

**Routing.** The function declares `config.path = "/api/profiles"`, so Netlify routes the
client's `fetch("/api/profiles")` straight to it (functions are matched before redirects).
`netlify.toml` also carries an ordered `/api/* → /.netlify/functions/:splat` rewrite above
the SPA catch-all, so no API request can ever fall through to `index.html` and return HTML
where JSON is expected. No Blobs setup is needed: the function creates the `lighthook`
store on first use.

**Cross-device sync only works once the function and its environment variables are live.**
A static-only host, or `npm run dev` without `netlify dev`, keeps working but stays
local-only. After changing any `VITE_*` value on Netlify you must redeploy, because those
values are baked into the bundle at build time.

## Environment

| Key | Where | Notes |
|---|---|---|
| `VITE_TMDB_TOKEN` | build-time, public by design | TMDB v4 read token |
| `VITE_TMDB_API_KEY` | build-time, fallback | v3 key |
| `FAMILY_KEY` | Netlify function environment, secret | server-side gate |
| `VITE_FAMILY_KEY` | build-time | must match `FAMILY_KEY` |

Locally these live in `.env` (gitignored); `.env.example` is the template. `.env` is never
uploaded — on Netlify the same keys must be set under **Site configuration → Environment
variables**.

## Design system

The RECODE skin lives in `src/styles.css` as tokens and shared primitives:

- **Room:** `--bg #0a0806`, cocoa panels, cream `--text #f6efe3`, parchment
  `--muted #b3a58f`, marigold `--accent #e9a05a`.
- **Type:** Bricolage Grotesque (`--font-display`) for titles, Inter (`--font`) for
  UI. Both are self-hosted in `public/fonts` so the installed app keeps its voice
  offline.
- **Shape:** 16px cards, 26px panels, warm hairlines, soft warm-black shadows.
- **Brand:** the supplied ginger-cat photograph is the seal everywhere — app icons,
  boot splash, desktop nav, profiles lobby and the admin/notice cards
  (`public/brand/lighthook-cat.jpg`; icons regenerate with
  `node scripts/make-icons.mjs`).
- **Profiles:** the house lobby — seal and promise on the left, screens as warm
  tickets on the right, full-width on desktop and a tight editorial stack on phones.
- **Screen looks:** the admin can give each screen the ginger cat, the black cat, or
  coloured initials with any custom colour. A per-screen switch removes the colour
  ring and glow for a completely clean photo. Existing screens keep their initials
  until changed.
- **House notice:** three ways to watch clean — Brave, uBlock Origin Lite, or the
  private LIGHTH00K Android app (request access from the admin).
- **Page CSS:** each page imports its own stylesheet; the new `*-recode.css` files
  hold page-scoped overrides where the original skin needed replacing.

## How it is put together

```
src/
├── main.tsx            router + session provider
├── App.tsx             route table, profile guard, tab bar, offline banner
├── styles.css          design tokens + shared primitives
├── types.ts            the data model
├── lib/
│   ├── tmdb.ts         v4 bearer client + image helpers
│   ├── providers.ts    the provider registry (one-line domain swaps)
│   ├── auth.ts         screen passwords, 3-strike lockout, admin session
│   ├── profiles.ts     local profile CRUD + the 50-screen cap
│   ├── store.ts        IndexedDB working copy, merge + tombstone helpers
│   ├── sync.ts         pull/push, debounce, offline detection
│   └── session.tsx     the spine every page consumes
├── components/         PosterCard, Row, SearchBar, Player, ServerChips, TabBar, NoticeBoard, Sheet
├── pages/              Profiles, Admin, Home, Search, Title, Watch, Library, Browse
└── styles/             per-page CSS
netlify/functions/profiles.mts   GET/POST/DELETE /api/profiles
public/manifest.webmanifest      installable, standalone
```

## Limits worth knowing

Playback position cannot be read back from a cross-origin player, so "Continue" means
*which episode and when*, never *at 00:42:10*. A cross-origin iframe that fails to load
looks identical to one that worked, so the player offers a server switch after 6 seconds
instead of a spinner that can hang forever.

Screen passcodes are stored in **Netlify Blobs** (`/api/auth`), as scrypt hashes. The
networked app verifies them server-side, so clearing cache/cookies only ends the local
session — it cannot reset a passcode or release a 3-strike lock. The admin console can
read them because the server also keeps an AES-GCM copy encrypted with a key derived
from the admin password; the public status endpoint never returns passcodes.
