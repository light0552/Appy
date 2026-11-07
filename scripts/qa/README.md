# Lighthook QA audit

`audit.mjs` drives the real app in headless Chrome (via `puppeteer-core`) and
checks the household rules end to end. It talks to the dev server the same way
a family member would — clicks, typing, reading the DOM — so a PASS means the
feature actually works in the browser, not just that a unit passed.

## Running it

Dev server must be up first (Chrome + Node are preinstalled on this machine):

```
npm run dev            # from E:\OPENCODE\Appy
node scripts/qa/audit.mjs
```

Options:

| Flag               | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `--headed`         | Show the browser window (debugging)                  |
| `--keep-profile`   | Keep the temp Chrome profile after the run           |
| `--base=<url>`     | App origin (default `http://localhost:5173`)         |
| `--chrome=<path>`  | Chrome executable (default `Program Files` install)  |
| `--help`           | Flag help                                            |

Exit codes:

- `0` — every check passed
- `1` — at least one FAIL
- `2` — no FAIL but at least one SKIP (environment limit, e.g. TMDB down)
- `64` — bad arguments / Chrome binary not found

The run is repeatable: it launches Chrome with a **fresh temporary profile**
each time and clears the origin's storage via the DevTools protocol before the
first assertion, so no dismissal stamp, unlock session, lockout counter, or
QA-created screen survives between runs. The only state it touches on the dev
server itself is whatever the app persists through `/api` — nothing is seeded.

## What it checks

Split into eight phases; a failed check never aborts the rest of the suite
(except inside its own phase for sequencing-critical steps):

1. **House notice** — appears on first open, mentions "ad blocker",
   "Brave Browser" and "uBlock Origin Lite"; "Got it" dismisses it; the
   localStorage key `lighthook.notice.dismissedOn` holds today's `YYYY-MM-DD`;
   it stays hidden after reload and returns when the stamp is cleared.
2. **Route hiding** — no notice on `/admin` (and later on `/watch`).
3. **Unlock** — Sam (picker tile `Unlock Sam with a password`) unlocks with
   `1234` and lands on the home tab bar.
4. **Three-strike lockout** — two wrong passwords report "2 attempts left" /
   "1 attempt left", the third blocks with "Contact admin" copy, the picker
   shows a blocked tile, and the blocked sheet offers no password field so the
   correct password cannot be used while blocked.
5. **Admin console** — wrong password rejected, `light0552` opens the
   dashboard, screens + passwords are listed (Sam/Mellu → `1234`), "Copy all"
   exists, blocked screens show a Blocked badge and can be unblocked (and then
   accept their password again), a new screen "QA Test" can be added with a
   custom password which then unlocks that screen, and removing it takes it
   off both the registry and the picker.
6. **Watch route** — messaging-only paths: unlock Sam, notice visible on `/`,
   hidden on `/watch`.
7. **Movie title page** (`/title/movie/550`) — has a Play control linking to
   the movie's watch page, has **no** "Continue" button, and contains neither
   "Opens the title you picked" nor "position can't be read back". Skipped if
   TMDB data fails to load.
8. **TV watch page** (`/watch/tv/1399?s=1&e=1`) — shows the `S1 · E1` badge,
   the `.watch-episode-name` element with a real episode name, a "Next
   episode" control, a "Reload stream" control, and — for the first episode —
   **no** "Previous episode" control.

## Reading the output

One line per check:

```
PASS  House notice is visible on first open — notice present
FAIL  Third wrong password blocks with "Contact admin" copy — <reason>
SKIP  Movie title page has a Play control — title page unavailable (TMDB)
```

- The bit after the `—` is a short proof the check really observed something
  (a copy string, a stamp value, a link href), or the failure reason.
- A **FAIL** drops a screenshot into
  `%TEMP%\opencode\lighthook-qa\NN-fail-<check>.png` (path printed in the
  summary) so you can see what the page actually looked like.
- A **SKIP** means the check could not be executed in this environment —
  typically TMDB being unreachable. A skip is never counted as a pass; the
  process still exits non-zero (2) so CI-style automation notices.
- **Runtime diagnostics** at the end collect page errors and any `5xx`
  responses from the dev server (deduplicated) — app problems that don't fail
  a specific check still show up here.
- The final `Summary:` line echoes the counts. Rule of thumb: fix FAILs, judge
  SKIPs, and keep an eye on diagnostics.

## Extending it

- **Add a check** inside the relevant phase (or a new phase function, added to
  the `phases` list in `main()`): wrap it in `await check("name", async () => { … })`.
  Throw `new Error("reason")` (or `assert(cond, "reason")`) to fail, and
  `new SkipError("why")` when the environment can't run it. Return a short
  proof string for the PASS detail.
- **Helpers worth reusing**: `goto(path, waitForSelector)` for navigation,
  `waitForBodyText` / `bodyText` for copy assertions, `clickText` for
  text-labelled controls, `fill` (Ctrl+A-safe) for inputs, and
  `waitForAdminRow` for admin registry state.
- **Copy assertions**: use `norm()`-style comparisons (whitespace + smart
  apostrophes collapsed) rather than raw `includes` on JSX-adjacent text.
- **State reset**: if a new check creates data, delete what it creates at the
  end of the check (see the QA Test add/remove pair) so a re-run starts clean.
- Screenshots on failure already exist; for a flaky check, add an extra
  `shot("name.png")` at the suspicious point and compare across runs.

## Not this file's job

The audit never edits app source. When it finds an app bug, the detail line
describes the exact mismatch (file locations go in the bug report, not the
script) and the app side fixes the source — then the script should pass again
unchanged.

## Preview (production build)

`preview.mjs` is the release check: it proves the app works from the built
bundle, not just the dev server. It expects `dist/` to exist, spawns
`vite preview` itself, and tears the server down in a `finally` block. It does
not touch the dev server on port 5173.

```powershell
cd E:\OPENCODE\Appy
npm run build
node scripts/qa/preview.mjs
```

Options:

| Flag               | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `--headed`         | Show the browser window (debugging)                  |
| `--keep-profile`   | Keep the temporary Chrome profile after the run      |
| `--base=<url>`     | Preview origin (default `http://localhost:4173`)     |
| `--chrome=<path>`  | Chrome executable (default `Program Files` install)  |
| `--help`           | Flag help                                            |

Exit codes match the dev audit: `0` all checks passed, `1` at least one FAIL,
`2` no FAIL but at least one SKIP (environment limit, e.g. TMDB down), `64` bad
arguments / missing Chrome / preview failed to start.

What it verifies against `http://localhost:4173`:

1. **Build artifacts** — `dist/index.html`, `dist/sw.js`,
   `dist/manifest.webmanifest`, and hashed `dist/assets/*.js` + `*.css`
   referenced by `index.html`.
2. **Static endpoints** — `/` 200, manifest 200 + valid JSON (`name` /
   `short_name` `LIGHTH00K`, icons, `display: standalone`), `/sw.js` 200 with a
   JavaScript content type.
3. **Service worker** — `navigator.serviceWorker.ready` resolves within 15s.
4. **SPA fallback** — fresh loads of `/search`, `/library`, `/browse/trending`
   and `/admin` return 200, render `.app`, and show the correct route content.
5. **Profiles + home** — the picker renders, Sam unlocks with `1234`, `/` shows
   the hero, at least two populated shelves, `.tab-bar`, and the app-set
   `document.documentElement.dataset.theme`.
6. **Title + watch** — `/title/movie/550` renders `.title-page` with a Play
   control; `/watch/tv/1399?s=1&e=1` renders `.watch-bar`, the `S1 · E1` badge,
   `.watch-episode-name`, Next episode, Reload stream, and no Previous episode.
7. **Admin** — `/admin` shows the login gate; `light0552` opens the dashboard
   and registry.
8. **Diagnostics** — no uncaught `pageerror` events and no failed same-origin
   responses. `/api` responses are ignored on purpose: `vite preview` has no
   Netlify Functions, so the app correctly degrades to local-only mode and may
   show the "Offline — changes saved on this device." banner.

Screenshots: 16 PNGs at 1440x950 and 390x844 (profiles, home, title, watch,
admin, search, library, browse) under
`%TEMP%\opencode\lighthook-preview\`. They are disposable artifacts and are
never committed.

A SKIP is an environment limitation, never a pass. A FAIL names the selector,
status, or copy that did not appear so the app source can be fixed; the script
should pass again unchanged.

---

## Server-backed auth regression (`auth.mjs`)

`auth.mjs` proves the security fix the household reported: **clearing cache and
cookies must not reset screen passcodes or unlock a blocked screen.**

```bash
node scripts/qa/auth.mjs
# or: $env:QA_BASE="http://localhost:8888"; node scripts/qa/auth.mjs
```

It expects the Netlify Dev server (functions + Blobs sandbox), default
`http://localhost:8888`, because auth lives in `/api/auth`. Plain
`npm run dev` has no functions and is not a valid target for this test.

Covered, in order:

1. seeded `1234` unlocks Sam;
2. the admin sets Mellu to a new passcode through the UI;
3. **a full CDP storage wipe** (cookies, localStorage, IndexedDB, sessionStorage)
   then the new passcode still unlocks;
4. the old `1234` is rejected after the wipe (attempts-left copy appears);
5. three wrong attempts block the screen, and the block **survives another wipe**
   (the correct passcode is still refused);
6. the admin unblocks and restores `1234`;
7. the restored passcode unlocks after another wipe;
8. the admin can sign in again after a wipe.

At the end the script restores Mellu to `1234` and clears any block via the
admin API. It prints `N/N auth checks passed.` and exits non-zero on failure.

The admin passcode and every screen passcode are stored server-side as scrypt
hashes; the admin console reads them from an AES-GCM copy encrypted with a key
derived from the admin password. Plain passcodes never appear in the client
bundle or in the public status endpoint.
