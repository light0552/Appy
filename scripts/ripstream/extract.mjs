/**
 * Local stream extractor — the browser-farm leg of the ripstream sidecar.
 *
 * What it does: launches the machine's own Chrome headless, loads a provider
 * embed page for a title, watches traffic at the browser-process level (every
 * frame and every cross-origin request is visible here — the SOP wall that
 * defeats the in-app player does not exist for an automation harness), waits
 * for the provider's own player to fetch its media manifest, and returns the
 * winning manifest URL together with the exact request headers the provider's
 * player used (UA, Referer, Origin, Cookie, Accept) so the ripstream server can
 * replay them against the stream hosts.
 *
 * Provider shapes mirror src/lib/providers.ts (D9 order: works-first). The
 * extractor tries providers in order and stops at the first working stream.
 *
 * Local-only tooling; never shipped, never imported by the app bundle.
 * Run `node scripts/ripstream/server.mjs`.
 */

import fs from "node:fs/promises";
import puppeteer from "puppeteer-core";

/* ------------------------------------------------------------------ */
/* Chrome discovery — the box already has Chrome (WORKLOG QA harness)  */
/* ------------------------------------------------------------------ */

const CHROME_CANDIDATES = [
  process.env.RIP_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    : null,
].filter(Boolean);

export async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Provider registry — same order + hosts as src/lib/providers.ts (D9) */
/* ------------------------------------------------------------------ */

function seasonEpisode(ref) {
  return `${ref.season ?? 1}/${ref.episode ?? 1}`;
}

export function providerEmbeds(ref) {
  const list = [
    {
      id: "vidlink",
      name: "VidLink",
      page:
        ref.type === "movie"
          ? `https://vidlink.pro/movie/${ref.tmdbId}`
          : `https://vidlink.pro/tv/${ref.tmdbId}/${seasonEpisode(ref)}`,
    },
    {
      id: "vidsrc",
      name: "Vidsrc",
      needs: "imdb",
      page:
        ref.type === "movie"
          ? `https://vidsrc.to/embed/movie/${ref.imdbId}`
          : `https://vidsrc.to/embed/tv/${ref.imdbId}/${seasonEpisode(ref)}`,
    },
    {
      id: "vidfast",
      name: "VidFast",
      needs: "imdb",
      page:
        ref.type === "movie"
          ? `https://vidfast.vc/movie/${ref.imdbId}`
          : `https://vidfast.vc/tv/${ref.imdbId}/${seasonEpisode(ref)}`,
    },
    {
      id: "videasy",
      name: "Videasy",
      page:
        ref.type === "movie"
          ? `https://player.videasy.to/movie/${ref.tmdbId}`
          : `https://player.videasy.to/tv/${ref.tmdbId}/${seasonEpisode(ref)}`,
    },
  ];
  return list.filter((provider) => provider.needs !== "imdb" || Boolean(ref.imdbId));
}

/* ------------------------------------------------------------------ */
/* Candidate classification                                            */
/* ------------------------------------------------------------------ */

const MEDIA_URL = /\.(m3u8|mp4)(?:[?#]|$)/i;
const AD_HOST =
  /(^|\.)(doubleclick|adnxs|adservice|dtscout|crwdcntrl|popads|popcash|adcash|exoclick|onclickads|adfox|taboola|outbrain|scorecardresearch|quantserve|histats)\./i;
const DRM_RE = /widevine|clearkey|playready|fairplay|com\.adobe\.fps/i;

/** Request headers worth replaying against the stream hosts. */
const REPLAY_HEADERS = ["user-agent", "referer", "origin", "cookie", "accept", "accept-language"];

function captureHeaders(request) {
  const raw = request.headers() ?? {};
  const out = {};
  for (const key of REPLAY_HEADERS) {
    const value = raw[key];
    if (value) out[key] = value;
  }
  return out;
}

/** Disciplined in-page kick — providers' own players usually autoplay; Vidsrc wants a tap. */
function inPageKick() {
  return () => {
    document.querySelectorAll("video").forEach((video) => {
      try {
        const play = video.play?.();
        if (play && typeof play.catch === "function") play.catch(() => {});
      } catch {
        /* gesture-gated; the centre mouse tap covers it */
      }
      try {
        video.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } catch {
        /* ignore */
      }
    });

    const selectors = ['[class*="play" i]', '[aria-label*="play" i]', '[title*="play" i]'];
    for (const selector of selectors) {
      try {
        document.querySelectorAll(selector).forEach((el) => {
          try {
            const rect = el.getBoundingClientRect?.();
            if (!rect || rect.width < 12 || rect.height < 12) return;
            if (rect.top > window.innerHeight) return;
            el.click?.();
          } catch {
            /* ignore individual click failure */
          }
        });
      } catch {
        /* invalid selector on a provider shell — next selector */
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

const IDLE_EXIT_MS = 180_000;

class Extractor {
  #browser = null;
  #launching = null;
  #idleTimer = null;
  #queue = Promise.resolve();

  /** Serialises browser setup so concurrent resolves share one launch. */
  #chain(work) {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => {});
    return run;
  }

  #keepAlive() {
    clearTimeout(this.#idleTimer);
  }

  #scheduleIdleExit() {
    clearTimeout(this.#idleTimer);
    // Unref'd so the server process is free to exit without this timer.
    this.#idleTimer = setTimeout(() => {
      const browser = this.#browser;
      this.#browser = null;
      browser?.close().catch(() => {});
    }, IDLE_EXIT_MS);
    this.#idleTimer.unref?.();
  }

  #getBrowser() {
    this.#keepAlive();
    if (this.#browser?.connected) return Promise.resolve(this.#browser);

    this.#launching ??= (async () => {
      const chrome = await findChrome();
      if (!chrome) {
        throw new Error("Chrome not found — install Chrome or set RIP_CHROME to chrome.exe.");
      }
      return puppeteer.launch({
        executablePath: chrome,
        headless: true,
        args: [
          "--no-first-run",
          "--disable-blink-features=AutomationControlled",
          "--autoplay-policy=no-user-gesture-required",
          "--mute-audio",
          "--lang=en-US",
          "--disable-features=TranslateUI",
        ],
      });
    })()
      .then((browser) => {
        this.#browser = browser;
        return browser;
      })
      .catch((err) => {
        this.#launching = null;
        throw err;
      });

    return this.#launching;
  }

  /**
   * Rip one title. Returns
   *   { ok: true,  provider, providerName, kind, url, headers, tried }
   * or
   *   { ok: false, tried }
   * where `ref` = { type, tmdbId, imdbId?, season?, episode? }.
   */
  async rip(ref, log = () => {}) {
    return this.#chain(async () => {
      const browser = await this.#getBrowser();
      const tried = [];
      const embeds = providerEmbeds(ref);

      for (const provider of embeds) {
        const started = Date.now();
        let result = null;
        try {
          result = await this.#ripOne(browser, provider, ref, log);
        } catch (err) {
          log(`[${provider.id}] crashed: ${err?.message ?? err}`);
        }
        const ms = Date.now() - started;

        if (result) {
          tried.push({ provider: provider.id, ms, ok: true, kind: result.kind });
          log(`[${provider.id}] ripped ${result.kind} in ${ms}ms`);
          this.#scheduleIdleExit();
          return {
            ok: true,
            provider: provider.id,
            providerName: provider.name,
            kind: result.kind,
            url: result.url,
            headers: result.headers,
            tried,
          };
        }
        tried.push({ provider: provider.id, ms, ok: false });
        log(`[${provider.id}] no stream in ${ms}ms`);
      }

      this.#scheduleIdleExit();
      return { ok: false, tried };
    });
  }

  async #ripOne(browser, provider, ref, log) {
    const context = await browser.createBrowserContext();

    // Popunder isolation: any tab a provider sneaks open dies mid-open.
    context.on("page", (page) => {
      page.close().catch(() => {});
    });

    try {
      const page = await context.newPage();
      try {
        await page.setUserAgent(
          process.env.RIP_UA ??
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        );
        await page.setViewport({ width: 1280, height: 760 });
        return await this.#watch(page, provider, ref, log);
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  /**
   * Load the embed page, watch every frame's media requests, kick the player
   * until a manifest shows up. Returns the winning candidate:
   * `{ kind: "hls"|"mp4", url, headers }` or null.
   *
   * Preference: master playlist > variant playlist > mp4. A master means
   * hls.js gets quality levels and correct audio muxing; a lone variant
   * usually still plays.
   */
  async #watch(page, provider, ref, log) {
    const seen = { master: null, variant: null, mp4: null };
    const sawDrm = { value: false };
    const headersToUse = new Map(); // candidate url -> replay headers

    const evaluate = (candidate) => {
      if (DRM_RE.test(candidate.url)) {
        sawDrm.value = true;
        log(`  [${provider.id}] DRM encountered — cannot be shipped to our player`);
        return;
      }
      if (AD_HOST.test(new URL(candidate.url).hostname)) return;
      headersToUse.set(candidate.url, candidate.headers);
      if (candidate.kind === "mp4") {
        seen.mp4 ??= candidate;
      } else if (candidate.master) {
        seen.master ??= candidate;
      } else {
        if (!seen.variant && seen.master) seen.variant = candidate; // post-master variant (rare)
        if (!seen.master && !seen.variant) seen.variant = candidate;
      }
    };

    const onResponse = async (response) => {
      try {
        const url = response.url();
        const match = MEDIA_URL.exec(url);
        if (!match) return;
        const kind = match[1].toLowerCase();
        const request = response.request();
        const candidate = { kind: kind === "mp4" ? "mp4" : "hls", url, headers: captureHeaders(request), master: false };

        if (candidate.kind === "mp4") {
          const type = String(response.headers()["content-type"] ?? "");
          if (type.includes("video/")) evaluate(candidate);
          return;
        }

        // m3u8: sniff the text — tiny resources, safe to read. This separates
        // real playlists from stray lookalikes and classifies master vs variant.
        if (candidate.kind === "hls") {
          let text = "";
          try {
            text = await response.text();
          } catch {
            evaluate(candidate); // body unreadable; still a plausible playlist URL
            return;
          }
          if (!text.includes("#EXTM3U")) return;
          candidate.master = text.includes("#EXT-X-STREAM-INF") || text.includes("#EXT-X-I-FRAME-STREAM-INF");
          evaluate(candidate);
        }
      } catch {
        /* response already gone — next candidate */
      }
    };

    page.on("response", onResponse);

    try {
      await page.goto(provider.page, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      log(`  [${provider.id}] page load timed out (continuing — player may still fetch)`);
    }

    // Kick loop: nudge every ~2.2s, from ~4s in. Includes a centre mouse tap
    // (Vidsrc's gesture gate) and per-frame play() calls (headless autoplay is
    // already relaxed via --autoplay-policy, this covers stubborn overlays).
    const viewport = page.viewport();
    const startedAt = Date.now();
    const deadline = startedAt + Number(process.env.RIP_PROVIDER_TIMEOUT_MS ?? 34_000);
    const settleMs = Number(process.env.RIP_SETTLE_MS ?? 900);
    let kicks = 0;
    let resolve = null;

    while (Date.now() < deadline && !resolve) {
      await sleep(1400);

      const have = seen.master || seen.variant || seen.mp4;
      if (!have && kicks < 4) {
        kicks += 1;
        for (const frame of page.frames()) {
          try {
            await frame.evaluate(inPageKick());
          } catch {
            /* frame torn down or not ready */
          }
        }
        try {
          await page.mouse.click(viewport.width / 2, viewport.height * 0.55);
        } catch {
          /* page may be gone */
        }
      }

      // Wait a beat for a master to land when we only caught the variant so far.
      let settled = Math.max(settleMs, 0);
      const bestNow = () => seen.master || seen.variant || seen.mp4;
      while (Date.now() < deadline) {
        const best = bestNow();
        if (!best) break;
        if (seen.master || seen.mp4 || settled <= 0) {
          const finalBest = bestNow();
          const headers = headersToUse.get(finalBest.url) ?? {};
          resolve = { kind: finalBest.kind, url: finalBest.url, headers };
          break;
        }
        await sleep(300);
        settled -= 300;
      }
    }

    page.off("response", onResponse);

    if (!resolve && sawDrm.value) log(`  [${provider.id}] only DRM streams seen`);
    return resolve;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { Extractor };
