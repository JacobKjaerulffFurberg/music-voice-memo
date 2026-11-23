// Publishes the app's update next to the website: dist/app/web-<build>.zip (the phone app's web
// files) and dist/app/version.json (which build that is, and which app shell it needs).
// Run after `npm run app:web` with the same BUILD_ID the build used (the deploy workflow does this).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const build = process.env.BUILD_ID;
if (!build) throw new Error('Set BUILD_ID to the stamp the build was made with.');
const native = Number(/versionCode\s+(\d+)/.exec(readFileSync('android/app/build.gradle', 'utf8'))?.[1] ?? 1);
const repo = process.env.GITHUB_REPOSITORY ?? 'JacobKjaerulffFurberg/music-voice-memo';

const out = 'dist/app';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const zip = `web-${build}.zip`;
try {
  execFileSync('zip', ['-qr', `../${out}/${zip}`, '.'], { cwd: 'dist-app', stdio: 'inherit' });
} catch {
  // No zip command (Windows): its tar writes zip files too.
  execFileSync('tar', ['-a', '-cf', `../${out}/${zip}`, '*'], { cwd: 'dist-app', stdio: 'inherit', shell: true });
}
// The updater only installs a zip whose SHA-256 matches this (lowercase hex).
const checksum = createHash('sha256').update(readFileSync(`${out}/${zip}`)).digest('hex');
writeFileSync(
  `${out}/version.json`,
  JSON.stringify(
    {
      version: Number(build),
      url: zip,
      checksum,
      native,
      apk: `https://github.com/${repo}/releases/download/android-latest/lofi-your-life.apk`,
    },
    null,
    2,
  ) + '\n',
);
console.log(`${out}/version.json: build ${build}, needs app shell ${native}`);
