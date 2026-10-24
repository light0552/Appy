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

/**
 * Provider chain, tried top to bottom until one yields a stream.
 *
 * Order = user mandate 2026-10-24: "default VidFast always", so VidFast leads,
 * then VidLink, Vidsrc, Videasy. VidFast was measured returning HTTP 500 on
 * every title on 2026-10-23 and may have recovered — the extractor falls
 * through automatically when it fails, so leading with it costs one attempt.
 */
export function providerEmbeds(ref) {
  const list = [
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

const MEDIA_URL = /\.(m3u8|mp4|vtt)(?:[?#]|$)/i;
/** Ad/CDN-analytics hostnames — used to skip candidates here and to strip ad lines in the sidecar. */
export const AD_HOST =
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

/**
 * One-shot CC nudge for the provider's OWN player toolbar. JW/VideoJS-style
 * shells lazy-load their WebVTT only when the captions control is toggled
 * (or the "c" shortcut fires). #watch calls this once a master is seen so the
 * response listener can snarf the .vtt before the rip resolves (2026-10-24 —
 * subtitle files live outside the HLS master: CLOSED-CAPTIONS=NONE while the
 * player still fetches a .vtt track).
 */
function inPageCaptionKick() {
  return () => {
    const selectors = [
      '[class*="icon-cc" i]',
      '[class*="subs-caps" i]',
      '[class*="captions" i]',
      '[class*="subtitle" i]',
      '[aria-label*="captions" i]',
      '[aria-label*="subtitle" i]',
      '[title*="Captions" i]',
      '[title*="Subtitles" i]',
    ];
    for (const selector of selectors) {
      try {
        document.querySelectorAll(selector).forEach((el) => {
          try {
            const rect = el.getBoundingClientRect?.();
            // Only real toolbar buttons: clickable size, not a whole-page
            // container that would swallow the click.
            if (!rect || rect.width < 8 || rect.height < 8) return;
            if (rect.width * rect.height > 400 * 400) return;
            if (el === document.body || el === document.documentElement) return;
            el.click?.();
          } catch {
            /* individual element refused */
          }
        });
      } catch {
        /* invalid selector on this shell */
      }
    }
    // VideoJS-style "c" keyboard shortcut, fired at document level.
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", code: "KeyC", bubbles: true, cancelable: true }),
      );
    } catch {
      /* ignore */
    }
  };
}

/** Best-effort subtitle label from its URL (?lang=…&name=…), else "Subtitle N". */
function subLabelFromUrl(url, fallbackN) {
  try {
    const params = new URL(url).searchParams;
    for (const key of ["lang", "language", "label", "name", "title"]) {
      const value = params.get(key);
      if (value && value.trim()) return value.trim();
    }
  } catch {
    /* not a parseable URL */
  }
  return `Subtitle ${fallbackN}`;
}

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
            subs: result.subs ?? [],
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

  /**
   * Provider race — all embeds start CONCURRENTLY on separate browser contexts
   * of one Chrome; the first non-null stream wins.
   *
   * Added 2026-10-24: the serial `rip()` chain measured ~72s of dead providers
   * (VidFast 500s, VidLink catalogue miss) before a working Vidsrc answered
   * at ~78s — beyond the client's 45s abort. In the race, dead providers cost
   * nothing: total resolve ≈ the FASTEST working provider (+ ~8s page-load
   * head). VidFast stays FIRST per the user mandate and loses cleanly when it
   * is down. Losers self-terminate at their own #watch deadline.
   *
   * Total wall guard: RIP_RACE_TOTAL_MS (default 44s, under the client's 45s).
   */
  async race(ref, log = () => {}, depth = 0) {
    const browser = await this.#getBrowser();
    const embeds = providerEmbeds(ref);
    const tried = [];

    let resolveWinner;
    const winnerPromise = new Promise((resolve) => {
      resolveWinner = resolve;
    });

    /**
     * Fast-fail signal (2026-10-24): if EVERY worker crashed, the shared
     * Chrome died — that is infrastructure, not a catalogue verdict. Waiting
     * out the full 44s deadline here was why a working episode showed
     * "No ad-free source" at 55s, then played on a second tap. Signal as soon
     * as the last crash lands so the caller can relaunch Chrome immediately.
     */
    let resolveAllCrashed;
    const allCrashedPromise = new Promise((resolve) => {
      resolveAllCrashed = resolve;
    });

    /**
     * Every rip that answers, in arrival order. results[0] is the head; the
     * rest are rivals evaluated during the hold window below (#holdForBetter) —
     * measured reality: Vidsrc first answers Breaking Bad at 720p with
     * CLOSED-CAPTIONS=NONE while later rivals offer 1080p and/or subtitle
     * tracks, and the user noticed (2026-10-24: "Quality is stuck 720… no CC").
     */
    const results = [];
    let winnerTaken = false;

    const workers = embeds.map((provider) =>
      (async () => {
        const started = Date.now();
        try {
          const result = await this.#ripOne(browser, provider, ref, log);
          const ms = Date.now() - started;
          if (result) {
            tried.push({ provider: provider.id, ms, ok: true, kind: result.kind });
            log(`[${provider.id}] raced ${result.kind} in ${ms}ms`);
            const win = {
              provider: provider.id,
              providerName: provider.name,
              kind: result.kind,
              url: result.url,
              headers: result.headers,
              subs: result.subs ?? [],
            };
            results.push(win);
            if (!winnerTaken) {
              winnerTaken = true;
              resolveWinner(win);
            } else {
              log(`[${provider.id}] rival rip arrived (held for quality/subs)`);
            }
            return;
          }
          tried.push({ provider: provider.id, ms, ok: false });
          log(`[${provider.id}] race miss in ${ms}ms`);
        } catch (err) {
          const ms = Date.now() - started;
          tried.push({ provider: provider.id, ms, ok: false, crash: true, errMsg: err?.message ?? String(err) });
          log(`[${provider.id}] race crash: ${err?.message ?? err}`);
          if (tried.length === embeds.length && tried.every((t) => t.crash)) {
            resolveAllCrashed();
          }
        }
      })(),
    );
    void Promise.allSettled(workers); // losers finish in the background

    const totalMs = Number(process.env.RIP_RACE_TOTAL_MS ?? 44_000);
    let winner = await Promise.race([
      winnerPromise,
      allCrashedPromise.then(() => null),
      sleep(totalMs).then(() => null),
    ]);
    // A late winner may have landed between the crash signal and this line.
    if (!winner && results.length > 0) winner = results[0];

    if (winner) winner = await this.#holdForBetter(winner, results, log);

    this.#scheduleIdleExit();

    if (winner) return { ok: true, ...winner, tried };

    // Every worker CRASHED (e.g. the shared headless Chrome died mid-race —
    // "Connection closed") with zero genuine misses. That is a TRANSIENT
    // infrastructure failure, not a catalogue verdict.
    const crashes = tried.filter((t) => t.crash);
    if (tried.length > 0 && crashes.length === tried.length) {
      // All workers crashed (the shared Chrome died). One AUTO-RETRY on a
      // fresh Chrome self-heals without the user ever seeing it. The crash
      // signal above makes this start immediately instead of at the deadline.
      if (depth === 0) {
        log(`race: all providers crashed — relaunching Chrome and retrying once`);
        this.#browser = null;
        this.#launching = null;
        return this.race(ref, log, depth + 1);
      }
      // Retry also dead (or slow crash): throw so the sidecar answers 503 and
      // never lands in the 90s negative cache. The next tap relaunches Chrome
      // with no penalty.
      throw new Error(`extractor-browser-died (${crashes.length} providers: "${crashes[0].errMsg}")`);
    }
    return { ok: false, tried };
  }

  /**
   * 2026-10-24 — after the first rip answers, keep listening for rival rips
   * for RIP_RACE_HOLD_MS and swap when one is objectively better. "Better":
   * a higher top rung, or — at an equal/unknown rung — subtitle tracks where
   * the current head has none. Peeks read each rival's OWN master with its
   * own captured headers; a failed peek is never treated as a verdict.
   * Rivals that never answer cost at most the hold window once per fresh
   * rip (cache hits skip the race entirely).
   */
  async #holdForBetter(head, results, log) {
    const holdMs = Number(process.env.RIP_RACE_HOLD_MS ?? 600);
    if (holdMs <= 0 || head.kind !== "hls") return head;

    const rungOf = (profile) => profile?.rung ?? null;
    const describe = (profile) =>
      profile === null
        ? "peek-failed"
        : `rung=${rungOf(profile) ?? "unknown"}${profile.hasSubs ? " +subs" : " no-subs"}`;

    // Deadline FIRST: the head's own peek must fit INSIDE the hold window,
    // never extend it (2026-10-24: held resolve measured 10.25s; hot target
    // ≈ race + ~0.6s). The head peek itself is capped so a slow CDN can't
    // eat the window either.
    const deadline = Date.now() + holdMs;
    let best = {
      win: head,
      profile: await this.#peekRip(head, Math.max(Math.ceil(holdMs / 2), 1000)),
    };
    log(`[hold] head ${best.win.provider} ${describe(best.profile)}`);

    let seen = 1; // results[0] is the head
    while (Date.now() < deadline) {
      if (seen >= results.length) {
        await sleep(120);
        continue;
      }
      const rival = results[seen++];
      if (rival.kind !== "hls") continue; // mp4 rivals can't be compared on rungs
      // A rival peek never runs meaningfully past the deadline.
      const budget = deadline - Date.now();
      if (budget <= 50) break;
      const profile = await this.#peekRip(rival, budget);
      if (profile === null) {
        log(`[hold] ${rival.provider} peek failed — not a candidate`);
        continue;
      }
      const rivalRung = rungOf(profile);
      const bestRung = rungOf(best.profile);
      // Higher known rung always wins.
      let better = rivalRung !== null && bestRung !== null && rivalRung > bestRung;
      // Equal (or both unknown) rung → subs disambiguate.
      if (!better && rivalRung === bestRung) {
        better = profile.hasSubs && !(best.profile?.hasSubs ?? false);
      }
      if (better) {
        log(
          `[hold] SWAP ${best.win.provider}${bestRung ? ` ${bestRung}p` : " (unparsed rung)"}` +
            ` → ${rival.provider} ${rivalRung ? `${rivalRung}p` : "(unparsed rung)"}` +
            `${profile.hasSubs ? " +subs" : ""}`,
        );
        best = { win: rival, profile };
      } else {
        log(`[hold] kept ${best.win.provider} — ${rival.provider} ${describe(profile)}`);
      }
    }
    return best.win;
  }

  /**
   * Fetch a rip's master playlist with its own captured headers and read the
   * top RESOLUTION rung + subtitle-track presence. Null on any failure —
   * a peek that can't read is ignorance, not a verdict.
   */
  async #peekRip(win, timeoutMs = 4000) {
    try {
      const res = await fetch(win.url, {
        headers: win.headers,
        signal: AbortSignal.timeout(Math.max(Math.ceil(timeoutMs), 250)),
      });
      if (!res.ok) return null;
      const text = (await res.text()).slice(0, 65_536);
      // Effective 16:9-equivalent height: a cinematic 1920x800 master is
      // 1080p-class, not 720p (the 800 is letterboxing). Compare width-derived
      // height when the frame is wider than 16:9.
      let rung = null;
      for (const m of text.matchAll(/RESOLUTION=(\d+)x(\d+)/g)) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
        const effective = w >= h ? Math.max(h, Math.round((w * 9) / 16)) : h;
        if (rung === null || effective > rung) rung = effective;
      }
      const hasSubs = /EXT-X-MEDIA:TYPE=SUBTITLES/i.test(text);
      return { rung, hasSubs };
    } catch {
      return null;
    }
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
    const seen = { master: null, variant: null, mp4: null, subs: [] };
    const sawDrm = { value: false };
    const headersToUse = new Map(); // candidate url -> replay headers
    const subUrls = new Set(); // dedupe repeated WebVTT fetches

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

        // WebVTT tracks (2026-10-24): the provider's own player lazy-loads its
        // CC files as plain .vtt, outside the HLS master. Snarf each one with
        // its replay headers — they ride backing <track> elements and fill
        // the CC sheet even when the master says CLOSED-CAPTIONS=NONE.
        if (kind === "vtt") {
          if (!subUrls.has(url)) {
            subUrls.add(url);
            try {
              seen.subs.push({
                url,
                headers: captureHeaders(response.request()),
                label: subLabelFromUrl(url, seen.subs.length + 1),
              });
              log(`  [${provider.id}] subs snarfed so far: ${seen.subs.length}`);
            } catch {
              /* request object already gone — skip this track */
            }
          }
          return;
        }

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
    let captionKicked = false;
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
          // One-shot CC kick + short listen window (2026-10-24): the embed's
          // player fetches its WebVTT only when its captions control toggles.
          // Costs at most RIP_CAPTION_KICK_MS (default 0.5s) and exits early
          // once a track lands; external catalogue subs cover the rest.
          if (!captionKicked && seen.subs.length === 0) {
            captionKicked = true;
            for (const frame of page.frames()) {
              try {
                await frame.evaluate(inPageCaptionKick());
              } catch {
                /* frame torn down */
              }
            }
            const kickDeadline = Date.now() + Number(process.env.RIP_CAPTION_KICK_MS ?? 500);
            while (seen.subs.length === 0 && Date.now() < kickDeadline) {
              await sleep(100);
            }
            continue; // re-evaluate — snarfed subs ride the resolve below
          }
          const finalBest = bestNow();
          const headers = headersToUse.get(finalBest.url) ?? {};
          resolve = { kind: finalBest.kind, url: finalBest.url, headers, subs: seen.subs.slice() };
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
