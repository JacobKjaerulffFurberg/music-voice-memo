/**
 * Thin, typed adapter around essentia.js (WASM). Only used inside the
 * analysis worker; every call is optional and failures fall back to the
 * pure-TS implementations.
 */

import { keyName, parsePitchClass } from './music';
import { frameRmsAt } from './pitch';
import type { RhythmInput } from './pipeline';
import type { KeyResult, Mode, PitchTrack } from './types';

interface EssentiaVector {
  delete(): void;
  size(): number;
}

export interface EssentiaApi {
  version: string;
  arrayToVector(a: Float32Array): EssentiaVector;
  vectorToArray(v: EssentiaVector): Float32Array;
  PitchYinProbabilistic(
    signal: EssentiaVector,
    frameSize: number,
    hopSize: number,
    lowRMSThreshold: number,
    outputUnvoiced: 'zero' | 'abs' | 'negative',
    preciseTime: boolean,
    sampleRate: number,
  ): { pitch: EssentiaVector; voicedProbabilities: EssentiaVector };
  KeyExtractor(
    audio: EssentiaVector,
    averageDetuningCorrection: boolean,
    frameSize: number,
    hopSize: number,
    hpcpSize: number,
    maxFrequency: number,
    maximumSpectralPeaks: number,
    minFrequency: number,
    pcpThreshold: number,
    profileType: string,
    sampleRate: number,
    spectralPeaksThreshold: number,
    tuningFrequency: number,
    weightType: string,
    windowType: string,
  ): { key: string; scale: string; strength: number };
  RhythmExtractor2013(
    signal: EssentiaVector,
    maxTempo: number,
    method: 'multifeature' | 'degara',
    minTempo: number,
  ): { bpm: number; ticks: EssentiaVector; confidence: number; estimates: EssentiaVector; bpmIntervals: EssentiaVector };
}

interface WasmModuleShape {
  EssentiaJS?: unknown;
  calledRun?: boolean;
  onRuntimeInitialized?: () => void;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

async function waitForRuntime(mod: unknown): Promise<unknown> {
  // Some builds export a factory, others an already-instantiated module.
  const resolved: unknown = typeof mod === 'function' ? await (mod as () => Promise<unknown>)() : mod;
  if (!isObject(resolved)) throw new Error('essentia: unexpected WASM module shape');
  const m = resolved as WasmModuleShape;
  if (m.EssentiaJS) return resolved;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('essentia: WASM runtime init timed out')), 20000);
    const prev = m.onRuntimeInitialized;
    m.onRuntimeInitialized = () => {
      clearTimeout(timer);
      prev?.();
      resolve();
    };
    if (m.EssentiaJS) {
      clearTimeout(timer);
      resolve();
    }
  });
  return resolved;
}

let loading: Promise<EssentiaApi> | null = null;

export function loadEssentia(): Promise<EssentiaApi> {
  loading ??= (async () => {
    const [wasm, core] = await Promise.all([
      import('essentia.js/dist/essentia-wasm.es.js'),
      import('essentia.js/dist/essentia.js-core.es.js'),
    ]);
    const mod = await waitForRuntime(wasm.EssentiaWASM);
    const Essentia = core.default;
    return new Essentia(mod) as unknown as EssentiaApi;
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

function withVector<T>(es: EssentiaApi, data: Float32Array, fn: (v: EssentiaVector) => T): T {
  const v = es.arrayToVector(data);
  try {
    return fn(v);
  } finally {
    v.delete();
  }
}

function toArray(es: EssentiaApi, v: EssentiaVector): Float32Array {
  try {
    return v.size() > 0 ? es.vectorToArray(v) : new Float32Array(0);
  } finally {
    v.delete();
  }
}

export function essentiaPitch(es: EssentiaApi, samples: Float32Array, sampleRate: number): PitchTrack {
  // ~46 ms frames / ~5.3 ms hop at 48 kHz.
  const frameSize = sampleRate > 32000 ? 2048 : 1024;
  const hopSize = sampleRate > 32000 ? 256 : 128;
  const out = withVector(es, samples, (v) =>
    es.PitchYinProbabilistic(v, frameSize, hopSize, 0.005, 'zero', false, sampleRate),
  );
  const f0 = toArray(es, out.pitch);
  const prob = toArray(es, out.voicedProbabilities);
  const n = Math.min(f0.length, prob.length);
  const hopSec = hopSize / sampleRate;
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = i * hopSec;
  const f0Hz = new Float32Array(n);
  const confidence = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    f0Hz[i] = f0[i] > 0 ? f0[i] : 0;
    confidence[i] = prob[i];
  }
  return {
    hopSec,
    times,
    f0Hz,
    confidence,
    rms: frameRmsAt(samples, sampleRate, times, 0.016),
    engine: 'essentia-pyin',
  };
}

export function essentiaKey(es: EssentiaApi, samples: Float32Array, sampleRate: number, tuningHz: number): KeyResult | null {
  const r = withVector(es, samples, (v) =>
    es.KeyExtractor(v, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate', sampleRate, 0.0001, tuningHz, 'cosine', 'hann'),
  );
  const tonic = parsePitchClass(r.key);
  if (tonic < 0) return null;
  const mode: Mode = r.scale === 'minor' ? 'minor' : 'major';
  const name = keyName(tonic, mode);
  return {
    tonic,
    mode,
    name,
    confidence: Math.max(0, Math.min(1, r.strength)),
    candidates: [{ tonic, mode, name, score: r.strength }],
    source: 'essentia-keyextractor',
  };
}

/** Linear-interpolation resampler (RhythmExtractor2013 assumes 44.1 kHz). */
export function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r;
    const k = Math.floor(p);
    const f = p - k;
    out[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? 0) * f;
  }
  return out;
}

export function essentiaRhythm(es: EssentiaApi, samples: Float32Array, sampleRate: number): RhythmInput | null {
  const x = resampleLinear(samples, sampleRate, 44100);
  const r = withVector(es, x, (v) => es.RhythmExtractor2013(v, 208, 'multifeature', 40));
  const ticks = toArray(es, r.ticks);
  r.estimates.delete();
  r.bpmIntervals.delete();
  if (!(r.bpm > 0)) return null;
  return { bpm: r.bpm, ticks, confidence: r.confidence };
}
