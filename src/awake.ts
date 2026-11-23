/**
 * Keep the phone's screen on while something is going on (recording, playing, singing over),
 * and let it sleep again as soon as nothing is. In the app: the native keep-awake plugin. In a
 * browser: the Screen Wake Lock, which the browser drops when the page is hidden, so it is asked
 * for again when the page comes back.
 */
import { isNativeApp } from './export/mp3';

/** What wants the screen on right now ('recording', 'playing', …). */
const reasons = new Set<string>();
let lock: WakeLockSentinel | null = null;

async function apply(): Promise<void> {
  const want = reasons.size > 0;
  try {
    if (isNativeApp()) {
      const { KeepAwake } = await import('@capacitor-community/keep-awake');
      await (want ? KeepAwake.keepAwake() : KeepAwake.allowSleep());
      return;
    }
    if (want && !lock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } else if (!want && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    // Not allowed or not there (low battery, old browser): the screen just sleeps as usual.
  }
}

/** `why` wants the screen on (true) or no longer needs it (false). */
export function stayAwake(why: string, on: boolean): void {
  const had = reasons.has(why);
  if (on === had) return;
  if (on) reasons.add(why);
  else reasons.delete(why);
  void apply();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && reasons.size > 0) void apply();
  });
}
