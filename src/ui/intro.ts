/**
 * The intro: "Lo-fi Your Life" sprayed onto a dark wall. LO-FI goes on in one pass of the can
 * (mist at the nozzle, paint running down after), then "your life" is tagged across it in marker.
 * About three seconds; a tap skips it. Shown once per visit (each app launch is a new visit).
 */
import '@fontsource/rubik-spray-paint/latin-400.css';
import '@fontsource/permanent-marker/latin-400.css';

const SEEN = 'hum-intro-seen';

export function showIntro(): Promise<void> {
  try {
    if (sessionStorage.getItem(SEEN)) return Promise.resolve();
    sessionStorage.setItem(SEEN, '1');
  } catch {
    // No storage: show it.
  }
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'intro' + (calm ? ' calm' : '');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Lo-fi Your Life');
  // Drips under LO-FI: where (% across) and how far they run. Each starts just after the can has passed it.
  const drips = [
    [9, 46],
    [27, 22],
    [44, 64],
    [63, 30],
    [81, 52],
    [93, 18],
  ].map(([x, h]) => [x, h, 0.35 + (1.1 * x) / 100]);
  el.innerHTML = `
    <canvas class="intro-mist"></canvas>
    <div class="intro-art">
      <div class="intro-lofi"><span>LO-FI</span>${drips
        .map(([x, h, d]) => `<i style="left:${x}%;--h:${h}px;--d:${d}s"></i>`)
        .join('')}</div>
      <div class="intro-life">your life</div>
    </div>
    <p class="intro-tap">tap</p>`;
  document.body.appendChild(el);

  // The can: a cloud of fine dots that follows the leading edge of the paint across the word.
  const canvas = el.querySelector('canvas') as HTMLCanvasElement;
  const word = el.querySelector('.intro-lofi span') as HTMLElement;
  const c = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  const SPRAY_MS = 1100;
  const t0 = performance.now();
  let raf = 0;
  const colours = ['#ff3d7f', '#ffb000', '#ff6a3d'];
  const mist = (): void => {
    if (!c) return;
    const f = (performance.now() - t0 - 150) / SPRAY_MS;
    if (f > 1.05) return;
    raf = requestAnimationFrame(mist);
    if (f < 0) return;
    const r = word.getBoundingClientRect();
    const x = r.left + r.width * Math.min(1, f);
    // The nozzle swings up and down a little as the arm sweeps.
    const y = r.top + r.height * (0.5 + 0.32 * Math.sin(f * 19));
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let k = 0; k < 70; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.pow(Math.random(), 1.8) * r.height * 0.75;
      c.globalAlpha = 0.08 + Math.random() * 0.22;
      c.fillStyle = colours[k % 3];
      c.beginPath();
      c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.5 + Math.random() * 1.3, 0, Math.PI * 2);
      c.fill();
    }
  };
  if (!calm) raf = requestAnimationFrame(mist);

  return new Promise((resolve) => {
    let gone = false;
    const leave = (): void => {
      if (gone) return;
      gone = true;
      cancelAnimationFrame(raf);
      el.classList.add('out');
      setTimeout(() => {
        el.remove();
      }, 450);
      resolve();
    };
    el.addEventListener('pointerdown', leave);
    setTimeout(leave, calm ? 1600 : 3200);
  });
}
