/**
 * Singing over the song without headphones: the mic hears the speakers too. We know exactly what
 * was played, so we can find it in the recording and take it out again.
 *
 *  1. `findDelay`: where the played song sits in the recording (the phone's real round trip,
 *     speaker → mic, which the browser doesn't report). Also says whether it was heard at all.
 *  2. `cancelBleed`: a filter fitted to how the song reached the mic (speaker, room, mic)
 *     subtracts it, leaving the voice.
 *
 * Pure functions on plain arrays, so they are tested without audio hardware.
 */

/**
 * Box-average decimation, then the change from one value to the next: held chord tones repeat
 * every few ms and would fool the search, so it leans on what changes (hits, note starts).
 */
function shrink(x: Float32Array, factor: number): Float32Array {
  const n = Math.floor(x.length / factor);
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += x[i * factor + j];
    s /= factor;
    out[i] = s - prev;
    prev = s;
  }
  return out;
}

export interface Delay {
  /** Seconds the recording is late against the reference. */
  sec: number;
  /** Normalised correlation at that delay, 0–1: how clearly the song was heard. */
  strength: number;
}

/**
 * The delay (0 … maxSec) at which `rec` best matches `ref` (both at `sampleRate`, aligned at 0
 * as if there were no delay). Searched at ~4 kHz, then refined at full rate around the peak.
 */
export function findDelay(rec: Float32Array, ref: Float32Array, sampleRate: number, maxSec = 0.6): Delay {
  const f = Math.max(1, Math.round(sampleRate / 4000));
  const r = shrink(rec, f);
  const q = shrink(ref, f);
  const maxLag = Math.min(Math.round((maxSec * sampleRate) / f), r.length - 1);
  const n = Math.min(r.length, q.length);
  let best = 0;
  let bestC = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = lag; i < n; i++) c += r[i] * q[i - lag];
    if (c > bestC) {
      bestC = c;
      best = lag;
    }
  }
  // Refine at full rate within ± one coarse step.
  const N = Math.min(rec.length, ref.length);
  let fine = best * f;
  let fineC = -Infinity;
  let er = 0;
  let eq = 0;
  for (let lag = Math.max(0, (best - 1) * f); lag <= Math.min((best + 1) * f, N - 1); lag++) {
    let c = 0;
    for (let i = lag; i < N; i += 2) c += rec[i] * ref[i - lag];
    if (c > fineC) {
      fineC = c;
      fine = lag;
    }
  }
  for (let i = fine; i < N; i += 2) {
    er += rec[i] * rec[i];
    eq += ref[i - fine] * ref[i - fine];
  }
  const strength = er > 0 && eq > 0 ? Math.max(0, fineC / Math.sqrt(er * eq)) : 0;
  return { sec: fine / sampleRate, strength };
}

/** Solve the symmetric Toeplitz system T(r) w = p (Levinson). */
function toeplitzSolve(r: Float64Array, p: Float64Array): Float64Array {
  const n = p.length;
  const w = new Float64Array(n);
  let a = new Float64Array(n);
  let err = r[0];
  w[0] = p[0] / r[0];
  a[0] = 1;
  for (let m = 1; m < n; m++) {
    // Extend the prediction filter a.
    let k = 0;
    for (let j = 0; j < m; j++) k += a[j] * r[m - j];
    k = -k / err;
    const next = new Float64Array(n);
    for (let j = 0; j <= m; j++) next[j] = a[j] + k * (m - j < m ? a[m - j] : 0);
    next[m] = k;
    next[0] = 1;
    for (let j = 1; j < m; j++) next[j] = a[j] + k * a[m - j];
    a = next;
    err *= 1 - k * k;
    if (!(err > 0)) break;
    // Extend the solution w.
    let e = 0;
    for (let j = 0; j < m; j++) e += w[j] * r[m - j];
    const g = (p[m] - e) / err;
    for (let j = 0; j <= m; j++) w[j] += g * a[m - j];
  }
  return w;
}

/**
 * The recording with the song (as heard through speaker, room and mic) taken out. `delay` is in samples
 * (from findDelay). The way the song reaches the mic doesn't change during a take, so one filter
 * is fitted over the whole recording (least squares: the voice, unrelated to the song, averages
 * out of the fit) and the song through it is subtracted.
 */
export function cancelBleed(rec: Float32Array, ref: Float32Array, delay: number, taps = 256): Float32Array {
  const pre = 16;
  const off = delay - pre; // ref index = i - off - k
  const at = (j: number): number => (j >= 0 && j < ref.length ? ref[j] : 0);
  const r = new Float64Array(taps);
  const p = new Float64Array(taps);
  const from = Math.max(0, off);
  const to = Math.min(rec.length, ref.length + off);
  for (let k = 0; k < taps; k++) {
    let sr = 0;
    let sp = 0;
    for (let i = from; i < to; i++) {
      const x = ref[i - off];
      sr += x * at(i - off - k);
      sp += rec[i] * at(i - off - k);
    }
    r[k] = sr;
    p[k] = sp;
  }
  r[0] *= 1.001; // a touch of regularisation: held tones make the system nearly singular
  const w = toeplitzSolve(r, p);
  const out = new Float32Array(rec.length);
  for (let i = 0; i < rec.length; i++) {
    let y = 0;
    for (let k = 0; k < taps; k++) y += w[k] * at(i - off - k);
    out[i] = rec[i] - y;
  }
  return out;
}
