// Paints the app icon and splash screens from the cozy pixel scene (src/ui/cozy-scene.ts) and writes
// every size the web app, Android and iOS need. Pixels are scaled up whole, so they stay crisp.
// Run: npx vite-node scripts/make-icons.ts
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { movingPixels, paintScene, SCENE_H, SCENE_W } from '../src/ui/cozy-scene';

const BG = [0x1a, 0x12, 0x18];

// ---- PNG
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const sizeOf = (file: string): [number, number] => {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

// ---- One frame of the scene: the still picture with rain, leaves, lights and steam on it.
const scene = paintScene(0.5);
movingPixels(2.3, (x, y, c) => {
  if (x < 0 || y < 0 || x >= SCENE_W || y >= SCENE_H) return;
  const o = (y * SCENE_W + x) * 4;
  scene[o] = c[0];
  scene[o + 1] = c[1];
  scene[o + 2] = c[2];
});
const at = (x: number, y: number): number[] => {
  const o = (y * SCENE_W + x) * 4;
  return [scene[o], scene[o + 1], scene[o + 2]];
};

/**
 * A w×h picture: the scene's square from row `top` (side `side` scene pixels), scaled to fill
 * `fill` of the shorter side, centred on the background colour. Nearest pixel: crisp.
 */
function render(w: number, h: number, opts: { top: number; side: number; fill: number }): Buffer {
  const out = Buffer.alloc(w * h * 4);
  const box = Math.min(w, h) * opts.fill;
  const k = box / opts.side;
  const ox = (w - box) / 2;
  const oy = (h - box) / 2;
  const left = (SCENE_W - opts.side) / 2;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const sx = Math.floor((px - ox) / k + left);
      const sy = Math.floor((py - oy) / k + opts.top);
      const inside = px >= ox && px < ox + box && py >= oy && py < oy + box && sx >= 0 && sx < SCENE_W && sy >= 0 && sy < SCENE_H;
      const c = inside ? at(sx, sy) : BG;
      const o = (py * w + px) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  return png(w, h, out);
}

const write = (file: string, buf: Buffer): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, buf);
  console.log(file);
};

// The icon: the bottom of the window, the fairy lights, the cat asleep and the coffee.
const ICON = { top: 30, side: 96, fill: 1 };
// Phones crop round icons and adaptive icons to their middle: show a little less, a little bigger.
const TIGHT = { top: 44, side: 72, fill: 1 };

write('public/icons/icon-512.png', render(512, 512, ICON));
write('public/icons/icon-192.png', render(192, 192, ICON));
write('public/icons/apple-touch-icon.png', render(180, 180, ICON));
write('public/icons/icon-maskable-512.png', render(512, 512, TIGHT));

const RES = 'android/app/src/main/res';
if (existsSync(RES)) {
  const dpis: Record<string, number> = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [dpi, k] of Object.entries(dpis)) {
    write(`${RES}/mipmap-${dpi}/ic_launcher.png`, render(48 * k, 48 * k, ICON));
    write(`${RES}/mipmap-${dpi}/ic_launcher_round.png`, render(48 * k, 48 * k, TIGHT));
    // Adaptive foreground: 108dp, of which only the middle 72 is sure to show.
    write(`${RES}/mipmap-${dpi}/ic_launcher_foreground.png`, render(108 * k, 108 * k, { top: 26, side: 96, fill: 1 }));
  }
  writeFileSync(`${RES}/values/ic_launcher_background.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1A1218</color>\n</resources>\n');
  for (const dir of readdirSync(RES)) {
    const f = `${RES}/${dir}/splash.png`;
    if (!existsSync(f)) continue;
    const [w, h] = sizeOf(f);
    write(f, render(w, h, { top: 26, side: 96, fill: 0.45 }));
  }
}

const IOS = 'ios/App/App/Assets.xcassets';
if (existsSync(IOS)) {
  write(`${IOS}/AppIcon.appiconset/AppIcon-512@2x.png`, render(1024, 1024, ICON));
  for (const f of readdirSync(`${IOS}/Splash.imageset`).filter((n) => n.endsWith('.png'))) {
    write(`${IOS}/Splash.imageset/${f}`, render(2732, 2732, { top: 26, side: 96, fill: 0.3 }));
  }
}
