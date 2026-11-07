#!/usr/bin/env node
/**
 * Lighthook visual QA sweep.
 *
 * Loads every primary route in headless Chrome at four viewports and measures
 * the layout the way a person would see it: horizontal overflow, boxes wider
 * than the screen, key content in the first viewport, tap-target sizes, fixed
 * bars covering actions, the watch deck's bottom edge, and small/low-contrast
 * text. One screenshot per page per viewport lands in
 * %TEMP%\opencode\lighthook-visual\ (never committed).
 *
 * Usage (dev server must already be running):
 *
 *   node scripts/qa/visual.mjs
 *   node scripts/qa/visual.mjs --headed --only=watch
 *   node scripts/qa/visual.mjs --base=http://localhost:5173 --chrome="C:\path\chrome.exe"
 *
 * The run is read-only: nothing is seeded, no app code is touched. Storage is
 * cleared once at boot so the profile picker, the house notice, and the admin
 * login all start from a genuine first-open device.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_BASE = "http://localhost:5173";
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const NOTICE_KEY = "lighthook.notice.acknowledged";
const NOTICE_LEGACY_KEY = "lighthook.notice.dismissedOn";
const SCREEN_PASSWORD = "1234";

const VIEWPORTS = [
  { width: 360, height: 640, name: "360x640" },
  { width: 390, height: 844, name: "390x844" },
  { width: 768, height: 1024, name: "768x1024" },
  { width: 1440, height: 950, name: "1440x950" },
];

const SHOT_DIR = path.join(os.tmpdir(), "opencode", "lighthook-visual");
const PROFILE_ROOT = path.join(os.tmpdir(), "opencode");

const SEVERITY_ORDER = { BLOCKER: 0, MAJOR: 1, MINOR: 2, INFO: 3, SKIP: 4 };

function parseArgs(argv) {
  const config = { base: DEFAULT_BASE, chrome: DEFAULT_CHROME, headed: false, only: null };
  for (const arg of argv) {
    if (arg === "--headed") config.headed = true;
    else if (arg.startsWith("--base=")) config.base = arg.slice("--base=".length);
    else if (arg.startsWith("--chrome=")) config.chrome = arg.slice("--chrome=".length);
    else if (arg.startsWith("--only=")) config.only = arg.slice("--only=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Lighthook visual QA",
          "",
          "  node scripts/qa/visual.mjs [options]",
          "",
          "  --headed          show the browser window",
          "  --base=<url>      app origin (default http://localhost:5173)",
          "  --chrome=<path>   Chrome executable",
          "  --only=<id>       run a single page id (profiles, admin, home, search,",
          "                    library, browse, title, watch)",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg} (try --help)`);
      process.exit(64);
    }
  }
  return config;
}

const CFG = parseArgs(process.argv.slice(2));
const BASE = CFG.base.replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;

/* ------------------------------------------------------------------ */
/* Page specs                                                          */
/* ------------------------------------------------------------------ */

/**
 * `content` is "must be visible in the first viewport". `primary` is a real
 * control that must be fully in view and not covered by a fixed bar.
 * `optional` content is TMDB-dependent and degrades to SKIP, never a pass.
 */
const PAGES = [
  {
    id: "profiles",
    label: "/ (profiles)",
    path: "/profiles",
    waitFor: ".profiles-page",
    css: "src/styles/profiles.css",
    catalogue: {
      notice: ".notice",
      profilesTitle: ".profiles-title",
      profilesAdmin: ".profiles-admin-btn",
      profileTiles: ".profile-tile__select",
      profileGrid: ".profile-grid",
    },
    content: [],
    primary: [{ selector: ".profiles-admin-btn", label: "Admin" }],
    noticeKey: true,
  },
  {
    id: "admin",
    label: "/admin (login)",
    path: "/admin",
    waitFor: ".admin-page",
    css: "src/styles/admin.css",
    catalogue: {
      adminGate: ".admin-page--login",
      adminPassword: 'input[aria-label="Admin password"]',
      adminSubmit: '.admin-login-actions button[type="submit"]',
    },
    content: [
      { selector: 'input[aria-label="Admin password"]', name: "admin password field" },
      { selector: '.admin-login-actions button[type="submit"]', name: "admin submit" },
    ],
    primary: [
      { selector: 'input[aria-label="Admin password"]', label: "admin password" },
      { selector: '.admin-login-actions button[type="submit"]', label: "admin submit" },
    ],
  },
  {
    id: "home",
    label: "/ (home)",
    path: "/",
    waitFor: ".home-header",
    waitForContent: ".hero-title",
    contentTimeout: 30_000,
    css: "src/styles/home.css",
    catalogue: {
      homeHeader: ".home-header",
      heroTitle: ".hero-title",
      hero: ".hero",
      heroSkeleton: ".hero--skeleton",
      heroPlay: ".hero-actions .btn-primary",
      tabBar: ".tab-bar",
    },
    content: [
      { selector: ".hero-title", name: "hero title", optional: true },
      { selector: ".hero-actions .btn-primary", name: "hero Play", optional: true },
    ],
    primary: [{ selector: ".hero-actions .btn-primary", label: "Play" }],
  },
  {
    id: "search",
    label: "/search",
    path: "/search",
    waitFor: ".search-title",
    css: "src/styles/search.css",
    catalogue: {
      searchTitle: ".search-title",
      searchField: ".search-field input",
      searchSticky: ".search-sticky",
      tabBar: ".tab-bar",
    },
    content: [
      { selector: ".search-title", name: "page title" },
      { selector: ".search-field input", name: "search field" },
    ],
    primary: [{ selector: ".search-field input", label: "search input" }],
  },
  {
    id: "library",
    label: "/library",
    path: "/library",
    waitFor: ".library-title",
    css: "src/styles/library.css",
    catalogue: {
      libraryTitle: ".library-title",
      libraryTabs: ".library-tabs",
      tabBar: ".tab-bar",
    },
    content: [
      { selector: ".library-title", name: "page title" },
      { selector: ".library-tabs", name: "watchlist/history tabs" },
    ],
    primary: [{ selector: ".library-tabs button", label: "library tab" }],
  },
  {
    id: "browse",
    label: "/browse/trending",
    path: "/browse/trending",
    waitFor: ".browse-head",
    waitForContent: ".browse-grid .poster-card",
    contentTimeout: 30_000,
    css: "src/styles/browse.css",
    catalogue: {
      browseTitle: ".browse-title",
      browseBack: ".browse-back",
      browseGrid: ".browse-grid",
      browseCard: ".browse-grid .poster-card",
      tabBar: ".tab-bar",
    },
    content: [
      { selector: ".browse-title", name: "page title" },
      { selector: ".browse-grid .poster-card", name: "first poster", optional: true },
    ],
    primary: [{ selector: ".browse-back", label: "Back" }],
  },
  {
    id: "title",
    label: "/title/movie/550",
    path: "/title/movie/550",
    waitFor: ".title-page",
    waitForContent: ".title-heading",
    contentTimeout: 35_000,
    css: "src/styles/title.css",
    catalogue: {
      titleHeading: ".title-heading",
      titlePlay: ".title-actions .btn-primary",
      titleBack: ".title-back",
    },
    content: [
      { selector: ".title-heading", name: "title heading", optional: true },
      { selector: ".title-actions .btn-primary", name: "Play", optional: true },
    ],
    primary: [{ selector: ".title-actions .btn-primary", label: "Play" }],
  },
  {
    id: "watch",
    label: "/watch/tv/1399?s=1&e=1",
    path: "/watch/tv/1399?s=1&e=1",
    waitFor: ".watch-bar",
    waitForContent: ".watch-now-title",
    contentTimeout: 30_000,
    css: "src/styles/player.css",
    catalogue: {
      deck: ".watch-bar",
      deckActions: ".watch-actions--episodes",
      deckButtons: ".watch-actions .watch-episode-btn",
      watchTitle: ".watch-now-title",
      watchTop: ".watch-top",
    },
    content: [
      { selector: ".watch-bar", name: "bottom deck" },
      { selector: ".watch-now-title", name: "now-playing title", optional: true },
    ],
    primary: [],
    watch: true,
  },
  // Extra worst-case probe: S1E2 renders all three transport buttons, so the
  // 360px row can be checked without the S1E1 "no Previous" exemption.
  {
    id: "watch-3btn",
    label: "/watch/tv/1399?s=1&e=2 (3 buttons)",
    path: "/watch/tv/1399?s=1&e=2",
    waitFor: ".watch-bar",
    waitForContent: ".watch-episode-btn",
    contentTimeout: 20_000,
    css: "src/styles/player.css",
    catalogue: {
      deck: ".watch-bar",
      deckActions: ".watch-actions--episodes",
      deckButtons: ".watch-actions .watch-episode-btn",
      watchTitle: ".watch-now-title",
      watchTop: ".watch-top",
    },
    content: [{ selector: ".watch-bar", name: "bottom deck" }],
    primary: [],
    watch: true,
    onlyWidths: [360],
  },
  {
    id: "home-notice",
    label: "/ (home, first open + notice)",
    path: "/",
    waitFor: ".home-header",
    waitForContent: ".hero-title",
    contentTimeout: 30_000,
    css: "src/styles/home.css",
    catalogue: {
      homeHeader: ".home-header",
      heroTitle: ".hero-title",
      hero: ".hero",
      notice: ".notice",
    },
    content: [{ selector: ".hero-title", name: "hero title", optional: true }],
    primary: [{ selector: ".hero-actions .btn-primary", label: "Play" }],
    onlyWidths: [360],
    noticeKey: true,
  },
];

/* ------------------------------------------------------------------ */
/* In-page measurement                                                 */
/* ------------------------------------------------------------------ */

/**
 * Runs in the browser. Everything below is self-contained so puppeteer can
 * serialise it; the only input is the page config.
 */
function collectPageData(cfg) {
  const root = document.documentElement;
  const vw = root.clientWidth;
  const vh = window.innerHeight;

  const round = (n) => Math.round(n * 10) / 10;

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el === root) return "html";
    if (el === document.body) return "body";
    let out = "";
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 3) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        out = part + "#" + CSS.escape(node.id) + (out ? " > " + out : "");
        break;
      }
      const cls = [...node.classList].slice(0, 3);
      if (cls.length) part += cls.map((c) => "." + CSS.escape(c)).join("");
      else if (node.parentElement) {
        const idx =
          [...node.parentElement.children].filter((c) => c.tagName === node.tagName).indexOf(node) + 1;
        part += `:nth-of-type(${idx})`;
      }
      out = part + (out ? " > " + out : "");
      node = node.parentElement;
      depth += 1;
    }
    return out;
  }

  function shortSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    const cls = [...el.classList].filter((c) => !/^(is-|has-)/.test(c));
    if (cls.length) return el.tagName.toLowerCase() + "." + CSS.escape(cls[cls.length - 1]);
    return el.tagName.toLowerCase();
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return {
      top: round(r.top),
      bottom: round(r.bottom),
      left: round(r.left),
      right: round(r.right),
      width: round(r.width),
      height: round(r.height),
    };
  }

  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function labelOf(el) {
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      text ||
      el.getAttribute("placeholder") ||
      el.tagName.toLowerCase()
    ).slice(0, 50);
  }

  /* -------- colour / contrast -------- */

  function parseColor(input) {
    if (!input) return null;
    let m = input.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
      if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
      }
      return null;
    }
    m = input.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
    if (m) {
      return [
        Number(m[1]) * 255,
        Number(m[2]) * 255,
        Number(m[3]) * 255,
        m[4] === undefined ? 1 : Number(m[4]),
      ];
    }
    return null;
  }

  function blend(fg, bg) {
    const a = fg[3] === undefined ? 1 : fg[3];
    return [
      fg[0] * a + bg[0] * (1 - a),
      fg[1] * a + bg[1] * (1 - a),
      fg[2] * a + bg[2] * (1 - a),
      1,
    ];
  }

  function luminance(c) {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  }

  const bgCache = new WeakMap();
  function backgroundOf(el) {
    if (bgCache.has(el)) return bgCache.get(el);
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    chain.reverse();
    let acc = [0, 0, 0, 1];
    for (const n of chain) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0.001) acc = blend(c, acc);
    }
    bgCache.set(el, acc);
    return acc;
  }

  function contrastOf(el) {
    const bg = backgroundOf(el);
    const tc = parseColor(getComputedStyle(el).color) || [255, 255, 255, 1];
    const fg = blend(tc, bg);
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  /* -------- horizontal overflow -------- */

  function clippedByAncestor(el) {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(hidden|clip|auto|scroll)/.test(cs.overflowX)) {
        const pr = p.getBoundingClientRect();
        if (pr.right <= vw + 1 && pr.left >= -1) return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  const overflowX = Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth;

  const wide = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "IFRAME"].includes(el.tagName)) {
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= vw + 1 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;

    // Decorative glow/beam layers: fully transparent to input, usually
    // aria-hidden, and they never carry the page's content.
    const absolute = cs.position === "absolute" || cs.position === "fixed";
    const inert = cs.pointerEvents === "none" || el.getAttribute("aria-hidden") === "true";
    const hasContent =
      Boolean((el.innerText || "").trim()) ||
      Boolean(el.querySelector("img, video, button, a, input, iframe"));
    if (absolute && inert && !hasContent) continue;

    if (clippedByAncestor(el)) continue;

    wide.push({
      selector: cssPath(el),
      width: round(r.width),
      right: round(r.right),
      left: round(r.left),
      position: cs.position,
      text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40),
    });
    if (wide.length >= 30) break;
  }
  wide.sort((a, b) => b.width - a.width);

  /* Decorative pseudo-elements can widen the document even when every DOM box
     fits (e.g. a ::before with left/right: -8%). Only scanned when the
     document already reports overflow, so the cost stays off normal pages. */
  const pseudoBleed = [];
  if (overflowX > 1) {
    for (const el of document.body.querySelectorAll("*")) {
      const er = el.getBoundingClientRect();
      if (er.width <= 0 || er.height <= 0) continue;
      for (const pseudo of ["::before", "::after"]) {
        const cs = getComputedStyle(el, pseudo);
        if (!cs || cs.content === "none" || cs.display === "none") continue;
        if (cs.position !== "absolute" && cs.position !== "fixed") continue;
        if (cs.pointerEvents !== "none") continue;
        const left = parseFloat(cs.left);
        const right = parseFloat(cs.right);
        if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
        if (left >= 0 && right >= 0) continue;
        const leftPx = cs.left.endsWith("%") ? (left / 100) * er.width : left;
        const rightPx = cs.right.endsWith("%") ? (right / 100) * er.width : right;
        const pl = er.left + leftPx;
        const pr = er.right - rightPx;
        if (pr > vw + 1 || pl < -1) {
          pseudoBleed.push({
            selector: shortSelector(el) + pseudo,
            left: round(pl),
            right: round(pr),
            bleed: round(Math.max(pr - vw, -pl)),
          });
        }
      }
      if (pseudoBleed.length >= 8) break;
    }
    pseudoBleed.sort((a, b) => b.bleed - a.bleed);
  }

  /* -------- controls -------- */

  const controlSelector =
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="link"], summary';
  const smallControls = [];
  let controlCount = 0;
  for (const el of document.querySelectorAll(controlSelector)) {
    if (el.closest(".sr-only") || el.closest('[aria-hidden="true"]')) continue;
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -50 || r.right < 0) continue;
    const cs = getComputedStyle(el);
    if (cs.pointerEvents === "none") continue;
    controlCount += 1;
    // An input wrapped in a label is tapped through the label's padded box.
    let box = r;
    if (el.tagName === "INPUT" && el.closest("label")) {
      const lr = el.closest("label").getBoundingClientRect();
      if (lr.width > box.width || lr.height > box.height) box = lr;
    }
    const w = round(box.width);
    const h = round(box.height);
    const disabled = el.disabled === true;
    if (!disabled && (w < 40 || h < 40)) {
      smallControls.push({ selector: cssPath(el), label: labelOf(el), w, h, top: round(r.top) });
    }
  }
  smallControls.sort((a, b) => a.w * a.h - b.w * b.h);

  /* -------- small / low-contrast text -------- */

  const smallText = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
    if (text.length < 3) continue;
    const el = node.parentElement;
    if (!el) continue;
    if (el.closest(".sr-only, script, style, noscript, [aria-hidden='true']")) continue;
    const cs = getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize);
    if (!Number.isFinite(fontSize) || fontSize >= 11) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const selector = cssPath(el);
    const key = selector + "|" + text.slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    const contrast = round(contrastOf(el) * 100) / 100;
    if (contrast < 4.5 || fontSize < 10) {
      smallText.push({
        selector,
        text: text.slice(0, 70),
        fontSize,
        contrast,
        color: cs.color,
      });
    }
    if (smallText.length >= 40) break;
  }
  smallText.sort((a, b) => a.contrast - b.contrast);

  /* -------- named elements -------- */

  const elements = {};
  for (const [key, selector] of Object.entries(cfg.catalogue || {})) {
    const nodes = [...document.querySelectorAll(selector)];
    elements[key] = nodes.slice(0, 8).map((el) => {
      const cs = getComputedStyle(el);
      return {
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 90),
        rect: rectOf(el),
        visible: isVisible(el),
        fontSize: parseFloat(cs.fontSize),
        position: cs.position,
        zIndex: cs.zIndex,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowX: cs.overflowX,
        whiteSpace: cs.whiteSpace,
        children: [...el.children]
          .filter((c) => isVisible(c))
          .slice(0, 8)
          .map((c) => ({
            selector: cssPath(c),
            text: (c.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40),
            rect: rectOf(c),
          })),
      };
    });
  }

  /* -------- content visibility -------- */

  const content = (cfg.content || []).map((entry) => {
    const el = document.querySelector(entry.selector);
    if (!el) {
      return { name: entry.name, selector: entry.selector, optional: !!entry.optional, found: false };
    }
    const r = el.getBoundingClientRect();
    return {
      name: entry.name,
      selector: entry.selector,
      optional: !!entry.optional,
      found: true,
      rect: rectOf(el),
      text: (el.innerText || el.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60),
      inFirstView: r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0,
      fullyInView: r.top >= -0.5 && r.bottom <= vh + 0.5 && r.left >= -0.5 && r.right <= vw + 0.5,
    };
  });

  /* -------- primary controls: in view + covered? -------- */

  function coveringBar(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const inset = Math.min(6, r.width / 4, r.height / 4);
    const points = [
      [r.left + r.width / 2, r.top + inset],
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + r.width / 2, r.bottom - inset],
      [r.left + inset, r.top + r.height / 2],
      [r.right - inset, r.top + r.height / 2],
    ];
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x > vw || y > vh) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit === el || el.contains(hit) || hit.contains(el)) continue;
      // Only a fixed/sticky bar counts as "covering": inset actions inside the
      // same field (the password reveal eye) are part of the control.
      let node = hit;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        if (cs.position === "fixed" || cs.position === "sticky") {
          return cssPath(node);
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  const primaries = (cfg.primary || []).map((entry) => {
    const selector = typeof entry === "string" ? entry : entry.selector;
    const label = typeof entry === "string" ? selector : entry.label || selector;
    const el = document.querySelector(selector);
    if (!el) return { selector, label, found: false };
    const r = el.getBoundingClientRect();
    return {
      selector,
      label,
      found: true,
      rect: rectOf(el),
      inView: r.top >= -0.5 && r.bottom <= vh + 0.5 && r.left >= -0.5 && r.right <= vw + 0.5,
      coveredBy: coveringBar(el),
    };
  });

  /* -------- fixed / sticky bars -------- */

  const fixedBars = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 8) continue;
    fixedBars.push({
      selector: cssPath(el),
      position: cs.position,
      zIndex: cs.zIndex,
      rect: rectOf(el),
    });
  }

  return {
    url: location.pathname + location.search,
    title: document.title,
    vw,
    vh,
    dpr: window.devicePixelRatio,
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflowX: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
    scrollHeight: root.scrollHeight,
    clientHeight: root.clientHeight,
    wide,
    pseudoBleed,
    smallControls,
    controlCount,
    smallText,
    elements,
    content,
    primaries,
    fixedBars,
  };
}

/* ------------------------------------------------------------------ */
/* Defect analysis                                                     */
/* ------------------------------------------------------------------ */

const first = (list) => (Array.isArray(list) && list.length ? list[0] : null);

function analyze(spec, vp, data) {
  const defects = [];
  const add = (severity, selector, issue, fix) =>
    defects.push({ severity, page: spec.label, pageId: spec.id, viewport: vp, selector, issue, fix });

  const css = spec.css;

  /* Horizontal overflow. */
  if (data.overflowX > 1) {
    const pseudo = (data.pseudoBleed || []).find((p) => p.bleed >= data.overflowX - 2);
    const wideBox = data.wide.find((w) => w.width > data.vw + 1);
    const selector = pseudo ? pseudo.selector : wideBox ? wideBox.selector : "html";
    const extra = pseudo
      ? ` - decorative ${pseudo.selector.split(" > ").pop()} reaches x=${pseudo.right}`
      : wideBox
        ? ` - widest box ${wideBox.selector} is ${Math.round(wideBox.width)}px`
        : "";
    add(
      "BLOCKER",
      selector,
      `horizontal overflow +${data.overflowX}px (scrollWidth ${data.scrollWidth} > clientWidth ${data.clientWidth})${extra}`,
      pseudo
        ? `clip the decorative layer: add overflow-x: clip to ${pseudo.selector.split("::")[0]} (or .app { overflow-x: clip } in src/styles.css) - do not use overflow:hidden on a sticky parent`
        : `contain the widest box with max-width:100%; min-width:0 on its flex/grid parent (${css}); as a backstop add .app { overflow-x: clip } in src/styles.css`,
    );
  }

  /* Boxes wider than the viewport (decorative layers + iframe excluded). */
  const widest = data.wide.filter((w) => w.width > data.vw + 1);
  const shown = new Set();
  for (const w of widest) {
    if (shown.size >= 4) break;
    const key = w.selector.replace(/:nth-of-type\(\d+\)/g, "");
    if (shown.has(key)) continue;
    shown.add(key);
    add(
      "MAJOR",
      w.selector,
      `box ${Math.round(w.width)}px wide vs viewport ${data.vw}px (+${Math.round(w.width - data.vw)}px)`,
      `constrain width (max-width:100%) or hide the bleed with overflow-x: clip on its container (${css})`,
    );
  }

  /* Key content in the first viewport. */
  for (const c of data.content) {
    if (!c.found) {
      add(
        c.optional ? "SKIP" : "BLOCKER",
        c.selector,
        c.optional ? `${c.name} not rendered (TMDB/data unavailable)` : `${c.name} missing from the DOM`,
        c.optional ? "re-run when TMDB responds" : `check the render path for ${c.name} (${css})`,
      );
      continue;
    }
    if (!c.inFirstView) {
      add(
        "MAJOR",
        c.selector,
        `${c.name} outside the first viewport (top ${c.rect.top}, bottom ${c.rect.bottom}, vh ${data.vh})`,
        `pull ${c.name} into the first screen (reduce top spacing or notice height) in ${css}`,
      );
    }
  }

  /* Primary controls: fully visible + uncovered. */
  for (const p of data.primaries) {
    if (!p.found) {
      add("BLOCKER", p.selector, `primary control "${p.label}" is missing`, `render ${p.selector} (${css})`);
      continue;
    }
    if (!p.inView) {
      // A below-the-fold control on a scrollable page is recoverable; a
      // control clipped on a non-scrollable page is not.
      const scrollable = data.scrollHeight > data.clientHeight + 1;
      add(
        scrollable ? "MAJOR" : "BLOCKER",
        p.selector,
        `primary control "${p.label}" outside the first viewport (top ${p.rect.top}, bottom ${p.rect.bottom}, vh ${data.vh})`,
        `pull the control into the first screen: reduce the content above it (${css})${scrollable ? "; the page does scroll, so it is reachable" : ""}`,
      );
    }
    if (p.coveredBy) {
      add(
        "BLOCKER",
        p.selector,
        `primary control "${p.label}" is covered by ${p.coveredBy}`,
        `reserve space for the fixed bar (padding-bottom) or raise the control's z-index in ${css}`,
      );
    }
  }

  /* Tap targets. */
  for (const c of data.smallControls.slice(0, 5)) {
    add(
      c.w < 32 || c.h < 32 ? "MAJOR" : "MINOR",
      c.selector,
      `tap target ${c.w}x${c.h}px (< 40x40) "${c.label}"`,
      `min-height: 44px; min-width: 44px (or pad the hit area) in ${css}`,
    );
  }

  /* Small / low-contrast text. */
  for (const t of data.smallText.slice(0, 3)) {
    const belowContrast = t.contrast < 4.5;
    add(
      t.contrast < 3 ? "MAJOR" : "MINOR",
      t.selector,
      belowContrast
        ? `${t.fontSize}px muted text at ${t.contrast}:1 (AA needs 4.5:1; target floor is 11px) - "${t.text}"`
        : `${t.fontSize}px text below the 11px floor (contrast ${t.contrast}:1) - "${t.text}"`,
      belowContrast
        ? `raise to >= 11px and lighten to --muted/--text in ${css}`
        : `raise to >= 11px (--text-2xs is 10.5px) or keep as a non-textual mark in ${css}`,
    );
  }

  /* Profiles: notice must not push the heading entirely off-screen. */
  if (spec.id === "profiles") {
    const title = first(data.elements.profilesTitle);
    const notice = first(data.elements.notice);
    const admin = first(data.elements.profilesAdmin);

    if (!title) {
      add("BLOCKER", ".profiles-title", "profiles heading missing", `render the heading in ${css}`);
    } else if (title.rect.top >= data.vh) {
      add(
        "BLOCKER",
        title.selector,
        `heading starts at y=${title.rect.top}, below the ${data.vh}px fold${notice ? " (house notice pushes it off-screen)" : ""}`,
        `shrink .profiles-hero margin-top (clamp(40px, 7.5vh, 92px)) and cap .notice-card height/stack at <=640px in src/styles/profiles.css + notice.css`,
      );
    } else if (title.rect.bottom > data.vh + 1) {
      add(
        "MAJOR",
        title.selector,
        `heading partially below the fold (bottom ${title.rect.bottom} > ${data.vh}${notice ? "; house notice above" : ""})`,
        `reduce .profiles-hero margin-top at short viewports in src/styles/profiles.css`,
      );
    }

    if (!admin || !admin.visible) {
      add("BLOCKER", ".profiles-admin-btn", "admin button not rendered", `render the Admin pill in ${css}`);
    } else {
      if (admin.rect.top < -0.5 || admin.rect.bottom > data.vh + 0.5) {
        add(
          "MAJOR",
          admin.selector,
          `admin button outside the first viewport (top ${admin.rect.top}, bottom ${admin.rect.bottom})`,
          `keep the masthead inside the first screen (${css})`,
        );
      }
    }

    const tiles = data.elements.profileTiles || [];
    if (!tiles.length) {
      add("BLOCKER", ".profile-tile__select", "no profile tiles rendered", `check loadProfiles()/the grid (${css})`);
    }
    for (const t of tiles) {
      if (t.rect.left < -0.5 || t.rect.right > data.vw + 0.5) {
        add(
          "MAJOR",
          t.selector,
          `tile clipped horizontally (${t.rect.left}..${t.rect.right} vs viewport ${data.vw})`,
          `fix profile-grid min column width / gap at narrow widths in ${css}`,
        );
      }
    }

    if (notice) {
      if (notice.rect.right > data.vw + 0.5 || notice.rect.left < -0.5) {
        add(
          "MAJOR",
          notice.selector,
          `house notice wider than the viewport (${notice.rect.width}px vs ${data.vw}px)`,
          `let .notice-card shrink with width:100%; max-width:100% in src/styles/notice.css`,
        );
      }
    }
  }

  /* Watch: deck fully visible + transport buttons not clipped. */
  if (spec.watch) {
    const deck = first(data.elements.deck);
    if (!deck) {
      add("BLOCKER", ".watch-bar", "bottom deck missing", `render .watch-bar (${css})`);
    } else {
      const below = deck.rect.bottom - data.vh;
      if (below > 0.5) {
        add(
          "BLOCKER",
          deck.selector,
          `deck bottom at ${deck.rect.bottom}px > viewport ${data.vh}px (+${Math.round(below * 10) / 10}px cut off)`,
          `keep the deck inside 100dvh: .app:has(.watch){height:100dvh;overflow:hidden} .watch{height:100%;min-height:0} .watch-bar{flex:0 0 auto} in src/styles/player.css`,
        );
      }
      if (deck.rect.top < -0.5) {
        add("MAJOR", deck.selector, `deck taller than the viewport (top ${deck.rect.top})`, `trim deck padding/rows at <=560px in ${css}`);
      }
      if (deck.rect.left < -0.5 || deck.rect.right > data.vw + 0.5) {
        add("MAJOR", deck.selector, `deck overflows horizontally (${deck.rect.left}..${deck.rect.right})`, `use max-width:100% and safe-area padding in ${css}`);
      }
    }

    const buttons = data.elements.deckButtons || [];
    if (buttons.length < 3) {
      add(
        "INFO",
        ".watch-actions .watch-episode-btn",
        `${buttons.length} transport button(s) rendered (Previous is intentionally absent on S1E1)`,
        "S1E2 probe covers the full three-button row",
      );
    }
    for (const b of buttons) {
      if (b.rect.left < -0.5 || b.rect.right > data.vw + 0.5) {
        add(
          "MAJOR",
          b.selector,
          `transport button clipped horizontally (${b.rect.left}..${b.rect.right} vs ${data.vw})`,
          `let the row wrap or shrink button min-width at <=380px in ${css}`,
        );
      }
      if (b.rect.bottom > data.vh + 0.5) {
        add("BLOCKER", b.selector, `transport button below the fold (bottom ${b.rect.bottom} > ${data.vh})`, `shrink the deck at short viewports in ${css}`);
      }
      if (b.scrollWidth > b.clientWidth + 1) {
        add(
          "MAJOR",
          b.selector,
          `label clipped: content ${b.scrollWidth}px in a ${b.clientWidth}px box`,
          `swap to the short label earlier or allow wrapping at <=380px in ${css}`,
        );
      }
      for (const child of b.children) {
        if (child.rect.left < b.rect.left - 0.5 || child.rect.right > b.rect.right + 0.5) {
          add(
            "MAJOR",
            child.selector,
            `child content overflows its button (${child.rect.left}..${child.rect.right} vs ${b.rect.left}..${b.rect.right})`,
            `reduce gap/padding or hide the long label at this width in ${css}`,
          );
        }
      }
    }

    const actions = first(data.elements.deckActions);
    if (actions && (actions.rect.left < -0.5 || actions.rect.right > data.vw + 0.5)) {
      add(
        "MAJOR",
        actions.selector,
        `transport well overflows (${actions.rect.left}..${actions.rect.right} vs ${data.vw})`,
        `set max-width:100%; flex-wrap on .watch-actions--episodes in ${css}`,
      );
    }
  }

  return defects;
}

/* ------------------------------------------------------------------ */
/* Browser plumbing                                                    */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (err) => (err instanceof Error ? err.message : String(err));

/** @type {import("puppeteer-core").Page | null} */
let page = null;
const diagnostics = [];

async function goto(pathname, waitFor, timeout = 45_000) {
  const url = pathname.startsWith("http") ? pathname : `${BASE}${pathname}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  if (waitFor) await page.waitForSelector(waitFor, { timeout });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  await sleep(350);
}

async function waitForOptional(selector, timeout) {
  if (!selector) return false;
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function clearStorage() {
  await goto("/profiles", ".profiles-page", 30_000).catch(() => {});
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "all" });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function dismissNotice() {
  try {
    const button = await page.$(".notice-got");
    if (button) {
      await button.click();
      await page.waitForFunction(() => document.querySelector(".notice") === null, { timeout: 5_000 });
      return;
    }
  } catch {
    /* fall through to the storage write */
  }
  await page.evaluate(
    (keys) => {
      for (const key of keys) localStorage.setItem(key, "1");
    },
    [NOTICE_KEY],
  );
}

async function unlockSam() {
  await goto("/profiles", ".profiles-page", 30_000);
  const unlock = await page.$('button[aria-label="Unlock Sam with a password"]');
  if (!unlock) {
    if (await page.$('button[aria-label="Continue as Sam"]')) return;
    throw new Error("Sam's tile is missing from the profiles picker");
  }
  await unlock.click();
  await page.waitForSelector(".sheet", { timeout: 15_000 });
  const field = await page.waitForSelector('input[aria-label="Password for Sam"]', { timeout: 10_000 });
  await field.type(SCREEN_PASSWORD, { delay: 25 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => location.pathname === "/" && document.querySelector(".tab-bar") !== null,
    { timeout: 30_000 },
  );
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

const allDefects = [];
const allMeasurements = [];
const createdAt = new Date().toISOString();
let shotCount = 0;

async function capture(spec, vp) {
  const file = path.join(SHOT_DIR, `${spec.id}-${vp.name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    shotCount += 1;
    return file;
  } catch (err) {
    diagnostics.push(`screenshot failed for ${spec.id} ${vp.name}: ${message(err)}`);
    return null;
  }
}

async function runPage(spec, vp) {
  const viewportName = vp.name;
  let defects = [];
  let data = null;

  try {
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    if (spec.noticeKey) {
      await page.evaluate(
        (keys) => {
          for (const key of keys) localStorage.removeItem(key);
        },
        [NOTICE_KEY, NOTICE_LEGACY_KEY],
      );
    }
    await goto(spec.path, spec.waitFor, spec.navTimeout || 45_000);
    if (spec.waitForContent) {
      await waitForOptional(spec.waitForContent, spec.contentTimeout || 25_000);
    }
    await sleep(250);

    data = await page.evaluate(collectPageData, {
      catalogue: spec.catalogue || {},
      content: spec.content || [],
      primary: spec.primary || [],
    });

    defects = analyze(spec, viewportName, data);
  } catch (err) {
    defects = [
      {
        severity: "BLOCKER",
        page: spec.label,
        pageId: spec.id,
        viewport: viewportName,
        selector: spec.waitFor || "html",
        issue: `page failed to render: ${message(err)}`,
        fix: "start the dev server / re-run this route; if TMDB is down this is environmental",
      },
    ];
  }

  const file = await capture(spec, vp);
  if (file) {
    for (const d of defects) d.screenshot = file;
  } else {
    for (const d of defects) d.screenshot = null;
  }

  for (const d of defects) allDefects.push(d);

  if (data) {
    const deck = first(data.elements.deck);
    allMeasurements.push({
      pageId: spec.id,
      page: spec.label,
      viewport: viewportName,
      vw: data.vw,
      vh: data.vh,
      scrollWidth: data.scrollWidth,
      clientWidth: data.clientWidth,
      scrollHeight: data.scrollHeight,
      clientHeight: data.clientHeight,
      overflowX: data.overflowX,
      scrollable: data.scrollHeight > data.clientHeight + 1,
      deck: deck ? deck.rect : null,
      deckButtons: (data.elements.deckButtons || []).length,
      deckButtonRects: (data.elements.deckButtons || []).map((b) => ({
        selector: b.selector,
        text: b.text,
        rect: b.rect,
        scrollWidth: b.scrollWidth,
        clientWidth: b.clientWidth,
      })),
      elements: Object.fromEntries(
        Object.entries(data.elements).map(([key, list]) => [
          key,
          list.slice(0, 4).map((el) => ({
            selector: el.selector,
            text: el.text,
            rect: el.rect,
            visible: el.visible,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          })),
        ]),
      ),
      content: data.content.map((c) => ({
        name: c.name,
        found: c.found,
        inFirstView: c.inFirstView || false,
        rect: c.rect || null,
      })),
      primaries: data.primaries.map((p) => ({
        selector: p.selector,
        found: p.found,
        inView: p.inView || false,
        coveredBy: p.coveredBy || null,
        rect: p.rect || null,
      })),
      widest: data.wide.slice(0, 5),
      pseudoBleed: data.pseudoBleed,
      smallControls: data.smallControls.slice(0, 8),
      smallText: data.smallText.slice(0, 6),
      screenshot: file,
    });
  }

  const blocker = defects.filter((d) => d.severity === "BLOCKER").length;
  const major = defects.filter((d) => d.severity === "MAJOR").length;
  const minor = defects.filter((d) => d.severity === "MINOR").length;
  const counts = `${blocker}B/${major}M/${minor}m`;
  console.log(
    `${counts.padEnd(9)} ${spec.label.padEnd(34)} ${viewportName.padEnd(9)} ${
      data ? `sw=${data.scrollWidth} cw=${data.clientWidth} deck=${first(data.elements.deck)?.rect.bottom ?? "-"}` : "no data"
    }`,
  );
  return defects;
}

function dedupe(defects) {
  const seen = new Map();
  const out = [];
  for (const d of defects) {
    let key = null;
    if (d.severity === "INFO" || d.severity === "SKIP") {
      key = `${d.severity}|${d.pageId}|${d.selector}|${d.issue}`;
    } else if (/muted text at|below the 11px floor/.test(d.issue)) {
      // Type/contrast is viewport-independent; one row per selector per page
      // (the tab bar's four labels share the same rule, for example).
      key = `TEXT|${d.pageId}|${d.selector}`;
    } else if (/tap target/.test(d.issue)) {
      key = `TAP|${d.pageId}|${d.selector}`;
    }
    if (key === null) {
      out.push(d);
      continue;
    }
    if (seen.has(key)) {
      seen.get(key).viewports.add(d.viewport);
      continue;
    }
    const copy = { ...d, viewports: new Set([d.viewport]) };
    seen.set(key, copy);
    out.push(copy);
  }
  for (const d of out) {
    if (d.viewports) {
      if (d.viewports.size > 1) d.viewport = `${d.viewports.size} vps`;
      delete d.viewports;
    }
  }
  return out;
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max - 1) + "~" : text;
}

function printTable(rows) {
  const headers = ["SEV", "PAGE", "VIEWPORT", "SELECTOR", "ISSUE"];
  const widths = [8, 26, 9, 44, 56];
  const line = (cells) => cells.map((c, i) => truncate(c, widths[i]).padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) {
    console.log(line([r.severity, r.page, r.viewport, r.selector, r.issue]));
  }
}

function printFixes(rows) {
  const seen = new Set();
  console.log("Fixes (one per distinct selector/issue):");
  for (const r of rows) {
    if (r.severity === "SKIP") continue;
    const key = `${r.selector}|${r.fix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  [${r.severity}] ${truncate(r.selector, 44)} -> ${r.fix}`);
  }
}

async function main() {
  if (!fs.existsSync(CFG.chrome)) {
    console.error(`Chrome not found at ${CFG.chrome} - pass --chrome=<path>.`);
    process.exit(64);
  }

  try {
    const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    console.error(`Cannot reach ${BASE} - start the dev server first. (${message(err)})`);
    process.exit(1);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(PROFILE_ROOT, "lighthook-visual-profile-"));

  console.log(`Lighthook visual QA - ${BASE}`);
  console.log(`Screenshots: ${SHOT_DIR}`);
  console.log("");

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CFG.chrome,
      headless: !CFG.headed,
      userDataDir: profileDir,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-extensions",
        "--mute-audio",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
      ],
      defaultViewport: { width: 1440, height: 950 },
    });

    page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(45_000);
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

    page.on("popup", (popup) => {
      popup.close().catch(() => {});
    });
    page.on("pageerror", (err) => {
      const line = `pageerror: ${message(err)}`;
      if (!diagnostics.includes(line)) diagnostics.push(line);
    });

    await clearStorage();

    /* --- guest phase: profiles (notice) + admin login, per viewport --- */
    const guestPages = PAGES.filter((p) => p.id === "profiles" || p.id === "admin");
    for (const vp of VIEWPORTS) {
      for (const spec of guestPages) {
        if (CFG.only && spec.id !== CFG.only) continue;
        if (spec.onlyWidths && !spec.onlyWidths.includes(vp.width)) continue;
        await runPage(spec, vp);
      }
    }

    /* --- one-time sign-in, then the guarded routes --- */
    const guestOnly = CFG.only === "profiles" || CFG.only === "admin";
    if (!guestOnly) {
      await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 1 });
      await goto("/profiles", ".profiles-page", 30_000);
      await dismissNotice();
      await unlockSam();

      /* First-open home (notice still above the shelf) at 360 only. */
      if (!CFG.only || CFG.only === "home" || CFG.only === "home-notice") {
        for (const spec of PAGES.filter((p) => p.id === "home-notice")) {
          await runPage(spec, VIEWPORTS[0]);
          await dismissNotice();
        }
      }

      /* --- main sweep --- */
      const authPages = PAGES.filter(
        (p) => !["profiles", "admin", "home-notice"].includes(p.id),
      );
      for (const vp of VIEWPORTS) {
        for (const spec of authPages) {
          if (CFG.only && spec.id !== CFG.only) continue;
          if (spec.onlyWidths && !spec.onlyWidths.includes(vp.width)) continue;
          await runPage(spec, vp);
        }
      }
    }
  } catch (err) {
    console.error(`Run aborted: ${message(err)}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
    } catch {
      diagnostics.push(`Could not remove temp profile ${profileDir}`);
    }
  }

  const defects = dedupe(allDefects).sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return a.pageId.localeCompare(b.pageId) || a.viewport.localeCompare(b.viewport);
  });

  console.log("");
  if (!defects.length) {
    console.log("No defects found at any viewport.");
  } else {
    printTable(defects);
    console.log("");
    printFixes(defects);
  }

  const counts = { BLOCKER: 0, MAJOR: 0, MINOR: 0, INFO: 0, SKIP: 0 };
  for (const d of defects) counts[d.severity] += 1;
  console.log("");
  console.log(
    `Summary: ${defects.length} findings - ${counts.BLOCKER} blocker, ${counts.MAJOR} major, ${counts.MINOR} minor, ${counts.INFO} info, ${counts.SKIP} skip`,
  );
  console.log(`Screenshots (${shotCount}): ${SHOT_DIR}`);

  if (diagnostics.length) {
    console.log("Runtime diagnostics:");
    for (const line of diagnostics.slice(0, 12)) console.log(`  - ${line}`);
  }

  const report = {
    base: BASE,
    createdAt,
    viewports: VIEWPORTS.map((v) => v.name),
    shotDir: SHOT_DIR,
    counts,
    defects,
    measurements: allMeasurements,
  };
  const reportFile = path.join(SHOT_DIR, "report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");
  console.log(`Report: ${reportFile}`);

  process.exitCode = counts.BLOCKER > 0 ? 1 : 0;
}

await main();
