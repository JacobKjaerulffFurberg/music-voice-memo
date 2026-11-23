// The phone app's web files: the built site, with the phone page as the start page.
// (The app opens index.html; on the web that is the desktop editor.) Run after `vite build`.
import { cpSync, rmSync, renameSync, existsSync } from 'node:fs';

const out = 'dist-app';
if (!existsSync('dist/mobile.html')) throw new Error('Build the site first (npm run build).');
rmSync(out, { recursive: true, force: true });
cpSync('dist', out, { recursive: true });
rmSync(`${out}/debug.html`, { force: true });
renameSync(`${out}/index.html`, `${out}/daw.html`);
renameSync(`${out}/mobile.html`, `${out}/index.html`);
console.log(`${out}/ ready: index.html is the phone page.`);
