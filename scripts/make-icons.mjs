// Draws the app icon and splash screens (a sprayed vinyl record with paint running off it) and
// writes every size the web app, Android and iOS need. No image tools needed: plain Node.
// Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BG = [0x14, 0x12, 0x17];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const STOPS = ['#ffb000', '#ff6a3d', '#ff3d7f'].map(hex);
const DRIP = hex('#e02a6a');
const TEAL = hex('#29c9b4');

// ---- PNG
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const sizeOf = (file) => {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

// ---- The picture, in units where the shorter side is 1 and the centre is (0, 0).
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function paint(x, y, r) {
  // r: radius of the record. Returns [rgb, alpha] or null (background).
  const cy = -0.06 * (r / 0.34);
  const dx = x;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d < r) {
    if (d < 0.05 * r) return null; // the hole
    if (d < 0.27 * r) return [BG, 1]; // label
    if (d < 0.31 * r) return [TEAL, 1]; // ring round the label
    const t = Math.min(1, Math.max(0, (x + y) / (2 * r) + 0.5));
    let c = t < 0.5 ? mix(STOPS[0], STOPS[1], t * 2) : mix(STOPS[1], STOPS[2], (t - 0.5) * 2);
    const g = ((d / r) * 16) % 1;
    if (d > 0.4 * r && d < 0.96 * r && g < 0.16) c = c.map((v) => v * 0.82); // grooves
    const a = Math.atan2(dy, dx);
    const shine = Math.pow(Math.max(0, Math.cos(a + 2.3)), 10) * 0.22 + Math.pow(Math.max(0, Math.cos(a - 0.85)), 10) * 0.12;
    c = mix(c, [255, 255, 255], shine);
    return [c, 1];
  }
  // Paint running off the bottom of the record: [offset across, how far it runs, width].
  for (const [ox, run, w] of [
    [-0.4, 0.42, 0.13],
    [0.1, 0.26, 0.11],
    [0.48, 0.14, 0.09],
  ]) {
    const px = ox * r;
    const edge = cy + Math.sqrt(Math.max(0, r * r - px * px));
    const end = edge + run * r;
    const hw = (w * r) / 2;
    // The run widens where it leaves the record, like paint gathering at the edge.
    const flare = hw * (1 + 0.9 * Math.max(0, 1 - (y - edge + 0.1 * r) / (0.16 * r)));
    if (Math.abs(x - px) < flare && y > edge - 0.1 * r && y < end) return [DRIP, 1];
    if (Math.hypot(x - px, y - end) < hw * 1.45) return [DRIP, 1];
  }
  return null;
}

/** Render w×h. `r` = record radius (in units of the shorter side), `bg` = paint the wall behind it. */
function render(w, h, r, bg, ss = 3) {
  const out = Buffer.alloc(w * h * 4);
  const s = Math.min(w, h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let R = 0;
      let G = 0;
      let B = 0;
      let A = 0;
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const x = (px + (i + 0.5) / ss - w / 2) / s;
          const y = (py + (j + 0.5) / ss - h / 2) / s;
          const hit = paint(x, y, r);
          let c = hit ? hit[0] : BG;
          let a = hit ? hit[1] : bg ? 1 : 0;
          if (bg && !hit) {
            // The wall: a soft light from above.
            const l = Math.max(0, 1 - Math.hypot(x, y + 0.25) * 1.4) * 14;
            c = BG.map((v) => v + l);
          }
          R += c[0] * a;
          G += c[1] * a;
          B += c[2] * a;
          A += a;
        }
      }
      const o = (py * w + px) * 4;
      const n = ss * ss;
      out[o] = A ? Math.round(R / A) : 0;
      out[o + 1] = A ? Math.round(G / A) : 0;
      out[o + 2] = A ? Math.round(B / A) : 0;
      out[o + 3] = Math.round((A / n) * 255);
    }
  }
  return png(w, h, out);
}

const write = (file, buf) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, buf);
  console.log(file);
};

// Web app (home-screen icon) + iPhone touch icon.
write('public/icons/icon-512.png', render(512, 512, 0.34, true));
write('public/icons/icon-192.png', render(192, 192, 0.34, true));
write('public/icons/apple-touch-icon.png', render(180, 180, 0.34, true));
// A maskable one: phones crop it to a circle or squircle, so the record sits well inside.
write('public/icons/icon-maskable-512.png', render(512, 512, 0.26, true));

// Android: legacy icons (full picture) and the adaptive foreground (transparent, inside the safe zone).
const RES = 'android/app/src/main/res';
if (existsSync(RES)) {
  for (const [dpi, k] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
    write(`${RES}/mipmap-${dpi}/ic_launcher.png`, render(48 * k, 48 * k, 0.34, true));
    write(`${RES}/mipmap-${dpi}/ic_launcher_round.png`, render(48 * k, 48 * k, 0.3, true));
    write(`${RES}/mipmap-${dpi}/ic_launcher_foreground.png`, render(108 * k, 108 * k, 0.21, false));
  }
  writeFileSync(`${RES}/values/ic_launcher_background.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#141217</color>\n</resources>\n');
  // Splash screens: the wall with a small record in the middle, at the sizes already there.
  for (const dir of readdirSync(RES)) {
    const f = `${RES}/${dir}/splash.png`;
    if (!existsSync(f)) continue;
    const [w, h] = sizeOf(f);
    write(f, render(w, h, 0.12, true, 1));
  }
}

// iOS: the 1024 icon (no transparency allowed) and the splash.
const IOS = 'ios/App/App/Assets.xcassets';
if (existsSync(IOS)) {
  write(`${IOS}/AppIcon.appiconset/AppIcon-512@2x.png`, render(1024, 1024, 0.34, true, 2));
  for (const f of readdirSync(`${IOS}/Splash.imageset`).filter((n) => n.endsWith('.png'))) {
    write(`${IOS}/Splash.imageset/${f}`, render(2732, 2732, 0.1, true, 1));
  }
}
