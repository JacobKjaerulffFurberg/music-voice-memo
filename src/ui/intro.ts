/**
 * The intro: a quiet moment before the app. Rain on the window, the cat asleep on your lap, the
 * coffee still steaming, and "lo-fi your life" in soft pixel letters. Fades in, stays about four
 * seconds; a tap goes straight on. Shown once per visit (each app launch is a new visit).
 */
import '@fontsource/pixelify-sans/latin-400.css';
import '@fontsource/pixelify-sans/latin-600.css';
import { playScene } from './cozy';

const SEEN = 'hum-intro-seen';

export function showIntro(): Promise<void> {
  try {
    if (sessionStorage.getItem(SEEN)) return Promise.resolve();
    sessionStorage.setItem(SEEN, '1');
  } catch {
    // No storage: show it.
  }
  const el = document.createElement('div');
  el.className = 'intro';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Lo-fi your life: rain on the window, a cat asleep, a warm coffee');
  el.innerHTML = `
    <canvas class="intro-scene pixel"></canvas>
    <h1 class="intro-title">lo-fi <span>your life</span></h1>
    <p class="intro-tap">tap to start</p>`;
  document.body.appendChild(el);
  const scene = playScene(el.querySelector('canvas') as HTMLCanvasElement);
  scene.start();

  return new Promise((resolve) => {
    let gone = false;
    const leave = (): void => {
      if (gone) return;
      gone = true;
      el.classList.add('out');
      setTimeout(() => {
        scene.stop();
        el.remove();
      }, 700);
      resolve();
    };
    el.addEventListener('pointerdown', leave);
    setTimeout(leave, 4200);
  });
}
