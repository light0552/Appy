# LIGHTH00K — RECODE design contract

Read this before touching a page. The shared foundation is already built; your job is
to make your assigned pages belong to it.

## The room

Warm midnight cinema. Not neon, not cyber, not "streaming SaaS". Think a private
screening room: roasted blacks, cream print, brass and marigold light, a ginger cat
as the house seal.

- Base `#0a0806`; panels `#110e0a`; cards `#17130e`; active `#221b13`.
- Cream text `#f6efe3`; muted `#b3a58f`; dust `#7d7162`.
- Accent marigold `#e9a05a`; highlight `#ffc78e`; ink on amber `#1c1106`.
- Borders are warm hairlines: `var(--border)`, `var(--border-strong)`.
- All of the above already exist as tokens in `src/styles.css`. Use the tokens,
  never new hex values except inside artwork/placeholder gradients.

## Type

- Display: `var(--font-display)` = Bricolage Grotesque. Use for page titles, shelf
  titles, hero titles, big numbers, section headings. Weight 600, tracking -0.02em
  to -0.04em, line-height 0.95–1.05.
- UI/body: `var(--font)` = Inter.
- Eyebrows: 10–11px, weight 650–750, uppercase, tracking `var(--tracking-caps)`.
- Avoid weights 800+ on large type; Bricolage at 600 is the voice.

## Shape and depth

- Cards 16–20px radius; panels 24–28px; pills 999px.
- One-pixel warm borders + soft warm-black shadows; no blue/cyan glows, no
  glassmorphism everywhere. A single translucent panel per page is enough.
- Audio/video surfaces may stay pure black.
- Use `color-mix(in srgb, var(--accent) N%, transparent)` for amber tints.

## Composition

- Page headers are editorial: eyebrow, large display title, one-line lede, and an
  optional right-side meta/action. Left-align on desktop; keep mobile tight.
- Section headings get a thin amber rule or a short beam, not a thick bar.
- Empty/error states are quiet and warm: a small glyph, a display line, one action.
- Cards should feel like prints/tickets: rounded, bordered, with the title in
  Inter 600 and meta in muted caps.
- Buttons: primary is the amber gradient from `styles.css`; secondary is a warm
  outline; destructive is the danger token. Do not invent new button colors.
- Copy voice: dry, warm, household. No exclamation marks, no marketing shouting.

## Hard constraints

- Do not edit `src/styles.css`, `src/App.tsx`, `src/components/TabBar.tsx`,
  `src/pages/Home.tsx`, `src/pages/Profiles.tsx`, `src/styles/home.css`,
  `src/styles/profiles.css`, `src/styles/profiles-recode.css`, `index.html`,
  `package.json`, `vite.config.ts`, or anything under `netlify/`.
- Do not push git, run Netlify commands, delete data, or change API contracts.
- Keep every existing class name and aria-label used by the QA scripts
  (`scripts/qa/*.mjs`). Add new classes; do not rename old ones.
- Keep all logic, state, routing, auth, provider and fullscreen behavior intact.
- Page CSS loads before `styles.css`, so when overriding a shared primitive scope
  the rule through the page root (e.g. `.search-page .field`). New page-only
  classes are safe.
- Prefer editing existing page CSS in place. If a page needs a lot of new skin,
  add `src/styles/<page>-recode.css` and import it after the existing page CSS.
- Must pass `npx tsc --noEmit`. Must not produce console errors or 404s.

## What "done" looks like

The page reads as the same product as the new profiles lobby: warm, editorial,
confident, with one clear action and no leftover azure/steel styling. Test at
1440x950 and 390x844, keyboard focus visible, reduced-motion respected.
