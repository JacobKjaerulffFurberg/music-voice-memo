/**
 * The cozy scene, in pixels: an autumn night through a rainy window, a lamp glowing on the left,
 * a plant and some books on the sill, an orange cat asleep on the blanket on your lap and a
 * mug of coffee steaming beside it.
 *
 * Pure drawing code (no DOM): the page animates it on a canvas, the icon script paints app icons
 * from it. Coordinates are scene pixels: SCENE_W × SCENE_H, shown blown up with crisp edges.
 */

export const SCENE_W = 96;
export const SCENE_H = 128;

type RGB = readonly [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export const P = {
  wall: hex('#2b1d26'),
  wallStripe: hex('#30212b'),
  wallDark: hex('#1f151c'),
  wood: hex('#6e4429'),
  woodHi: hex('#8f5c37'),
  woodDk: hex('#45291a'),
  sky1: hex('#121a30'),
  sky2: hex('#18233e'),
  sky3: hex('#21304f'),
  moon: hex('#f2dfb0'),
  moonGlow: hex('#2f3c62'),
  tree: hex('#0f1524'),
  leaf1: hex('#c2612a'),
  leaf2: hex('#e3913f'),
  leaf3: hex('#8e3f22'),
  town: hex('#0c111d'),
  light: hex('#f6c36a'),
  light2: hex('#e08a4a'),
  rain: hex('#6f8dba'),
  rainHi: hex('#b7cdea'),
  pot: hex('#a9532d'),
  potDk: hex('#7c3a20'),
  plant: hex('#6f7f3c'),
  plantDk: hex('#4c5a2a'),
  book1: hex('#8c3b3b'),
  book2: hex('#3f5f6e'),
  book3: hex('#c9a25b'),
  blanket: hex('#7d3326'),
  blanket2: hex('#94442f'),
  blanketLine: hex('#5a2219'),
  blanketHi: hex('#b4643f'),
  cat: hex('#d8893f'),
  catShade: hex('#b06a2c'),
  catStripe: hex('#9c5524'),
  catHi: hex('#efb06a'),
  line: hex('#2a1710'),
  nose: hex('#e08f8f'),
  mug: hex('#e8d9bd'),
  mugHi: hex('#f8efdd'),
  mugShade: hex('#c4b190'),
  coffee: hex('#4a2a1a'),
  steam: hex('#e9ddc8'),
  lamp: hex('#ffb45e'),
  wire: hex('#3d2a24'),
  bulbs: [hex('#ffb45e'), hex('#e0644a'), hex('#f3d27a')],
  bulbsDim: [hex('#8a5a34'), hex('#7a3a30'), hex('#86744a')],
} as const;

/** The glass of the window (inside the frame). */
export const GLASS = { x0: 18, y0: 10, x1: 77, y1: 58 };
/** Where the steam leaves the mug. */
export const MUG_TOP = { x: 74, y: 90 };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number): number => BAYER[(y & 3) * 4 + (x & 3)];
/** A fixed "random" number in [0, 1) per pixel. */
const hash = (x: number, y: number): number => {
  let h = Math.imul(x * 374761393 + y * 668265263, 1274126177) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245) >>> 0;
  return (h >>> 8) / 16777216;
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Two colours blended the 8-bit way: by dithering, not by mixing. */
const dither = (a: RGB, b: RGB, t: number, x: number, y: number): RGB => (t > bayer(x, y) ? b : a);

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const inTri = (x: number, y: number, a: [number, number], b: [number, number], c: [number, number]): boolean => {
  const s = (p: [number, number], q: [number, number]): number => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const d1 = s(a, b);
  const d2 = s(b, c);
  const d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

/** The fairy lights hang in two loops under the sill. */
export const wireY = (x: number): number => 68 + 5 * Math.abs(Math.sin(((x - 12) / 71) * Math.PI * 2 * 0.5 * 2));
/** Where the bulbs are. */
export const BULBS = Array.from({ length: 11 }, (_, i) => 15 + i * 6.6).map((x) => [Math.round(x), Math.round(wireY(x)) + 1] as const);

/** The blanket's top edge: two knees under it. */
const blanketTop = (x: number): number => 93 - 9 * Math.exp(-(((x - 28) / 17) ** 2)) - 9 * Math.exp(-(((x - 70) / 17) ** 2));

// ---- the cat (breath 0…1 lifts its back a little)
function catPart(x: number, y: number, breath: number): 'head' | 'ear' | 'body' | 'tail' | null {
  const px = x + 0.5;
  const py = y + 0.5;
  if (inEllipse(px, py, 34, 85, 6.6, 6.2)) return 'head';
  if (inTri(px, py, [28.5, 81], [29.5, 74.5], [33, 79.5]) || inTri(px, py, [35, 79.5], [38.5, 74.5], [39.5, 81])) return 'ear';
  if (inEllipse(px, py, 50, 88.5 - breath * 0.6, 17.5, 8.4 + breath * 0.6)) return 'body';
  // The tail wraps round the front, from the back end towards the nose.
  const dx = px - 49;
  const dy = py - 87;
  const r = Math.hypot(dx / 1.1, dy);
  const a = Math.atan2(dy, dx);
  if (r > 9.5 && r < 12.2 && a > 0.15 && a < 2.35) return 'tail';
  return null;
}

function catColour(x: number, y: number, part: string, breath: number): RGB {
  if (part === 'ear') return inTri(x + 0.5, y + 0.5, [30, 80], [30.3, 77], [32, 79.5]) || inTri(x + 0.5, y + 0.5, [36, 79.5], [37.7, 77], [38, 80]) ? P.nose : P.cat;
  if (part === 'head') {
    // Sleeping: two little closed-eye arcs and a pink nose.
    const eye = [
      [30, 85],
      [31, 86],
      [32, 85],
      [35, 85],
      [36, 86],
      [37, 85],
    ];
    if (eye.some(([ex, ey]) => ex === x && ey === y)) return P.line;
    if (x === 33 && y === 88) return P.nose;
    if (y >= 89) return P.catShade;
    if (y <= 81 && x <= 33) return P.catHi;
    return P.cat;
  }
  const top = 88.5 - breath * 0.6 - 8.4;
  const stripe = Math.floor((x * 0.9 - y * 0.5) / 3) % 3 === 0;
  if (part === 'tail') return (x + y) % 5 < 2 ? P.catStripe : P.cat;
  if (y > 90) return stripe ? P.catStripe : P.catShade;
  if (y < top + 2.5 && x < 54) return P.catHi;
  return stripe && y > top + 1 ? P.catStripe : P.cat;
}

function mugColour(x: number, y: number): RGB | null {
  // A fat mug with a handle on the right and coffee showing at the top.
  if (x >= 70 && x <= 79 && y >= 91 && y <= 103) {
    if (x === 70 || x === 79 || y === 103) return P.line;
    if (y === 91) return x === 70 || x === 79 ? P.line : P.coffee;
    if (y === 92) return P.mugShade;
    if (x === 71) return P.mugHi;
    if (x >= 77) return P.mugShade;
    return P.mug;
  }
  const hx = x - 80.5;
  const hy = y - 97;
  const r = Math.hypot(hx * 1.2, hy);
  if (x >= 80 && r <= 3.6) return r >= 2.4 ? (r >= 3.1 ? P.line : P.mug) : null;
  return null;
}

/** One pixel of the still picture. `breath` 0…1: how far the cat has breathed in. */
function pixel(x: number, y: number, breath: number): RGB {
  // The wall, faint stripes of wallpaper.
  let c: RGB = x % 8 === 0 ? P.wallStripe : P.wall;
  const edge = Math.max(Math.abs(x - 48) / 48, Math.abs(y - 64) / 64);
  c = dither(c, P.wallDark, (edge - 0.72) * 3, x, y);
  let glass = false;

  // The window.
  const { x0, y0, x1, y1 } = GLASS;
  if (x >= x0 - 2 && x <= x1 + 2 && y >= y0 - 2 && y <= y1 + 2) {
    const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const mullion = (x === 47 || x === 48) || y === 33 || y === 34;
    if (!inside || mullion) {
      c = x === x0 - 2 || y === y0 - 2 ? P.woodHi : x === x1 + 2 || y === y1 + 2 ? P.woodDk : P.wood;
      if (mullion && inside) c = x === 47 || y === 33 ? P.woodHi : P.wood;
    } else {
      glass = true;
      const t = (y - y0) / (y1 - y0);
      c = t < 0.5 ? dither(P.sky1, P.sky2, t * 2, x, y) : dither(P.sky2, P.sky3, (t - 0.5) * 2, x, y);
      // The moon and its haze.
      const dm = Math.hypot(x - 63, y - 19);
      if (dm < 9.5) c = dither(c, P.moonGlow, (9.5 - dm) / 6, x, y);
      if (dm < 4.2) c = dm < 3.2 || hash(x, y) > 0.3 ? P.moon : c;
      if (dm < 4.2 && (x === 64 && y === 18)) c = mix(P.moon, P.moonGlow, 0.25);
      // The town: rooftops with a few lit windows.
      const roof = 51 + Math.floor(hash(Math.floor(x / 5), 3) * 5);
      if (y >= roof) c = hash(x, y) > 0.86 && y > roof + 1 && x % 2 === 0 ? (hash(y, x) > 0.5 ? P.light : P.light2) : P.town;
      // An autumn tree, its leaves turning.
      const crown = inEllipse(x, y, 27, 38, 9, 8) || inEllipse(x, y, 34, 44, 7, 6) || inEllipse(x, y, 22, 45, 6, 5);
      const trunk = x >= 26 && x <= 27 && y >= 44;
      if (crown || trunk) c = crown && hash(x, y) > 0.55 ? [P.leaf1, P.leaf2, P.leaf3][Math.floor(hash(y, x) * 3)] : P.tree;
    }
  }

  // The sill, with a plant in a pot and a few books.
  if (y >= 61 && y <= 64 && x >= 12 && x <= 83) c = y === 61 ? P.woodHi : y === 64 ? P.woodDk : P.wood;
  if (y === 65 && x >= 12 && x <= 83) c = P.wallDark;
  const potTop = 54;
  if (y >= potTop && y <= 60 && x >= 20 + Math.floor((y - potTop) / 4) && x <= 27 - Math.floor((y - potTop) / 4)) c = y === potTop ? P.potDk : x <= 21 + (y - potTop) / 4 ? P.potDk : P.pot;
  const leafy = inEllipse(x, y, 21, 49, 2.6, 4.5) || inEllipse(x, y, 26, 48, 2.6, 5) || inEllipse(x, y, 23.5, 45, 2.2, 5.5);
  if (leafy && y < potTop) c = hash(x, y) > 0.6 ? P.plantDk : P.plant;
  const books: [number, number, number, RGB][] = [
    [63, 66, 50, P.book1],
    [67, 70, 52, P.book2],
    [71, 73, 49, P.book3],
  ];
  for (const [bx0, bx1, by, col] of books) if (x >= bx0 && x <= bx1 && y >= by && y <= 60) c = y === by + 2 ? P.wallDark : x === bx1 ? mix(col, P.line, 0.35) : col;

  // The fairy lights' wire.
  if (x >= 12 && x <= 83 && y === Math.round(wireY(x))) c = P.wire;

  // The blanket on your lap: a red plaid over two knees.
  const top = blanketTop(x);
  if (y >= Math.round(top)) {
    const gx = (x + 3) % 12 < 2;
    const gy = (y + 1) % 12 < 2;
    c = gx && gy ? P.blanketLine : gx || gy ? P.blanket2 : P.blanket;
    if (y === Math.round(top)) c = P.blanketHi;
    c = dither(c, P.blanketLine, (y - 112) / 16, x, y);
  }

  // The cat, outlined; the mug.
  const part = catPart(x, y, breath);
  if (part) {
    const out = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dy]) => !catPart(x + dx, y + dy, breath));
    c = out ? P.line : catColour(x, y, part, breath);
  }
  const m = mugColour(x, y);
  if (m) c = m;

  // The lamp, off to the left, warming everything this side of the glass.
  if (!glass) {
    const lit = Math.max(0, 1 - Math.hypot(x - 2, y - 70) / 62);
    const steps = Math.floor(lit * 4 + bayer(x, y) * 0.999) / 4;
    c = mix(c, P.lamp, 0.2 * steps);
  }
  return c;
}

/** The still picture as RGBA, `breath` 0…1. */
export function paintScene(breath = 0): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SCENE_W * SCENE_H * 4);
  for (let y = 0; y < SCENE_H; y++) {
    for (let x = 0; x < SCENE_W; x++) {
      const c = pixel(x, y, breath);
      const o = (y * SCENE_W + x) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  return out;
}

/** What moves, at time `t` (s): rain on the glass, leaves falling outside, steam off the coffee. */
export function movingPixels(t: number, put: (x: number, y: number, c: RGB) => void): void {
  const { x0, y0, x1, y1 } = GLASS;
  const onGlass = (x: number, y: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1 && x !== 47 && x !== 48 && y !== 33 && y !== 34;
  // Leaves drifting down behind the rain.
  for (let i = 0; i < 5; i++) {
    const span = y1 - y0 + 8;
    const y = y0 - 4 + ((t * (5 + 2 * hash(i, 1)) + hash(i, 2) * span) % span);
    const x = x0 + 4 + hash(i, 3) * (x1 - x0 - 8) + Math.sin(t * 1.3 + i * 2) * 3;
    const lx = Math.round(x);
    const ly = Math.round(y);
    const col = [P.leaf1, P.leaf2, P.leaf3][i % 3];
    if (onGlass(lx, ly)) put(lx, ly, col);
    if (onGlass(lx + 1, ly) && Math.sin(t * 3 + i) > 0) put(lx + 1, ly, col);
  }
  // Rain: drops running down the glass, a bright head and a short trail.
  for (let i = 0; i < 30; i++) {
    const span = y1 - y0 + 6;
    const speed = 22 + hash(i, 7) * 26;
    const y = y0 - 3 + ((t * speed + hash(i, 8) * span) % span);
    const x = x0 + Math.floor(hash(i, 9) * (x1 - x0 + 1));
    const hy = Math.round(y);
    if (onGlass(x, hy)) put(x, hy, P.rainHi);
    for (let k = 1; k <= 2; k++) if (onGlass(x, hy - k)) put(x, hy - k, P.rain);
  }
  // The fairy lights, each glowing up and down at its own slow pace.
  BULBS.forEach(([bx, by], i) => {
    const on = Math.sin(t * (0.7 + (i % 3) * 0.23) + i * 1.7) > -0.35;
    put(bx, by, (on ? P.bulbs : P.bulbsDim)[i % 3]);
  });
  // Steam: three wisps rising, swaying, thinning out as they go.
  for (let w = 0; w < 3; w++) {
    for (let k = 0; k < 4; k++) {
      const life = (t * 0.55 + k / 4 + w * 0.31) % 1;
      const h = life * 16;
      const x = Math.round(MUG_TOP.x - 2 + w * 2 + Math.sin(t * 1.6 + h * 0.45 + w) * (0.6 + h * 0.12));
      const y = Math.round(MUG_TOP.y - 1 - h);
      if (life < 0.75 || bayer(x, y) > (life - 0.75) * 4) put(x, y, P.steam);
    }
  }
}
