#!/usr/bin/env node
/**
 * Lighthook — PWA icon generator.
 *
 *   node scripts/make-icons.mjs
 *
 * Writes, into public/icons/:
 *   icon-192.png         192x192  (any)        full-bleed, opaque
 *   icon-512.png         512x512  (any)        full-bleed, opaque
 *   maskable-512.png     512x512  (maskable)   glyph inside the central 60%
 *   apple-touch-icon.png 180x180               full-bleed, opaque
 *   favicon.svg          64x64 vector, rounded corners
 *
 * Zero dependencies: node:fs, node:path, node:zlib only.
 *
 * Rendering: the mark is defined with signed distance fields in a normalised
 * [0,1] design space, sampled 4x4 per output pixel (4x supersampling on both
 * axes) and box-filtered down. PNGs are encoded by hand: 32-bit RGBA, 8-bit,
 * IHDR/IDAT/IEND, CRC32 per chunk, adaptive per-scanline filtering, deflate.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.resolve(HERE, '..', 'public', 'icons');

/* ------------------------------------------------------------------ */
/* palette + tiny maths                                               */
/* ------------------------------------------------------------------ */

const BG = [0x0b, 0x0f, 0x14]; // --bg      #0b0f14
const SURFACE = [0x15, 0x1d, 0x2a]; // --surface-2 #151d2a
const ACCENT = [0x00, 0xac, 0xc1]; // --accent  #00acc1

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ */
/* glyph geometry (design space, 1.0 == icon width, y grows downwards) */
/* ------------------------------------------------------------------ */

const STROKE = 0.072; // thick, rounded stroke
const HW = STROKE / 2;

// Hook: long shank (the "tower"), wide U-bend, short arm, point angling inward.
const SHANK_X = -0.115;
const TOP = { x: SHANK_X, y: -0.26 };
const BEND = { cx: 0.0, cy: 0.07, r: 0.115 };
const ARM_TOP = { x: 0.115, y: -0.055 };
const POINT_R = 0.004;
const LAMP_R = 0.051; // lantern head at the top of the shaft
const ARC_STEPS = 96;

// Point: circular elbow off the arm (the bent-wire look), then a straight
// taper down to a needle tip.
const ELBOW_R = 0.09;
const ELBOW_SWEEP = (30 * Math.PI) / 180;
const POINT_LEN = 0.14;
const ELBOW_CX = ARM_TOP.x - ELBOW_R;
const ELBOW_CY = ARM_TOP.y;
const POINT_TIP = {
  x: ELBOW_CX + ELBOW_R * Math.cos(-ELBOW_SWEEP) + Math.sin(-ELBOW_SWEEP) * POINT_LEN,
  y: ELBOW_CY + ELBOW_R * Math.sin(-ELBOW_SWEEP) - Math.cos(-ELBOW_SWEEP) * POINT_LEN,
};
const POINT = POINT_TIP;

const POINT_CURVE = (() => {
  const out = [];
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const th = -ELBOW_SWEEP * (i / N);
    out.push({ x: ELBOW_CX + ELBOW_R * Math.cos(th), y: ELBOW_CY + ELBOW_R * Math.sin(th), r: HW });
  }
  const end = out[out.length - 1];
  const tx = Math.sin(-ELBOW_SWEEP);
  const ty = -Math.cos(-ELBOW_SWEEP);
  const M = 18;
  for (let i = 1; i <= M; i++) {
    const t = i / M;
    out.push({
      x: end.x + tx * POINT_LEN * t,
      y: end.y + ty * POINT_LEN * t,
      r: POINT_R + (HW - POINT_R) * (1 - t),
    });
  }
  return out;
})();

const HOOK = (() => {
  const pts = [ARM_TOP];
  for (let i = 0; i <= ARC_STEPS; i++) {
    const t = (Math.PI * i) / ARC_STEPS; // right -> bottom -> left
    pts.push({ x: BEND.cx + BEND.r * Math.cos(t), y: BEND.cy + BEND.r * Math.sin(t) });
  }
  pts.push(TOP);
  return pts;
})();

const SEGS = (() => {
  const s = [];
  for (let i = 0; i < HOOK.length - 1; i++) {
    s.push([HOOK[i].x, HOOK[i].y, HOOK[i + 1].x, HOOK[i + 1].y]);
  }
  return s;
})();

// Lighthouse beam: a soft wedge leaving the top of the shank, up and to the left.
const BEAM_DIR = (() => {
  const x = -0.88;
  const y = -0.47;
  const m = Math.hypot(x, y);
  return { x: x / m, y: y / m };
})();
const BEAM_LEN = 0.26;
const BEAM_TAN = Math.tan((13.5 * Math.PI) / 180);
const BEAM_R0 = 0.014; // rounded apex
const BEAM_PEAK = 0.56;
const GLOW_R = 0.24;
const GLOW_PEAK = 0.15;

/** Soft lantern glow around the head of the hook. */
function glowAlpha(x, y) {
  const d = Math.hypot(x - TOP.x, y - TOP.y);
  const t = clamp(1 - d / GLOW_R, 0, 1);
  return GLOW_PEAK * t * t;
}

/** Alpha of the light wedge at a design-space point. */
function beamAlpha(x, y) {
  const vx = x - TOP.x;
  const vy = y - TOP.y;
  const along = vx * BEAM_DIR.x + vy * BEAM_DIR.y;
  if (along < -BEAM_R0 || along > BEAM_LEN) return 0;
  const perp = Math.abs(vx * BEAM_DIR.y - vy * BEAM_DIR.x);
  const halfW = Math.max(0, along) * BEAM_TAN + BEAM_R0;
  // crisp core, very short feather at the angular edge of the cone
  const across = 1 - smoothstep(0.86, 1.0, perp / halfW);
  // full strength out of the lantern, then falling away down the beam
  const fade = 1 - smoothstep(0.32, 1.0, along / BEAM_LEN);
  return BEAM_PEAK * across * fade;
}

/** Approximate signed distance to a capsule whose radius tapers from ra to rb. */
function taperedSDF(x, y, ax, ay, bx, by, ra, rb) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return Math.hypot(dx, dy) - (ra + (rb - ra) * t);
}

/** Signed distance to the hook stroke (capsule union == round caps + joins). */
function hookSDF(x, y) {
  let best = Infinity;
  for (let i = 0; i < SEGS.length; i++) {
    const s = SEGS[i];
    const vx = s[2] - s[0];
    const vy = s[3] - s[1];
    const wx = x - s[0];
    const wy = y - s[1];
    const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
    const dx = wx - vx * t;
    const dy = wy - vy * t;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  const stroke = Math.sqrt(best) - HW;
  let sdf = stroke;
  const lamp = Math.hypot(x - TOP.x, y - TOP.y) - LAMP_R;
  if (lamp < sdf) sdf = lamp;
  for (let i = 0; i < POINT_CURVE.length - 1; i++) {
    const a = POINT_CURVE[i];
    const b = POINT_CURVE[i + 1];
    const d = taperedSDF(x, y, a.x, a.y, b.x, b.y, a.r, b.r);
    if (d < sdf) sdf = d;
  }
  return sdf;
}

/* ------------------------------------------------------------------ */
/* bounding box -> automatic optical centring                          */
/* ------------------------------------------------------------------ */

const BEAM_TIP = {
  x: TOP.x + BEAM_DIR.x * BEAM_LEN,
  y: TOP.y + BEAM_DIR.y * BEAM_LEN,
};
const BEAM_HW = BEAM_LEN * BEAM_TAN + BEAM_R0;
const BEAM_N = { x: -BEAM_DIR.y, y: BEAM_DIR.x };
const BEAM_CORNERS = [
  BEAM_TIP,
  { x: BEAM_TIP.x + BEAM_N.x * BEAM_HW, y: BEAM_TIP.y + BEAM_N.y * BEAM_HW },
  { x: BEAM_TIP.x - BEAM_N.x * BEAM_HW, y: BEAM_TIP.y - BEAM_N.y * BEAM_HW },
];

const BOUNDS = (() => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const p of HOOK) {
    add(p.x - HW, p.y - HW);
    add(p.x + HW, p.y + HW);
  }
  add(POINT.x - POINT_R, POINT.y - POINT_R);
  add(POINT.x + POINT_R, POINT.y + POINT_R);
  add(TOP.x - LAMP_R, TOP.y - LAMP_R);
  add(TOP.x + LAMP_R, TOP.y + LAMP_R);
  for (const p of POINT_CURVE) {
    add(p.x - p.r, p.y - p.r);
    add(p.x + p.r, p.y + p.r);
  }
  for (const p of BEAM_CORNERS) add(p.x, p.y);
  return { minX, minY, maxX, maxY };
})();

// Recentre the whole mark on the canvas, then nudge it slightly off-centre
// for the non-maskable icons (a small optical lift, right and up).
const CENTER = {
  x: -(BOUNDS.minX + BOUNDS.maxX) / 2,
  y: -(BOUNDS.minY + BOUNDS.maxY) / 2,
};
const HALF_W = (BOUNDS.maxX - BOUNDS.minX) / 2;
const HALF_H = (BOUNDS.maxY - BOUNDS.minY) / 2;

const ANY_SCALE = 1.0;
const ANY_NUDGE = { x: 0.008, y: -0.006 };
// Maskable: everything (including the beam tip) inside the central 60% square.
const MASK_SCALE = Math.min(0.98, (0.3 * 0.985) / Math.max(HALF_W, HALF_H));

/* ------------------------------------------------------------------ */
/* background + compositing                                            */
/* ------------------------------------------------------------------ */

function background(nx, ny) {
  // Subtle radial lift toward #151d2a centred in the upper area.
  // nx/ny are normalised to [-0.5, 0.5] across the icon.
  const dx = nx;
  const dy = ny + 0.25;
  const d = Math.hypot(dx, dy);
  const t = clamp(1 - d / 0.86, 0, 1);
  const w = smoothstep(0, 1, t) * 0.96;
  return [
    BG[0] + (SURFACE[0] - BG[0]) * w,
    BG[1] + (SURFACE[1] - BG[1]) * w,
    BG[2] + (SURFACE[2] - BG[2]) * w,
  ];
}

const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/* ------------------------------------------------------------------ */
/* renderer                                                            */
/* ------------------------------------------------------------------ */

function renderIcon(size, scale, nudge) {
  const SS = 4; // 4x supersampling per axis -> 16 samples per output pixel
  const inv = 1 / size;
  const invScale = 1 / scale;
  const pxD = inv / SS / scale; // design units per subsample
  const data = Buffer.alloc(size * size * 4);

  // design-space bounds of the two effect layers
  const glyphBox = { minX: BOUNDS.minX, minY: BOUNDS.minY, maxX: BOUNDS.maxX, maxY: BOUNDS.maxY };
  const fxBox = {
    minX: Math.min(BEAM_CORNERS[0].x, BEAM_CORNERS[1].x, BEAM_CORNERS[2].x, TOP.x - GLOW_R),
    minY: Math.min(BEAM_CORNERS[0].y, BEAM_CORNERS[1].y, BEAM_CORNERS[2].y, TOP.y - GLOW_R),
    maxX: Math.max(BEAM_CORNERS[0].x, BEAM_CORNERS[1].x, BEAM_CORNERS[2].x, TOP.x + GLOW_R),
    maxY: Math.max(BEAM_CORNERS[0].y, BEAM_CORNERS[1].y, BEAM_CORNERS[2].y, TOP.y + GLOW_R),
  };

  // design -> screen -> pixel-index ranges (with a small margin)
  const toPx = (box) => {
    const x0 = ((box.minX + CENTER.x) * scale + nudge.x + 0.5) * size;
    const x1 = ((box.maxX + CENTER.x) * scale + nudge.x + 0.5) * size;
    const y0 = ((box.minY + CENTER.y) * scale + nudge.y + 0.5) * size;
    const y1 = ((box.maxY + CENTER.y) * scale + nudge.y + 0.5) * size;
    return {
      x0: Math.max(0, Math.floor(x0) - 2),
      x1: Math.min(size - 1, Math.ceil(x1) + 2),
      y0: Math.max(0, Math.floor(y0) - 2),
      y1: Math.min(size - 1, Math.ceil(y1) + 2),
    };
  };
  const gpx = toPx(glyphBox);
  const fpx = toPx(fxBox);

  for (let py = 0; py < size; py++) {
    const ny = (py + 0.5) * inv - 0.5;
    const rowInGlyph = py >= gpx.y0 && py <= gpx.y1;
    const rowInFx = py >= fpx.y0 && py <= fpx.y1;

    for (let px = 0; px < size; px++) {
      const nx = (px + 0.5) * inv - 0.5;
      const bg = background(nx, ny);
      let sr = 0;
      let sg = 0;
      let sb = 0;

      const doFx = rowInFx && px >= fpx.x0 && px <= fpx.x1;
      const doGlyph = rowInGlyph && px >= gpx.x0 && px <= gpx.x1;

      if (!doFx && !doGlyph) {
        // background is flat at this scale: all 16 subsamples are identical
        sr = bg[0];
        sg = bg[1];
        sb = bg[2];
      } else {
        for (let sy = 0; sy < SS; sy++) {
          const syn = (py + (sy + 0.5) / SS) * inv - 0.5;
          const dy = (syn - nudge.y) * invScale - CENTER.y;
          for (let sx = 0; sx < SS; sx++) {
            const sxn = (px + (sx + 0.5) / SS) * inv - 0.5;
            const dx = (sxn - nudge.x) * invScale - CENTER.x;

            let r = bg[0];
            let g = bg[1];
            let b = bg[2];

            if (doFx) {
              const a = 1 - (1 - beamAlpha(dx, dy)) * (1 - glowAlpha(dx, dy));
              if (a > 0) {
                r += (ACCENT[0] - r) * a;
                g += (ACCENT[1] - g) * a;
                b += (ACCENT[2] - b) * a;
              }
            }
            if (doGlyph) {
              const cov = clamp(0.5 - hookSDF(dx, dy) / pxD, 0, 1);
              if (cov > 0) {
                r += (ACCENT[0] - r) * cov;
                g += (ACCENT[1] - g) * cov;
                b += (ACCENT[2] - b) * cov;
              }
            }

            sr += r;
            sg += g;
            sb += b;
          }
        }
        sr /= 16;
        sg /= 16;
        sb /= 16;
      }

      // ordered dither so the dark gradient does not band in 8-bit
      const dth = (BAYER[py & 7][px & 7] / 63 - 0.5) * 0.9;
      const o = (py * size + px) * 4;
      data[o] = clamp(Math.round(sr + dth), 0, 255);
      data[o + 1] = clamp(Math.round(sg + dth), 0, 255);
      data[o + 2] = clamp(Math.round(sb + dth), 0, 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* PNG encoder (32-bit RGBA, no dependencies)                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, body])), 0);
  return Buffer.concat([len, tag, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterScanlines(rgba, width, height) {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const prev = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  const cand = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    let bestType = 0;
    let bestScore = Infinity;

    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        const up = prev[i];
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (type === 1) pred = left;
        else if (type === 2) pred = up;
        else if (type === 3) pred = (left + up) >> 1;
        else if (type === 4) pred = paeth(left, up, upLeft);
        const v = (cur[i] - pred) & 0xff;
        cand[i] = v;
        score += v < 128 ? v : 256 - v;
        if (score >= bestScore) break; // early out: cannot win
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        cand.copy(best);
      }
    }

    out[y * (stride + 1)] = bestType;
    best.copy(out, y * (stride + 1) + 1);
    cur.copy(prev);
  }
  return out;
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const raw = filterScanlines(rgba, width, height);
  const idat = zlib.deflateSync(raw, { level: 9, memLevel: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Read a PNG back and confirm signature, chunk CRCs, dimensions and payload. */
function inspectPNG(buf) {
  const sigOk = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let crcOk = true;
  const idat = [];
  let sawIEND = false;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    const want = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== want) crcOk = false;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      sawIEND = true;
    }
    off += 12 + len;
  }
  let inflated = 0;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idat)).length;
  } catch {
    inflated = -1;
  }
  return {
    sigOk,
    crcOk,
    sawIEND,
    width,
    height,
    bitDepth,
    colorType,
    inflated,
    expected: (width * 4 + 1) * height,
  };
}

/* ------------------------------------------------------------------ */
/* favicon.svg                                                         */
/* ------------------------------------------------------------------ */

function buildSVG() {
  const S = 64;
  const map = (p) => {
    const x = (p.x + CENTER.x) * ANY_SCALE + ANY_NUDGE.x;
    const y = (p.y + CENTER.y) * ANY_SCALE + ANY_NUDGE.y;
    return [(x + 0.5) * S, (y + 0.5) * S];
  };
  const n2 = (v) => Number(v.toFixed(2));
  const pt = (p) => {
    const [x, y] = map(p);
    return `${n2(x)} ${n2(y)}`;
  };

  const right = { x: BEND.cx + BEND.r, y: BEND.cy };
  const left = { x: BEND.cx - BEND.r, y: BEND.cy };
  const r = n2(BEND.r * ANY_SCALE * S);
  const sw = n2(STROKE * ANY_SCALE * S);

  const hookPath = [
    `M ${pt(ARM_TOP)}`,
    `L ${pt(right)}`,
    `A ${r} ${r} 0 0 1 ${pt(left)}`,
    `L ${pt(TOP)}`,
  ].join(' ');

  // tapered point: outline of the curve, offset by its local radius
  const leftSide = [];
  const rightSide = [];
  for (let i = 0; i < POINT_CURVE.length; i++) {
    const p = POINT_CURVE[i];
    const prev = POINT_CURVE[Math.max(0, i - 1)];
    const next = POINT_CURVE[Math.min(POINT_CURVE.length - 1, i + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tm = Math.hypot(tx, ty) || 1;
    const nx = -ty / tm;
    const ny = tx / tm;
    leftSide.push([p.x + nx * p.r, p.y + ny * p.r]);
    rightSide.push([p.x - nx * p.r, p.y - ny * p.r]);
  }
  const outline = [...leftSide, ...rightSide.reverse()];
  const barb = `M ${outline.map(([x, y]) => pt({ x, y })).join(' L ')} Z`;

  const apex = map(TOP);
  const tip = map(BEAM_TIP);
  const c1 = map(BEAM_CORNERS[1]);
  const c2 = map(BEAM_CORNERS[2]);
  const beamPath = `M ${n2(apex[0])} ${n2(apex[1])} L ${n2(c1[0])} ${n2(c1[1])} L ${n2(c2[0])} ${n2(c2[1])} Z`;

  const glowR = n2(GLOW_R * ANY_SCALE * S);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="Lighthook">
  <title>Lighthook</title>
  <defs>
    <radialGradient id="bg" cx="${n2(S * 0.5)}" cy="${n2(S * 0.25)}" r="${n2(S * 0.86)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#151d2a"/>
      <stop offset="1" stop-color="#0b0f14"/>
    </radialGradient>
    <linearGradient id="beam" x1="${n2(apex[0])}" y1="${n2(apex[1])}" x2="${n2(tip[0])}" y2="${n2(tip[1])}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#00acc1" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#00acc1" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="${n2(apex[0])}" cy="${n2(apex[1])}" r="${glowR}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#00acc1" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#00acc1" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${S}" height="${S}" rx="15" fill="url(#bg)"/>
  <circle cx="${n2(apex[0])}" cy="${n2(apex[1])}" r="${glowR}" fill="url(#glow)"/>
  <path d="${beamPath}" fill="url(#beam)"/>
  <path d="${barb}" fill="#00acc1"/>
  <circle cx="${n2(map(TOP)[0])}" cy="${n2(map(TOP)[1])}" r="${n2(LAMP_R * ANY_SCALE * S)}" fill="#00acc1"/>
  <path d="${hookPath}" fill="none" stroke="#00acc1" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

fs.mkdirSync(ICON_DIR, { recursive: true });

const jobs = [
  { file: 'icon-192.png', size: 192, scale: ANY_SCALE, nudge: ANY_NUDGE },
  { file: 'icon-512.png', size: 512, scale: ANY_SCALE, nudge: ANY_NUDGE },
  { file: 'maskable-512.png', size: 512, scale: MASK_SCALE, nudge: { x: 0, y: 0 } },
  { file: 'apple-touch-icon.png', size: 180, scale: ANY_SCALE, nudge: ANY_NUDGE },
];

console.log('Lighthook icon set');
console.log(`  design bounds  x[${BOUNDS.minX.toFixed(3)}, ${BOUNDS.maxX.toFixed(3)}]  y[${BOUNDS.minY.toFixed(3)}, ${BOUNDS.maxY.toFixed(3)}]`);
console.log(`  scales         any ${ANY_SCALE}  maskable ${MASK_SCALE.toFixed(3)}`);

for (const job of jobs) {
  const rgba = renderIcon(job.size, job.scale, job.nudge);
  const png = encodePNG(job.size, job.size, rgba);
  const out = path.join(ICON_DIR, job.file);
  fs.writeFileSync(out, png);
  const info = inspectPNG(png);
  const ok =
    info.sigOk &&
    info.crcOk &&
    info.sawIEND &&
    info.width === job.size &&
    info.height === job.size &&
    info.bitDepth === 8 &&
    info.colorType === 6 &&
    info.inflated === info.expected;
  if (!ok) {
    console.error('  FAILED verification', job.file, info);
    process.exitCode = 1;
  }
  console.log(
    `  ${job.file.padEnd(21)} ${String(info.width).padStart(4)}x${String(info.height).padEnd(4)} RGBA8  ` +
      `${String(png.length).padStart(7)} B  crc:${info.crcOk ? 'ok' : 'BAD'} idat:${info.inflated === info.expected ? 'ok' : 'BAD'}`
  );
}

const svg = buildSVG();
const svgFile = path.join(ICON_DIR, 'favicon.svg');
fs.writeFileSync(svgFile, svg, 'utf8');
console.log(`  favicon.svg           64x64  vector   ${String(Buffer.byteLength(svg)).padStart(7)} B`);

// maskable safe-zone proof: every glyph extreme must sit inside the central 60%
const maskExtent = Math.max(
  Math.abs((BOUNDS.minX + CENTER.x) * MASK_SCALE),
  Math.abs((BOUNDS.maxX + CENTER.x) * MASK_SCALE),
  Math.abs((BOUNDS.minY + CENTER.y) * MASK_SCALE),
  Math.abs((BOUNDS.maxY + CENTER.y) * MASK_SCALE)
);
console.log(
  `  maskable reach ${(maskExtent * 100).toFixed(1)}% of width from centre (safe zone limit 30.0%) ` +
    `${maskExtent <= 0.3 ? 'ok' : 'OUT OF SAFE ZONE'}`
);
if (maskExtent > 0.3) process.exitCode = 1;

console.log(`done -> ${ICON_DIR}`);
