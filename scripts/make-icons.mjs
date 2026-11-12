#!/usr/bin/env node
/**
 * LIGHTHOOK — icon set from the supplied cat photograph.
 *
 *   node scripts/make-icons.mjs
 *
 * Renders the source photo on the house's warm midnight background with
 * Chrome (puppeteer-core), then writes:
 *
 *   public/icons/icon-192.png         192  any
 *   public/icons/icon-512.png         512  any
 *   public/icons/maskable-512.png     512  maskable (art inside the safe zone)
 *   public/icons/apple-touch-icon.png 180  iOS home screen
 *   public/icons/favicon.svg          64   vector wrapper with embedded photo
 *
 * No image-processing dependency: Chrome does the compositing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ICON_DIR = path.join(ROOT, "public", "icons");
const SOURCE = path.join(ROOT, "public", "brand", "lighthook-cat.jpg");
const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const BG = "#0a0806";
const ACCENT = "#e9a05a";

if (!fs.existsSync(SOURCE)) {
  console.error(`Missing brand photo: ${SOURCE}`);
  process.exit(1);
}
if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  process.exit(1);
}

const photo = `data:image/jpeg;base64,${fs.readFileSync(SOURCE).toString("base64")}`;
fs.mkdirSync(ICON_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=1"],
});

const page = await browser.newPage();

async function render(size, html, file) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><head><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: ${size}px; height: ${size}px; overflow: hidden; background: ${BG}; }
      .icon { position: relative; width: ${size}px; height: ${size}px; display: grid; place-items: center; background: ${BG}; }
      .icon::before {
        content: ""; position: absolute; inset: 0;
        background:
          radial-gradient(120% 86% at 50% -10%, rgba(233,160,90,.22), transparent 62%),
          radial-gradient(90% 70% at 80% 110%, rgba(120,58,30,.22), transparent 70%);
      }
      img { position: relative; display: block; object-fit: cover; }
    </style></head><body><div class="icon">${html}</div></body></html>`,
    { waitUntil: "load" },
  );
  await page.screenshot({ path: path.join(ICON_DIR, file), type: "png" });
  const stat = fs.statSync(path.join(ICON_DIR, file));
  console.log(`  ${file.padEnd(22)} ${size}x${size}  ${String(stat.size).padStart(7)} B`);
}

console.log("LIGHTHOOK icon set (cat photograph)");

// Full-bleed square icons: the photo is already a square portrait.
await render(
  512,
  `<img src="${photo}" width="512" height="512" style="border-radius:0" alt="">`,
  "icon-512.png",
);
await render(
  192,
  `<img src="${photo}" width="192" height="192" style="border-radius:0" alt="">`,
  "icon-192.png",
);
await render(
  180,
  `<img src="${photo}" width="180" height="180" style="border-radius:0" alt="">`,
  "apple-touch-icon.png",
);

// Maskable: the photo sits in a round seal, well inside the 80% safe zone.
await render(
  512,
  `<img src="${photo}" width="332" height="332"
        style="border-radius:50%; box-shadow: 0 0 0 8px rgba(233,160,90,.22), 0 24px 80px rgba(0,0,0,.6)" alt="">`,
  "maskable-512.png",
);

// Favicon: an SVG wrapper so the tab keeps a crisp ring at every size.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="LIGHTH00K">
  <title>LIGHTH00K</title>
  <defs>
    <clipPath id="seal"><circle cx="32" cy="32" r="29"/></clipPath>
    <radialGradient id="lamp" cx="50%" cy="0%" r="90%">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity=".34"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="${BG}"/>
  <rect width="64" height="64" rx="16" fill="url(#lamp)"/>
  <circle cx="32" cy="32" r="30.5" fill="none" stroke="${ACCENT}" stroke-opacity=".55" stroke-width="1.5"/>
  <image href="${photo}" x="3" y="3" width="58" height="58" clip-path="url(#seal)" preserveAspectRatio="xMidYMid slice"/>
</svg>
`;
fs.writeFileSync(path.join(ICON_DIR, "favicon.svg"), svg);
console.log(`  favicon.svg            64x64  ${String(Buffer.byteLength(svg)).padStart(7)} B`);

await browser.close();
console.log(`done -> ${ICON_DIR}`);
