/**
 * Dev tool: paints the app icons and splash screens (the record button, like the home screen) and
 * sends them to scripts/icons-server.mjs, which writes them into the project. Not part of the app.
 * Run in the console of the dev page:  (await import('/src/dev/icons.ts')).makeIcons()
 */
const SERVER = '/__icons'; // the dev server passes this on to scripts/icons-server.mjs
const BG = '#17130e';
const AMBER = '#e0a45a';

/** The record button, as on the home screen: a soft amber halo, a thin ring, the amber dot. */
function recButton(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.fillStyle = 'rgba(224, 164, 90, 0.16)';
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.lineWidth = Math.max(1, r * 0.03);
  c.strokeStyle = 'rgba(224, 164, 90, 0.6)';
  c.beginPath();
  c.arc(x, y, r - c.lineWidth / 2, 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = AMBER;
  c.beginPath();
  c.arc(x, y, r * 0.64, 0, Math.PI * 2);
  c.fill();
}

/** A fine film grain over the whole picture, like the app. */
function grain(c: CanvasRenderingContext2D, w: number, h: number): void {
  const img = c.getImageData(0, 0, w, h);
  const d = img.data;
  let seed = 7;
  for (let i = 0; i < d.length; i += 4) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const n = ((seed >>> 16) / 65536 - 0.5) * 22;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  c.putImageData(img, 0, 0);
}

type Crop = 'icon' | 'tight' | 'splash';

/** A w×h PNG. icon: the button filling the square. tight: smaller, inside the adaptive-icon safe zone. splash: small on the brown. */
function render(w: number, h: number, crop: Crop): Promise<Blob> {
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const c = out.getContext('2d') as CanvasRenderingContext2D;
  c.fillStyle = BG;
  c.fillRect(0, 0, w, h);
  const side = Math.min(w, h);
  recButton(c, w / 2, h / 2, side * { icon: 0.36, tight: 0.26, splash: 0.16 }[crop]);
  grain(c, w, h);
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
    await send(`${res}/mipmap-${dpi}/ic_launcher_round.png`, 48 * k, 48 * k, 'icon');
    // Adaptive icons show only the middle two thirds: the tight size keeps the whole button in it.
    await send(`${res}/mipmap-${dpi}/ic_launcher_foreground.png`, 108 * k, 108 * k, 'tight');
  }
  await send('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024, 1024, 'icon');
  const splashes = (await (await fetch(`${SERVER}/splashes`)).json()) as { path: string; size: [number, number] }[];
  for (const s of splashes) await send(s.path, s.size[0], s.size[1], 'splash');
  return `done: ${13 + 15 + splashes.length} files`;
}
