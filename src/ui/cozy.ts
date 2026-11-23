/**
 * Plays the cozy pixel scene on a canvas: about 12 frames a second (plenty for rain and steam, and
 * next to nothing for a phone), and only while it is running. The cat breathes slowly.
 */
import { movingPixels, paintScene, SCENE_H, SCENE_W } from './cozy-scene';

let stills: ImageData[] | null = null;

/** The still picture at a few points of the cat's breath, painted once and shared. */
function breaths(): ImageData[] {
  stills ??= [0, 0.35, 0.7, 1].map((b) => new ImageData(paintScene(b) as Uint8ClampedArray<ArrayBuffer>, SCENE_W, SCENE_H));
  return stills;
}

export interface Scene {
  start(): void;
  stop(): void;
}

export function playScene(canvas: HTMLCanvasElement): Scene {
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  const c = canvas.getContext('2d');
  let timer: ReturnType<typeof setInterval> | null = null;
  const t0 = performance.now();
  const frame = (): void => {
    if (!c) return;
    const t = (performance.now() - t0) / 1000;
    // In for two seconds, out for two: the stills are steps along the way.
    const b = (1 - Math.cos((t / 4) * Math.PI * 2)) / 2;
    const s = breaths();
    c.putImageData(s[Math.min(s.length - 1, Math.round(b * (s.length - 1)))], 0, 0);
    movingPixels(t, (x, y, col) => {
      c.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      c.fillRect(x, y, 1, 1);
    });
  };
  return {
    start() {
      if (timer) return;
      frame();
      timer = setInterval(frame, 83);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
