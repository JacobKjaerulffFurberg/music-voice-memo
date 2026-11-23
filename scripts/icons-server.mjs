// Receives the app icons and splash screens rendered in the browser (src/dev/icons.ts) and writes
// them into the project. Only PNGs, only into the icon folders, only on this computer.
//
//   1. node scripts/icons-server.mjs
//   2. npm run dev, open http://localhost:5173/mobile.html, and in the console:
//        (await import('/src/dev/icons.ts')).makeIcons()
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, normalize } from 'node:path';

const ALLOWED = ['public/icons/', 'android/app/src/main/res/', 'ios/App/App/Assets.xcassets/'];
const ok = (p) => p.endsWith('.png') && !p.includes('..') && ALLOWED.some((a) => normalize(p).replaceAll('\\', '/').startsWith(a)) && existsSync(dirname(p));
const sizeOf = (f) => {
  const b = readFileSync(f);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

/** Every splash screen already in the native projects, with its size (they come in many). */
function splashes() {
  const out = [];
  const res = 'android/app/src/main/res';
  if (existsSync(res)) for (const d of readdirSync(res)) if (existsSync(`${res}/${d}/splash.png`)) out.push({ path: `${res}/${d}/splash.png`, size: sizeOf(`${res}/${d}/splash.png`) });
  const ios = 'ios/App/App/Assets.xcassets/Splash.imageset';
  if (existsSync(ios)) for (const f of readdirSync(ios).filter((n) => n.endsWith('.png'))) out.push({ path: `${ios}/${f}`, size: sizeOf(`${ios}/${f}`) });
  return out;
}

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/splashes') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(splashes()));
  }
  if (req.method === 'POST' && url.pathname === '/write') {
    const path = url.searchParams.get('path') ?? '';
    if (!ok(path)) {
      res.statusCode = 400;
      return res.end('not an icon path: ' + path);
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      writeFileSync(path, Buffer.concat(chunks));
      console.log('wrote', path);
      res.end('ok');
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(4190, '127.0.0.1', () => console.log('icons server on http://127.0.0.1:4190'));
