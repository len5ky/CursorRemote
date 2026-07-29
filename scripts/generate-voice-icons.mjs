#!/usr/bin/env node
// Generates the Private voice PWA icons. Run when the mark or palette changes:
//   node scripts/generate-voice-icons.mjs
//
// Pure Node + zlib so the build has no image toolchain dependency. Draws a
// rounded-square background with a centred microphone glyph.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');

const BG = [16, 18, 21, 255];        // #101215
const FG = [231, 234, 238, 255];     // #e7eaee
const ACCENT = [47, 125, 79, 255];   // #2f7d4f

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param size    output edge length in px
 * @param safe    fraction of the edge the glyph may occupy (maskable icons
 *                must stay inside the ~80% safe zone)
 * @param rounded whether to round the background corners
 */
function drawIcon(size, safe, rounded) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const radius = rounded ? size * 0.22 : 0;

  const put = (x, y, rgba) => {
    const i = (y * size + x) * 4;
    px[i] = rgba[0]; px[i + 1] = rgba[1]; px[i + 2] = rgba[2]; px[i + 3] = rgba[3];
  };

  const insideRounded = (x, y) => {
    if (!rounded) return true;
    const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
    const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
    return dx * dx + dy * dy <= radius * radius;
  };

  // Microphone geometry, scaled into the safe zone.
  const s = size * safe;
  const capsuleW = s * 0.30;
  const capsuleH = s * 0.50;
  const capsuleTop = c - s * 0.34;
  const capsuleR = capsuleW / 2;
  const archR = s * 0.30;
  const archThick = s * 0.065;
  const archCy = c - s * 0.02;
  const stemH = s * 0.16;
  const baseW = s * 0.34;
  const baseThick = s * 0.065;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!insideRounded(x, y)) { put(x, y, [0, 0, 0, 0]); continue; }
      put(x, y, BG);

      const dx = x - c;
      const dy = y - capsuleTop;

      // Capsule body.
      let inCapsule = false;
      if (Math.abs(dx) <= capsuleR) {
        if (dy >= capsuleR && dy <= capsuleH - capsuleR) inCapsule = true;
        else if (dy < capsuleR && dx * dx + (dy - capsuleR) ** 2 <= capsuleR * capsuleR) inCapsule = true;
        else if (dy > capsuleH - capsuleR && dx * dx + (dy - (capsuleH - capsuleR)) ** 2 <= capsuleR * capsuleR) inCapsule = true;
      }
      if (inCapsule) { put(x, y, ACCENT); continue; }

      // Pickup arch (lower half ring).
      const ay = y - archCy;
      const d = Math.sqrt(dx * dx + ay * ay);
      if (ay >= 0 && Math.abs(d - archR) <= archThick / 2) { put(x, y, FG); continue; }

      // Stem.
      const stemTop = archCy + archR;
      if (Math.abs(dx) <= archThick / 2 && y >= stemTop && y <= stemTop + stemH) { put(x, y, FG); continue; }

      // Base bar.
      const baseY = stemTop + stemH;
      if (Math.abs(dx) <= baseW / 2 && Math.abs(y - baseY) <= baseThick / 2) put(x, y, FG);
    }
  }
  return px;
}

const targets = [
  { file: 'voice-icon-192.png', size: 192, safe: 0.86, rounded: true },
  { file: 'voice-icon-512.png', size: 512, safe: 0.86, rounded: true },
  // Maskable: full bleed background, glyph inside the safe zone.
  { file: 'voice-icon-maskable-512.png', size: 512, safe: 0.62, rounded: false },
];

for (const t of targets) {
  const png = encodePng(t.size, drawIcon(t.size, t.safe, t.rounded));
  writeFileSync(resolve(OUT_DIR, t.file), png);
  console.log(`wrote ${t.file} (${t.size}x${t.size}, ${png.length} bytes)`);
}
