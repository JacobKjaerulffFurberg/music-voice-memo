/**
 * The intro: a quiet moment before the app. The record button and "lo-fi your life" in soft letters. Fades in, stays about four seconds; a tap goes straight on.
 * Shown once per visit (each app launch is a new visit).
 */
import '@fontsource/fraunces/latin-400.css';
import '@fontsource/fraunces/latin-400-italic.css';
import '@fontsource/fraunces/latin-600.css';
import '@fontsource/fraunces/latin-600-italic.css';

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
  el.setAttribute('aria-label', 'Lo-fi your life');
  el.innerHTML = `
    <i class="intro-rec"></i>
    <h1 class="intro-title">lo-fi <em>your life</em></h1>
    <p class="intro-tap">tap to start</p>`;
  document.body.appendChild(el);

  return new Promise((resolve) => {
    let gone = false;
    const leave = (): void => {
      if (gone) return;
      gone = true;
      el.classList.add('out');
      setTimeout(() => el.remove(), 800);
      resolve();
    };
    el.addEventListener('pointerdown', leave);
    setTimeout(leave, 4500);
  });
}
