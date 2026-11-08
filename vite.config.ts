import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// @types/node is not installed for this project, so the two globals the config
// needs from the Node runtime are declared locally instead of pulling a dep.
declare const process: { env: Record<string, string | undefined> };

const PROVIDER_HOSTS = String.raw`vidlink\.pro|vidsrc\.to|vidfast\.vc|player\.videasy\.to`;

/**
 * Identity of the bundle produced by this build. Netlify exposes the deployed
 * commit as COMMIT_REF, which makes the value stable across repeated builds of
 * the same commit; local builds fall back to VITE_BUILD_ID or a timestamp.
 */
const buildId = (
  process.env.COMMIT_REF ||
  process.env.VITE_BUILD_ID ||
  Date.now().toString(36)
).slice(0, 12);

/**
 * Writes /version.json next to sw.js in the build output. A running client
 * polls it to learn which bundle is deployed right now. It is emitted here
 * rather than kept in public/ so it can never be forgotten after a deploy and
 * never drifts from the bundle it describes.
 */
function versionFilePlugin(): Plugin {
  return {
    name: "lighthook-version-file",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ version: buildId }),
      });
    },
  };
}

export default defineConfig({
  // Substituted into the client at build time; see src/components/UpdateWatcher.tsx.
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    versionFilePlugin(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      // The manifest is a static file in public/ so it can be edited without a rebuild.
      manifest: false,
      workbox: {
        // Covers the app bundle plus everything copied from public/ (manifest,
        // favicon, the full icon set), so the installed shell boots offline.
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest,ico,woff2}"],
        navigateFallback: "/index.html",
        // Never answer an API call or a Netlify function with the SPA shell.
        // (Also covers the bare "/api" and "/.netlify" paths, no trailing slash.)
        navigateFallbackDenylist: [/^\/api(?:[/?]|$)/, /^\/\.netlify(?:[/?]|$)/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          // Hard guard: /api/** (and Netlify functions) are never cached, never
          // replayed from cache, and always go straight to the network. Workbox
          // RegExpRoutes test the absolute href, hence the origin prefix. The
          // routes below only match absolute third-party URLs, so this is a
          // belt-and-braces rule, not the only line of defence.
          {
            urlPattern: /^https?:\/\/[^/]+\/(?:api|\.netlify)(?:[/?]|$)/i,
            handler: "NetworkOnly",
          },
          {
            urlPattern: /^https:\/\/image\.tmdb\.org\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "tmdb-images",
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/api\.themoviedb\.org\/.*/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "tmdb-api",
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 6 },
              cacheableResponse: { statuses: [200] },
            },
          },
          // Provider player chrome: styles and images only. Deliberately
          // extension-anchored so a frame DOCUMENT (no file extension) can never
          // match, and stream manifests/segments (.m3u8, .ts, .m4s, .mp4, ...)
          // are never requested from cache.
          {
            urlPattern: new RegExp(
              String.raw`^https:\/\/(?:${PROVIDER_HOSTS})\/.*\.(?:css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)(?:[?#].*)?$`,
              "i",
            ),
            handler: "CacheFirst",
            options: {
              cacheName: "provider-assets",
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Provider player bundles: revalidate, so a rotated build is picked up
          // on the next load instead of pinning a stale player.
          {
            urlPattern: new RegExp(
              String.raw`^https:\/\/(?:${PROVIDER_HOSTS})\/.*\.(?:js|mjs)(?:[?#].*)?$`,
              "i",
            ),
            handler: "NetworkFirst",
            options: {
              cacheName: "provider-scripts",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Everything else on a provider origin — the embed document, its XHR,
          // the stream manifest and the segments themselves — stays network-only.
          // Ordered last so the two rules above win the assets they own, and no
          // playable/page request is ever stored or replayed from cache.
          {
            urlPattern: new RegExp(
              String.raw`^https:\/\/(?:${PROVIDER_HOSTS})\/`,
              "i",
            ),
            handler: "NetworkOnly",
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://localhost:8888",
        changeOrigin: true,
        // `npm run dev` has no Netlify Functions process, so every sync poll
        // fails with ECONNREFUSED. The app already degrades to local-only; the
        // proxy noise is pure log spam, so it is swallowed here.
        configure: (proxy) => {
          proxy.on("error", () => {});
        },
      },
    },
  },
  build: {
    target: "es2020",
    sourcemap: false,
  },
});
