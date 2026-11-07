# LIGHTH00K

The family's own streaming shelf — an iOS-first, installable PWA. TMDB for the catalogue,
a cross-origin iframe for playback (no `sandbox` — it breaks every provider, see below),
and Netlify Blobs for cross-device profile sync.

- **No ads ship from this repo.** Playback runs in a cross-origin iframe with a suppressed
  referrer. There is deliberately **no `sandbox` attribute** — all four providers detect it
  and refuse to play (BUILD.md §8), so a sandboxed player is a player that never plays.
  The 6-second watchdog with a "next server" switch is what covers us instead.
- **Zero video bytes through Netlify.** The embed points straight at the playback provider.
- **Every screen is password-locked.** Up to **50 screens** in the household. Each one has
  its own password; three wrong attempts lock that screen until the admin unblocks it.
- **One admin.** The control room (`/admin`, admin password `light0552` by default) is the
  only place to add a screen, remove one, set a password, or unblock a locked screen.

The full build specification is in [`BUILD.md`](./BUILD.md). Read it first.

## Run it

```bash
npm install
npm run dev              # http://localhost:5173  (local-only; /api/profiles will 404)
npx netlify dev          # with functions + Blobs emulation, needs `netlify login` + a linked site
npm run build            # tsc --noEmit && vite build -> dist/
npx netlify deploy --prod --dir=dist
```

`npm run dev` serves the whole app against local storage only; the sync layer detects the
missing `/api/profiles` and degrades to "Offline — changes saved on this device" without
losing a click. Netlify deploy is the only path where sync across two devices is real.

## Deploy to Netlify

1. Push the repo to GitHub / GitLab / Bitbucket, then **Add new site → Import an existing
   project** and pick the repository.
2. Build settings (already encoded in [`netlify.toml`](./netlify.toml)):
   - **Base directory:** `Appy` (only if this folder is not the repository root)
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

Screen passwords are stored in the browser's own IndexedDB on the household's devices —
this is a family lock, not an identity system. Anyone holding an unlocked device can read
them from devtools.
