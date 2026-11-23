/**
 * "Download the newest version", from inside the phone app.
 *
 * Every deploy publishes, next to the website, a zip of the app's web files and a small
 * `app/version.json` (see scripts/app-update.mjs). The app compares that with the build it is
 * running:
 *  - newer web build, same app shell → download the zip and restart into it (seconds, takes kept);
 *  - the app shell itself changed (new native plugin or permission) → the new APK has to be
 *    installed: we hand its download link to the phone.
 * If a downloaded build fails to start, the updater rolls back to the last one that worked.
 */
import { isNativeApp } from './export/mp3';

/** When this build was made (ms since 1970); stamped in by vite.config.ts. */
export const BUILD = Number(__BUILD__);

const SITE = 'https://jacobkjaerulfffurberg.github.io/music-voice-memo/';
const VERSION_URL = `${SITE}app/version.json`;

interface Published {
  /** Build stamp of the web files in the zip. */
  version: number;
  /** The zip, relative to version.json. */
  url: string;
  /** The app shell's version code those web files need. */
  native: number;
  /** Where the newest APK is. */
  apk: string;
}

export type UpdateState =
  | { kind: 'current' }
  | { kind: 'web'; version: number; url: string }
  | { kind: 'apk'; url: string }
  | { kind: 'offline' };

/** "23 Nov 17:05": a build stamp as people read it. */
export function buildLabel(stamp = BUILD): string {
  if (!stamp) return 'dev';
  const d = new Date(stamp);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** Is there something newer than what's running? (Only asks in the app; on the web the newest always loads.) */
export async function checkForUpdate(): Promise<UpdateState> {
  if (!isNativeApp()) return { kind: 'current' };
  let pub: Published;
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return { kind: 'offline' };
    pub = (await res.json()) as Published;
  } catch {
    return { kind: 'offline' };
  }
  if (!(pub.version > BUILD)) return { kind: 'current' };
  const { App } = await import('@capacitor/app');
  const shell = Number((await App.getInfo()).build) || 1;
  if (pub.native > shell) return { kind: 'apk', url: pub.apk };
  return { kind: 'web', version: pub.version, url: new URL(pub.url, VERSION_URL).href };
}

/** Download the newer web build and restart into it. `onProgress` gets 0–1. */
export async function installWebUpdate(u: { version: number; url: string }, onProgress?: (done: number) => void): Promise<void> {
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  const sub = onProgress ? await CapacitorUpdater.addListener('download', (e) => onProgress(Math.min(1, (e.percent ?? 0) / 100))) : null;
  try {
    const bundle = await CapacitorUpdater.download({ url: u.url, version: String(u.version) });
    await CapacitorUpdater.set(bundle); // restarts the app in the new build
  } finally {
    await sub?.remove();
  }
}

/** Open the new APK's download in the phone's browser; Android then offers to install it. */
export function installApk(url: string): void {
  window.location.href = url;
}

/** Tell the updater this build started fine (otherwise it rolls back to the previous one). */
export function markAppReady(): void {
  if (!isNativeApp()) return;
  void import('@capgo/capacitor-updater').then(({ CapacitorUpdater }) => CapacitorUpdater.notifyAppReady()).catch(() => undefined);
}
