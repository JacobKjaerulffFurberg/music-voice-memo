/**
 * FFT, spectrogram and onset (attack) detection. Pure functions.
 */

/** In-place iterative radix-2 complex FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export interface Spectrogram {
  sampleRate: number;
  fftSize: number;
  hop: number;
  /** Frame centre times, seconds. */
  times: Float32Array;
  /** Magnitude spectra (fftSize/2 + 1 bins), Hann-windowed, normalised so a full-scale sine peaks at ~1. */
  mags: Float32Array[];
  /** RMS of each frame (time domain). */
  rms: Float32Array;
}

export function stft(x: Float32Array, sampleRate: number, fftSize: number, hop: number): Spectrogram {
  const win = new Float64Array(fftSize);
  let wsum = 0;
  for (let i = 0; i < fftSize; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize);
    wsum += win[i];
  }
  const norm = 2 / wsum;
  const half = fftSize / 2;
  const nFrames = Math.max(0, Math.floor((x.length - fftSize) / hop) + 1);
  const times = new Float32Array(nFrames);
  const rms = new Float32Array(nFrames);
  const mags: Float32Array[] = [];
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let f = 0; f < nFrames; f++) {
    const s = f * hop;
    let e = 0;
    for (let i = 0; i < fftSize; i++) {
      const v = x[s + i];
      e += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const m = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) m[k] = Math.hypot(re[k], im[k]) * norm;
    mags.push(m);
    rms[f] = Math.sqrt(e / fftSize);
    times[f] = (s + fftSize / 2) / sampleRate;
  }
  return { sampleRate, fftSize, hop, times, mags, rms };
}

/** Log-compressed, half-wave-rectified spectral flux (30 Hz – 8 kHz). */
export function spectralFlux(spec: Spectrogram, gamma = 100): Float32Array {
  const { mags, sampleRate, fftSize } = spec;
  const k0 = Math.max(1, Math.floor((30 * fftSize) / sampleRate));
  const k1 = Math.min(fftSize / 2, Math.ceil((8000 * fftSize) / sampleRate));
  const out = new Float32Array(mags.length);
  for (let t = 1; t < mags.length; t++) {
    const a = mags[t];
    const b = mags[t - 1];
    let s = 0;
    for (let k = k0; k <= k1; k++) {
      const d = Math.log1p(gamma * a[k]) - Math.log1p(gamma * b[k]);
      if (d > 0) s += d;
    }
    out[t] = s;
  }
  return out;
}

export interface Onset {
  time: number;
  strength: number;
}

/**
 * Peak-pick an onset envelope: local maximum within ±`waitSec`, above a moving
 * average + `delta` × global max, and above an absolute floor.
 */
export function pickOnsets(env: Float32Array, times: Float32Array, hopSec: number, delta = 0.07, waitSec = 0.05, avgSec = 0.1): Onset[] {
  let max = 0;
  for (const v of env) max = Math.max(max, v);
  if (max <= 0) return [];
  const w = Math.max(1, Math.round(waitSec / hopSec));
  const a = Math.max(1, Math.round(avgSec / hopSec));
  const out: Onset[] = [];
  let last = -Infinity;
  for (let t = 1; t < env.length - 1; t++) {
    const v = env[t];
    let isMax = true;
    for (let j = Math.max(0, t - w); j <= Math.min(env.length - 1, t + w); j++) {
      if (env[j] > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    let mean = 0;
    let cnt = 0;
    for (let j = Math.max(0, t - a); j <= Math.min(env.length - 1, t + a); j++) {
      mean += env[j];
      cnt++;
    }
    mean /= cnt;
    if (v < mean + delta * max || v < 0.05 * max) continue;
    if (times[t] - last < waitSec) continue;
    // The flux peaks when the attack reaches the window centre: interpolate the peak.
    const a0 = env[t - 1];
    const a2 = env[t + 1];
    const den = a0 - 2 * v + a2;
    const p = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a0 - a2)) / den)) : 0;
    out.push({ time: times[t] + p * hopSec, strength: v / max });
    last = times[t];
  }
  return out;
}

/** Onsets of a signal (small 1024-point frames at ~22 kHz, ~11 ms hop). */
export function detectOnsets(x: Float32Array, sampleRate: number): Onset[] {
  const fftSize = sampleRate > 32000 ? 2048 : 1024;
  const hop = fftSize / 4;
  const spec = stft(x, sampleRate, fftSize, hop);
  return pickOnsets(spectralFlux(spec), spec.times, hop / sampleRate);
}
