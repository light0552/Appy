# Lighthook

The family's own streaming shelf — an iOS-first, installable PWA. TMDB for the catalogue,
a cross-origin iframe for playback (no `sandbox` — it breaks every provider, see below),
and Netlify Blobs for cross-device profile sync.

- **No ads ship from this repo.** Playback runs in a cross-origin iframe with a suppressed
  referrer. There is deliberately **no `sandbox` attribute** — all four providers detect it
  and refuse to play (BUILD.md §8), so a sandboxed player is a player that never plays.
  The 6-second watchdog with a "next server" switch is what covers us instead.
- **Zero video bytes through Netlify.** The embed points straight at the playback provider.
- **Profiles** for Sam and Mellu, seeded, with a hard cap of 10.

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

## Environment

| Key | Where | Notes |
|---|---|---|
| `VITE_TMDB_TOKEN` | build-time, public by design | TMDB v4 read token |
| `VITE_TMDB_API_KEY` | build-time, fallback | v3 key |
| `FAMILY_KEY` | Netlify functions, secret | server-side gate |
| `VITE_FAMILY_KEY` | build-time | must match `FAMILY_KEY` |

Real values live in `.env` (gitignored); `.env.example` is the template.

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
│   ├── profiles.ts     local profile CRUD + the 10-profile cap
│   ├── store.ts        IndexedDB working copy, merge + tombstone helpers
│   ├── sync.ts         pull/push, debounce, offline detection
│   └── session.tsx     the spine every page consumes
├── components/         PosterCard, Row, SearchBar, Player, ServerChips, TabBar
├── pages/              Profiles, Home, Search, Title, Watch, Library
└── styles/             per-page CSS
netlify/functions/profiles.mts   GET/POST/DELETE /api/profiles
public/manifest.webmanifest      installable, standalone
```

## Limits worth knowing

Playback position cannot be read back from a cross-origin player, so "Continue" means
*which episode and when*, never *at 00:42:10*. A cross-origin iframe that fails to load
looks identical to one that worked, so the player offers a server switch after 6 seconds
instead of a spinner that can hang forever.
