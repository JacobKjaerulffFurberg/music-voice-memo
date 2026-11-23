/**
 * Dev tool: paints the app icons and splash screens from the rainy-window scene and sends them to
 * scripts/icons-server.mjs, which writes them into the project. Not part of the app.
 * Run in the console of the dev page:  (await import('/src/dev/icons.ts')).makeIcons()
 */
import { RainScene } from '../ui/rain-scene';

const SERVER = '/__icons'; // the dev server passes this on to scripts/icons-server.mjs
const BG = '#121117';

/** The scene painted portrait (3:4) at width `w`, a moment into the rain. */
function scene(w: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = Math.round((w * 4) / 3);
  new RainScene(c.width, c.height).draw(c.getContext('2d') as CanvasRenderingContext2D, 2.4);
  return c;
}

type Crop = 'icon' | 'tight' | 'splash';

/** A w×h PNG. icon: the lower window, the tea, the sill. tight: closer on the cup (round/adaptive masks). splash: the whole scene, small, on the dark. */
function render(w: number, h: number, crop: Crop): Promise<Blob> {
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const c = out.getContext('2d') as CanvasRenderingContext2D;
  c.imageSmoothingQuality = 'high';
  c.fillStyle = BG;
  c.fillRect(0, 0, w, h);
  if (crop === 'splash') {
    const sw = Math.round(Math.min(w, h) * 0.42);
    const src = scene(sw * 2);
    const sh = (sw * 4) / 3;
    c.drawImage(src, (w - sw) / 2, (h - sh) / 2, sw, sh);
  } else {
    const side = Math.max(w, h);
    const src = scene(Math.max(512, side * 2));
    const W = src.width;
    const H = src.height;
    // icon: a square from the bottom of the picture; tight: a smaller square around the cup.
    const [sx, sy, ss] = crop === 'icon' ? [0, H - W, W] : [W * 0.2, H * 0.47, W * 0.66];
    c.drawImage(src, sx, sy, ss, ss, 0, 0, w, h);
  }
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('no PNG'))), 'image/png'));
}

async function send(path: string, w: number, h: number, crop: Crop): Promise<void> {
  const res = await fetch(`${SERVER}/write?path=${encodeURIComponent(path)}`, { method: 'POST', body: await render(w, h, crop) });
  if (!res.ok) throw new Error(`${path}: ${await res.text()}`);
}

export async function makeIcons(): Promise<string> {
  await send('public/icons/icon-512.png', 512, 512, 'icon');
  await send('public/icons/icon-192.png', 192, 192, 'icon');
  await send('public/icons/apple-touch-icon.png', 180, 180, 'icon');
  await send('public/icons/icon-maskable-512.png', 512, 512, 'tight');
  const res = 'android/app/src/main/res';
  for (const [dpi, k] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
    await send(`${res}/mipmap-${dpi}/ic_launcher.png`, 48 * k, 48 * k, 'icon');
    await send(`${res}/mipmap-${dpi}/ic_launcher_round.png`, 48 * k, 48 * k, 'tight');
    // Adaptive icons show only the middle two thirds: the tight crop keeps the cup in it.
    await send(`${res}/mipmap-${dpi}/ic_launcher_foreground.png`, 108 * k, 108 * k, 'tight');
  }
  await send('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024, 1024, 'icon');
  const splashes = (await (await fetch(`${SERVER}/splashes`)).json()) as { path: string; size: [number, number] }[];
  for (const s of splashes) await send(s.path, s.size[0], s.size[1], 'splash');
  return `done: ${13 + 15 + splashes.length} files`;
}
