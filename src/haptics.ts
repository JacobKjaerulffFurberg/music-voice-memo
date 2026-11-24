/**
 * The beat you can feel: a short buzz on each beat, a little stronger on the one. Silent, so it
 * never ends up in the recording (most people sing without headphones). In the app: the native
 * haptics (Android and iOS). In a browser: the vibration API (Android; iPhone browsers have none).
 */
import { isNativeApp } from './export/mp3';

let native: Promise<typeof import('@capacitor/haptics')> | null = null;

export function beatPulse(one: boolean): void {
  try {
    if (isNativeApp()) {
      native ??= import('@capacitor/haptics');
      void native.then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: one ? ImpactStyle.Medium : ImpactStyle.Light })).catch(() => undefined);
      return;
    }
    navigator.vibrate?.(one ? 35 : 15);
  } catch {
    // No motor, or not allowed: the beat is still on screen.
  }
}
