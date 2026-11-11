/**
 * Pure-TypeScript pitch tracking (YIN, de Cheveigné & Kawahara 2002).
 * Used directly in tests and as the fallback when essentia.js is unavailable.
 * The worker prefers essentia's PitchYinProbabilistic when it loads.
 */

import type { PitchTrack } from './types';

export interface YinOptions {
  minHz: number;
  maxHz: number;
  /** CMNDF absolute threshold for voicing. */
  threshold: number;
  /** Integration window length. */
  windowMs: number;
  hopMs: number;
  /** Frames quieter than (loudest frame - gateDb) are treated as silence. */
  gateDb: number;
  /** Absolute silence floor (linear RMS). */
  floorRms: number;
  /** Signal is decimated by an integer factor to roughly this rate before analysis. */
  targetRate: number;
}

export const DEFAULT_YIN: YinOptions = {
  minHz: 60,
  maxHz: 1100,
  threshold: 0.2,
  windowMs: 25,
  hopMs: 5,
  gateDb: 40,
  floorRms: 0.001,
  targetRate: 16000,
};

/** Integer-factor decimation with a windowed-sinc low-pass (Blackman). */
export function decimate(
  samples: Float32Array,
  sampleRate: number,
  targetRate: number,
): { data: Float32Array; rate: number; factor: number } {
  const factor = Math.max(1, Math.floor(sampleRate / targetRate));
  if (factor === 1) return { data: samples, rate: sampleRate, factor };
  const K = 32;
  const taps = 2 * K + 1;
  const fc = 0.45 / factor; // cutoff as a fraction of the input sample rate
  const h = new Float32Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const m = n - K;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;

  const outLen = Math.floor(samples.length / factor);
  const out = new Float32Array(outLen);
  const N = samples.length;
  for (let i = 0; i < outLen; i++) {
    const c = i * factor;
    let acc = 0;
    const lo = Math.max(0, K - c);
    const hi = Math.min(taps, N - c + K);
    for (let n = lo; n < hi; n++) acc += h[n] * samples[c + n - K];
    out[i] = acc;
  }
  return { data: out, rate: sampleRate / factor, factor };
}

/** RMS of frames centred on the given times. */
export function frameRmsAt(samples: Float32Array, sampleRate: number, times: Float32Array, frameSec: number): Float32Array {
  const half = Math.max(1, Math.round((frameSec * sampleRate) / 2));
  const out = new Float32Array(times.length);
  for (let i = 0; i < times.length; i++) {
    const c = Math.round(times[i] * sampleRate);
    const a = Math.max(0, c - half);
    const b = Math.min(samples.length, c + half);
    let s = 0;
    for (let j = a; j < b; j++) s += samples[j] * samples[j];
    out[i] = b > a ? Math.sqrt(s / (b - a)) : 0;
  }
  return out;
}

export function trackPitchYin(samples: Float32Array, sampleRate: number, options: Partial<YinOptions> = {}): PitchTrack {
  const o: YinOptions = { ...DEFAULT_YIN, ...options };
  const { data, rate } = decimate(samples, sampleRate, o.targetRate);

  const W = Math.max(16, Math.round((o.windowMs / 1000) * rate));
  const tauMin = Math.max(2, Math.floor(rate / o.maxHz));
  const tauMax = Math.ceil(rate / o.minHz);
  const hop = Math.max(1, Math.round((o.hopMs / 1000) * rate));
  const frameLen = W + tauMax + 2;
  const nFrames = data.length >= frameLen ? Math.floor((data.length - frameLen) / hop) + 1 : 0;

  const times = new Float32Array(nFrames);
  const f0 = new Float32Array(nFrames);
  const conf = new Float32Array(nFrames);
  const rms = new Float32Array(nFrames);

  // Pass 1: frame energy for gating.
  let peak = 0;
  for (let f = 0; f < nFrames; f++) {
    const s = f * hop;
    times[f] = (s + frameLen / 2) / rate;
    let e = 0;
    for (let j = 0; j < frameLen; j++) e += data[s + j] * data[s + j];
    rms[f] = Math.sqrt(e / frameLen);
    if (rms[f] > peak) peak = rms[f];
  }
  const gate = Math.max(o.floorRms, peak * Math.pow(10, -o.gateDb / 20));

  // Pass 2: YIN on non-silent frames.
  const d = new Float64Array(tauMax + 2);
  const cmndf = new Float64Array(tauMax + 2);
  for (let f = 0; f < nFrames; f++) {
    if (rms[f] < gate) continue;
    const s = f * hop;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let acc = 0;
      const o2 = s + tau;
      for (let j = 0; j < W; j++) {
        const diff = data[s + j] - data[o2 + j];
        acc += diff * diff;
      }
      d[tau] = acc;
    }
    cmndf[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau];
      cmndf[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }

    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmndf[tau] < o.threshold) {
        while (tau + 1 <= tauMax && cmndf[tau + 1] < cmndf[tau]) tau++;
        best = tau;
        break;
      }
    }
    let globalMin = tauMin;
    if (best < 0) {
      for (let tau = tauMin; tau <= tauMax; tau++) if (cmndf[tau] < cmndf[globalMin]) globalMin = tau;
      conf[f] = Math.max(0, 1 - cmndf[globalMin]);
      continue; // unvoiced
    }

    // Parabolic interpolation around the dip.
    const a = cmndf[best - 1];
    const b = cmndf[best];
    const c = cmndf[best + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const tauRefined = best + Math.max(-1, Math.min(1, shift));
    f0[f] = rate / tauRefined;
    conf[f] = Math.max(0, Math.min(1, 1 - b));
  }

  // Report a finer (16 ms) energy envelope than the analysis frame, so short
  // breaths between notes are visible to the note segmenter.
  const fineRms = frameRmsAt(data, rate, times, 0.016);
  return { hopSec: hop / rate, times, f0Hz: f0, confidence: conf, rms: fineRms, engine: 'yin-js' };
}
