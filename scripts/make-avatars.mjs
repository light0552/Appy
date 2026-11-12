#!/usr/bin/env node
/**
 * Build the two screen-avatar images from the supplied cat photographs.
 *
 *   node scripts/make-avatars.mjs
 *
 * Writes 256×256 WebP crops into public/brand. Chrome does the scaling and
 * WebP encoding so the app ships small, crisp avatars without a native
 * image-processing dependency.
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = "E:\\OPENCODE\\RECODE";
const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const jobs = [
  {
    src: "C:\\Users\\LIGHTHOOK\\Desktop\\4e3096083f90006885505a8e30d7e6e27aad4b52_full.jpg",
    out: path.join(ROOT, "public", "brand", "avatar-ginger.webp"),
    mime: "image/jpeg",
  },
  {
    src: "C:\\Users\\LIGHTHOOK\\Desktop\\905196889_980839158437267_6720404281085077723_n.webp",
    out: path.join(ROOT, "public", "brand", "avatar-black.webp"),
    mime: "image/webp",
  },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();

for (const job of jobs) {
  if (!fs.existsSync(job.src)) {
    console.error(`missing source: ${job.src}`);
    process.exitCode = 1;
    continue;
  }
  const data = `data:${job.mime};base64,${fs.readFileSync(job.src).toString("base64")}`;
  const encoded = await page.evaluate(
    async ({ data, size }) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(size / image.width, size / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      ctx.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
      return canvas.toDataURL("image/webp", 0.88);
    },
    { data, size: 256 },
  );
  const buffer = Buffer.from(encoded.split(",")[1], "base64");
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  fs.writeFileSync(job.out, buffer);
  console.log(`${path.basename(job.out)}  ${buffer.length} bytes`);
}

await browser.close();
