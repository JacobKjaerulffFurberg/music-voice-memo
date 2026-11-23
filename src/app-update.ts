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
  /** SHA-256 of the zip (lowercase hex): the updater refuses a zip without one, or one that doesn't match. */
  checksum?: string;
  /** The app shell's version code those web files need. */
  native: number;
  /** Where the newest APK is. */
  apk: string;
}

export type UpdateState =
  | { kind: 'current' }
  | { kind: 'web'; version: number; url: string; checksum: string; apk: string }
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
  // A web build without a checksum can't be installed in place: the new app is the way then.
  if (pub.native > shell || !pub.checksum) return { kind: 'apk', url: pub.apk };
  return { kind: 'web', version: pub.version, url: new URL(pub.url, VERSION_URL).href, checksum: pub.checksum, apk: pub.apk };
}

/** Download the newer web build and restart into it. `onProgress` gets 0–1. */
export async function installWebUpdate(u: { version: number; url: string; checksum: string }, onProgress?: (done: number) => void): Promise<void> {
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  const sub = onProgress ? await CapacitorUpdater.addListener('download', (e) => onProgress(Math.min(1, (e.percent ?? 0) / 100))) : null;
  try {
    const bundle = await CapacitorUpdater.download({ url: u.url, version: String(u.version), checksum: u.checksum });
    await CapacitorUpdater.set(bundle); // restarts the app in the new build
  } finally {
    await sub?.remove();
  }
}

interface ApkInstaller {
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  downloadAndInstall(o: { url: string }): Promise<void>;
  addListener(event: 'progress', cb: (e: { percent: number }) => void): Promise<{ remove: () => Promise<void> }>;
}

/**
 * Get the new app. With the app's own installer (versionCode 4 on): downloaded inside the app and
 * handed straight to Android's "Update" prompt; the file is cleaned up afterwards. The first time,
 * Android wants a one-time "allow this app to install updates": we open that switch and say so.
 * Older builds without it: the download opens in the browser instead.
 */
export async function installApk(url: string, onProgress?: (done: number) => void): Promise<'installing' | 'allow-first' | 'browser'> {
  const { Capacitor, registerPlugin } = await import('@capacitor/core');
  if (!Capacitor.isPluginAvailable('ApkInstaller')) {
    window.location.href = url;
    return 'browser';
  }
  const apk = registerPlugin<ApkInstaller>('ApkInstaller');
  if (!(await apk.canInstall()).allowed) {
    await apk.openInstallSettings();
    return 'allow-first';
  }
  const sub = onProgress ? await apk.addListener('progress', (e) => onProgress(Math.min(1, e.percent / 100))) : null;
  try {
    await apk.downloadAndInstall({ url });
    return 'installing';
  } finally {
    await sub?.remove();
  }
}

/** Tell the updater this build started fine (otherwise it rolls back to the previous one). */
export function markAppReady(): void {
  if (!isNativeApp()) return;
  void import('@capgo/capacitor-updater').then(({ CapacitorUpdater }) => CapacitorUpdater.notifyAppReady()).catch(() => undefined);
}
