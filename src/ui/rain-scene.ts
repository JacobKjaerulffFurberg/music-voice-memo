/**
 * A rainy day, seen from the warm side of the window: blurred lights of the town through misty
 * glass, rain falling outside, drops beading and running down the pane, a lamp glowing off to the
 * left, and a cup of tea on the sill, steaming.
 *
 * Drawn smoothly on a canvas. The still parts are painted once (per size) into three layers; each
 * frame only adds the rain, the running drops and the steam, about 24 times a second, and only
 * while it plays. The same drawing makes the app icons (see src/dev/icons.ts).
 */

/** A fixed random sequence, so the drops sit in the same places every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Layout {
  W: number;
  H: number;
  /** Design unit: 1 = one pixel of a 300-wide picture. */
  s: number;
  /** Where the glass ends and the sill begins. */
  sill: number;
  cup: { x: number; top: number; bottom: number; rx: number; ry: number; saucerY: number };
}

function layout(W: number, H: number): Layout {
  const s = Math.min(W / 300, H / 400);
  const sill = H * 0.74;
  const rx = 34 * s;
  const cx = W * 0.6;
  return { W, H, s, sill, cup: { x: cx, top: sill - 46 * s, bottom: sill + 40 * s, rx, ry: rx * 0.26, saucerY: sill + 44 * s } };
}

function layer(W: number, H: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return [c, c.getContext('2d') as CanvasRenderingContext2D];
}

function ellipse(c: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  c.beginPath();
  c.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
}

/** Outside: an overcast evening, a few buildings in the haze, out-of-focus lights. */
function paintOutside(c: CanvasRenderingContext2D, L: Layout): void {
  const { W, s, sill } = L;
  const r = seeded(7);
  const sky = c.createLinearGradient(0, 0, 0, sill);
  sky.addColorStop(0, '#223048');
  sky.addColorStop(0.55, '#36445a');
  sky.addColorStop(1, '#566173');
  c.fillStyle = sky;
  c.fillRect(0, 0, W, sill);
  // Buildings, soft and low in contrast, with a few warm windows.
  for (let x = -10 * s; x < W; ) {
    const w = (22 + r() * 40) * s;
    const h = (50 + r() * 130) * s;
    c.fillStyle = `rgba(28, 36, 52, ${0.45 + r() * 0.2})`;
    c.fillRect(x, sill - h, w - 3 * s, h);
    for (let k = 0; k < 4; k++) {
      if (r() > 0.55) continue;
      c.fillStyle = `rgba(255, 196, 120, ${0.18 + r() * 0.22})`;
      c.fillRect(x + r() * (w - 8 * s), sill - h + r() * (h - 10 * s), 3.5 * s, 4.5 * s);
    }
    x += w;
  }
  const haze = c.createLinearGradient(0, sill * 0.45, 0, sill);
  haze.addColorStop(0, 'rgba(120, 135, 156, 0)');
  haze.addColorStop(1, 'rgba(120, 135, 156, 0.32)');
  c.fillStyle = haze;
  c.fillRect(0, 0, W, sill);
  // Bokeh: lights out of focus through the wet glass.
  for (let i = 0; i < 18; i++) {
    const x = r() * W;
    const y = sill * (0.35 + r() * 0.6);
    const rad = (6 + r() * 18) * s;
    const warm = r() > 0.35;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    const col = warm ? '255, 190, 120' : '170, 200, 235';
    const a = 0.16 + r() * 0.2;
    g.addColorStop(0, `rgba(${col}, ${a})`);
    g.addColorStop(0.75, `rgba(${col}, ${a * 0.7})`);
    g.addColorStop(1, `rgba(${col}, 0)`);
    c.fillStyle = g;
    ellipse(c, x, y, rad, rad);
    c.fill();
  }
}

function drop(c: CanvasRenderingContext2D, x: number, y: number, rad: number): void {
  c.fillStyle = 'rgba(12, 20, 34, 0.3)';
  ellipse(c, x, y + rad * 0.12, rad, rad * 1.05);
  c.fill();
  c.fillStyle = 'rgba(225, 235, 248, 0.32)';
  ellipse(c, x + rad * 0.15, y + rad * 0.35, rad * 0.55, rad * 0.4);
  c.fill();
  c.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ellipse(c, x - rad * 0.32, y - rad * 0.35, rad * 0.26, rad * 0.22);
  c.fill();
}

/** The glass: mist gathering low, beads of water all over, the window's frame. */
function paintGlass(c: CanvasRenderingContext2D, L: Layout): void {
  const { W, s, sill } = L;
  const r = seeded(11);
  const mist = c.createLinearGradient(0, 0, 0, sill);
  mist.addColorStop(0, 'rgba(210, 220, 235, 0.03)');
  mist.addColorStop(1, 'rgba(210, 220, 235, 0.14)');
  c.fillStyle = mist;
  c.fillRect(0, 0, W, sill);
  for (let i = 0; i < 190; i++) {
    const rad = (0.7 + Math.pow(r(), 2.2) * 2.6) * s;
    drop(c, r() * W, r() * (sill - 4 * s), rad);
  }
  // The frame: a crossbar and the sides, painted a soft dark wood.
  c.fillStyle = '#2b211c';
  const bar = 7 * s;
  c.fillRect(0, 0, bar, sill);
  c.fillRect(W - bar, 0, bar, sill);
  c.fillRect(0, 0, W, bar);
  c.fillRect(W * 0.5 - bar / 2, 0, bar, sill);
  c.fillRect(0, sill * 0.42, W, bar * 0.8);
  c.fillStyle = 'rgba(255, 220, 190, 0.07)';
  c.fillRect(W * 0.5 - bar / 2, 0, 1.2 * s, sill);
  c.fillRect(0, sill * 0.42, W, 1.2 * s);
}

/** The sill, the lamp light, and the tea. */
function paintSill(c: CanvasRenderingContext2D, L: Layout): void {
  const { W, H, s, sill, cup } = L;
  const wood = c.createLinearGradient(0, sill, 0, H);
  wood.addColorStop(0, '#6e4c35');
  wood.addColorStop(0.15, '#5a3d2b');
  wood.addColorStop(1, '#2e2018');
  c.fillStyle = wood;
  c.fillRect(0, sill, W, H - sill);
  c.fillStyle = 'rgba(255, 214, 170, 0.28)';
  c.fillRect(0, sill, W, 1.6 * s);
  // Grain in the wood.
  const r = seeded(5);
  c.strokeStyle = 'rgba(30, 18, 10, 0.18)';
  c.lineWidth = 1 * s;
  for (let i = 0; i < 9; i++) {
    const y = sill + (8 + r() * (H - sill - 10 * s));
    c.beginPath();
    c.moveTo(0, y);
    c.bezierCurveTo(W * 0.3, y + (r() - 0.5) * 8 * s, W * 0.6, y + (r() - 0.5) * 8 * s, W, y + (r() - 0.5) * 6 * s);
    c.stroke();
  }

  const { x, top, rx, ry, saucerY } = cup;
  const bottom = saucerY - 4 * s;
  // Shadow, saucer.
  const sh = c.createRadialGradient(x + 6 * s, saucerY + 6 * s, 0, x + 6 * s, saucerY + 6 * s, rx * 2);
  sh.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
  sh.addColorStop(1, 'rgba(0, 0, 0, 0)');
  c.fillStyle = sh;
  ellipse(c, x + 6 * s, saucerY + 6 * s, rx * 2, rx * 0.5);
  c.fill();
  const saucer = c.createLinearGradient(x - rx * 1.7, 0, x + rx * 1.7, 0);
  saucer.addColorStop(0, '#f3ece1');
  saucer.addColorStop(0.6, '#ddd1c0');
  saucer.addColorStop(1, '#a8998a');
  c.fillStyle = saucer;
  ellipse(c, x, saucerY, rx * 1.7, rx * 0.36);
  c.fill();
  c.fillStyle = 'rgba(120, 104, 88, 0.35)';
  ellipse(c, x, saucerY - 1 * s, rx * 1.05, rx * 0.2);
  c.fill();

  // The handle, behind-right.
  c.strokeStyle = '#d8ccba';
  c.lineWidth = 6 * s;
  c.beginPath();
  c.ellipse(x + rx * 1.02, top + (bottom - top) * 0.42, rx * 0.42, (bottom - top) * 0.26, 0, -Math.PI * 0.55, Math.PI * 0.55);
  c.stroke();

  // The cup: a soft, slightly tapered bowl.
  const body = c.createLinearGradient(x - rx, 0, x + rx, 0);
  body.addColorStop(0, '#f8f2e8');
  body.addColorStop(0.45, '#e8ddcc');
  body.addColorStop(1, '#a49380');
  c.fillStyle = body;
  c.beginPath();
  c.moveTo(x - rx, top);
  c.bezierCurveTo(x - rx, top + (bottom - top) * 0.75, x - rx * 0.7, bottom, x, bottom);
  c.bezierCurveTo(x + rx * 0.7, bottom, x + rx, top + (bottom - top) * 0.75, x + rx, top);
  c.closePath();
  c.fill();
  // Rim, and the tea inside it.
  c.fillStyle = '#efe6d8';
  ellipse(c, x, top, rx, ry);
  c.fill();
  const tea = c.createRadialGradient(x - rx * 0.3, top - ry * 0.2, 0, x, top, rx);
  tea.addColorStop(0, '#c98a45');
  tea.addColorStop(0.6, '#94561f');
  tea.addColorStop(1, '#5e3312');
  c.fillStyle = tea;
  ellipse(c, x, top + ry * 0.1, rx * 0.88, ry * 0.74);
  c.fill();
  c.fillStyle = 'rgba(255, 230, 190, 0.35)';
  ellipse(c, x - rx * 0.35, top - ry * 0.05, rx * 0.22, ry * 0.18);
  c.fill();

  // The tea bag's string over the rim, and its little paper tag.
  c.strokeStyle = 'rgba(236, 226, 205, 0.9)';
  c.lineWidth = 1.1 * s;
  c.beginPath();
  c.moveTo(x + rx * 0.45, top + ry * 0.2);
  c.quadraticCurveTo(x + rx * 0.82, top - ry * 0.4, x + rx * 0.9, top + 4 * s);
  c.quadraticCurveTo(x + rx * 0.98, top + 22 * s, x + rx * 0.86, top + 30 * s);
  c.stroke();
  c.fillStyle = '#e7d3a2';
  c.save();
  c.translate(x + rx * 0.86, top + 36 * s);
  c.rotate(-0.12);
  c.fillRect(-6 * s, -6 * s, 12 * s, 13 * s);
  c.fillStyle = 'rgba(140, 90, 50, 0.6)';
  c.fillRect(-3.5 * s, -1 * s, 7 * s, 1.2 * s);
  c.fillRect(-3.5 * s, 2 * s, 5 * s, 1.2 * s);
  c.restore();

  // The lamp, somewhere off to the left: everything on this side of the glass is warm.
  const lamp = c.createRadialGradient(-W * 0.1, H * 0.62, 0, -W * 0.1, H * 0.62, W * 1.1);
  lamp.addColorStop(0, 'rgba(255, 176, 96, 0.30)');
  lamp.addColorStop(0.5, 'rgba(255, 160, 80, 0.10)');
  lamp.addColorStop(1, 'rgba(255, 160, 80, 0)');
  c.fillStyle = lamp;
  c.fillRect(0, 0, W, H);
}

interface Runner {
  x: number;
  y0: number;
  v: number;
  rad: number;
  ph: number;
}

export class RainScene {
  private L: Layout;
  private back: HTMLCanvasElement;
  private glass: HTMLCanvasElement;
  private sillLayer: HTMLCanvasElement;
  private streaks: { x: number; v: number; len: number; off: number }[] = [];
  private runners: Runner[] = [];

  constructor(W: number, H: number) {
    this.L = layout(W, H);
    const [b, bc] = layer(W, H);
    paintOutside(bc, this.L);
    const [g, gc] = layer(W, H);
    paintGlass(gc, this.L);
    const [w, wc] = layer(W, H);
    paintSill(wc, this.L);
    this.back = b;
    this.glass = g;
    this.sillLayer = w;
    const r = seeded(3);
    const { s, sill } = this.L;
    for (let i = 0; i < 70; i++) this.streaks.push({ x: r() * W * 1.1, v: (260 + r() * 200) * s, len: (10 + r() * 16) * s, off: r() * sill });
    for (let i = 0; i < 11; i++) this.runners.push({ x: (12 + r() * 276) * (W / 300), y0: r() * sill, v: (5 + r() * 12) * s, rad: (2 + r() * 1.8) * s, ph: r() * 10 });
  }

  /** The picture at time `t` (seconds). */
  draw(c: CanvasRenderingContext2D, t: number): void {
    const { W, s, sill, cup } = this.L;
    c.drawImage(this.back, 0, 0);
    // Rain falling outside, slanting a touch.
    c.strokeStyle = 'rgba(205, 218, 236, 0.22)';
    c.lineWidth = 1 * s;
    c.beginPath();
    for (const r of this.streaks) {
      const span = sill + r.len;
      const y = ((r.off + t * r.v) % span) - r.len;
      const x = (r.x - y * 0.12) % (W * 1.1);
      c.moveTo(x, y);
      c.lineTo(x - r.len * 0.12, y + r.len);
    }
    c.stroke();
    c.drawImage(this.glass, 0, 0);
    // Drops running down the pane: they stop and go, and leave a clearer trail behind them.
    for (const r of this.runners) {
      const f = 0.9;
      const travel = r.v * (t - (0.5 * Math.sin(t * f + r.ph)) / f);
      const span = sill + 30 * s;
      const y = ((r.y0 + travel) % span) - 10 * s;
      if (y > sill - r.rad) continue;
      const trail = Math.min(y, 26 * s + r.v * 2);
      const tr = c.createLinearGradient(0, y - trail, 0, y);
      tr.addColorStop(0, 'rgba(225, 235, 248, 0)');
      tr.addColorStop(1, 'rgba(225, 235, 248, 0.16)');
      c.fillStyle = tr;
      c.fillRect(r.x - r.rad * 0.45, y - trail, r.rad * 0.9, trail);
      drop(c, r.x, y, r.rad);
    }
    c.drawImage(this.sillLayer, 0, 0);
    // Steam: three soft wisps curling up off the tea and fading.
    const rise = 95 * s;
    for (let k = 0; k < 3; k++) {
      const x0 = cup.x + (k - 1) * cup.rx * 0.45;
      const y0 = cup.top - 2 * s;
      const g = c.createLinearGradient(0, y0, 0, y0 - rise);
      const a = 0.16 + 0.08 * Math.sin(t * 0.7 + k * 2);
      g.addColorStop(0, `rgba(255, 250, 240, ${a})`);
      g.addColorStop(1, 'rgba(255, 250, 240, 0)');
      c.strokeStyle = g;
      c.lineWidth = (6 + k) * s;
      c.lineCap = 'round';
      c.beginPath();
      for (let i = 0; i <= 14; i++) {
        const p = i / 14;
        const y = y0 - p * rise;
        const x = x0 + Math.sin(t * 0.9 + p * 4.2 + k * 2.1) * (2 + p * 11) * s;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.stroke();
    }
  }
}

export interface Scene {
  start(): void;
  stop(): void;
}

/** Plays the scene on `canvas` at its shown size (sharp on high-density screens), only while started. */
export function playRainScene(canvas: HTMLCanvasElement): Scene {
  const c = canvas.getContext('2d');
  let scene: RainScene | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const t0 = performance.now();
  const fit = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(canvas.clientWidth * dpr);
    const H = Math.round(canvas.clientHeight * dpr);
    if (W < 2 || H < 2) return;
    if (scene && canvas.width === W && canvas.height === H) return;
    canvas.width = W;
    canvas.height = H;
    scene = new RainScene(W, H);
  };
  const frame = (): void => {
    fit();
    if (c && scene) scene.draw(c, (performance.now() - t0) / 1000);
  };
  return {
    start() {
      if (timer) return;
      frame();
      timer = setInterval(frame, 42);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
