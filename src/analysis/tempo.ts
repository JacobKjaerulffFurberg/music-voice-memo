/**
 * Tempo + beat-grid estimation from sung note onsets (inter-onset intervals).
 *
 * 1. Pairwise onset "autocorrelation" ac(lag) = Σ w_i w_j · G(t_j − t_i − lag)
 *    evaluated in continuous time (no envelope quantisation → sub-BPM precision).
 * 2. Score each candidate period P in the target range with a comb over
 *    multiples kP, minus a penalty for energy at (k − ½)P (which would mean
 *    P is really twice the beat), times a weak log-tempo prior.
 * 3. Refine period and phase with a weighted least-squares fit of onsets to
 *    the grid (only onsets close to a grid line count as inliers).
 */

import { clamp, foldBpm } from './music';
import type { Note, TempoResult } from './types';

export interface Onset {
  time: number;
  weight: number;
}

export interface TempoOptions {
  minBpm: number;
  maxBpm: number;
  /** Onset timing jitter assumed by the correlation kernel. */
  sigmaSec: number;
  priorCenterBpm: number;
  /** Prior width in octaves. */
  priorOctaves: number;
  stepBpm: number;
}

export const DEFAULT_TEMPO_OPTIONS: TempoOptions = {
  minBpm: 70,
  maxBpm: 160,
  sigmaSec: 0.03,
  priorCenterBpm: 110,
  priorOctaves: 1,
  stepBpm: 0.25,
};

export function onsetsFromNotes(notes: Note[]): Onset[] {
  return notes.map((n) => ({ time: n.start, weight: Math.sqrt(clamp(n.duration, 0.05, 1)) }));
}

interface Pair {
  dt: number;
  w: number;
}

function buildPairs(onsets: Onset[], maxLag: number): Pair[] {
  const pairs: Pair[] = [];
  const sorted = [...onsets].sort((a, b) => a.time - b.time);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const dt = sorted[j].time - sorted[i].time;
      if (dt > maxLag) break;
      pairs.push({ dt, w: sorted[i].weight * sorted[j].weight });
    }
  }
  return pairs;
}

function ac(pairs: Pair[], lag: number, sigma: number): number {
  const inv = 1 / (2 * sigma * sigma);
  const reach = 4 * sigma;
  let s = 0;
  for (const p of pairs) {
    const d = p.dt - lag;
    if (d > -reach && d < reach) s += p.w * Math.exp(-d * d * inv);
  }
  return s;
}

function circularPhase(onsets: Onset[], period: number): number {
  let sx = 0;
  let sy = 0;
  for (const o of onsets) {
    const th = (2 * Math.PI * o.time) / period;
    sx += o.weight * Math.cos(th);
    sy += o.weight * Math.sin(th);
  }
  const ang = Math.atan2(sy, sx);
  return ((ang / (2 * Math.PI)) * period + period) % period;
}

/** Weighted least-squares refinement of (period, phase) using onsets near grid lines. */
export function refineGrid(
  onsets: Onset[],
  period: number,
  phase: number,
  iterations = 4,
): { period: number; phase: number; fit: number } {
  let P = period;
  let phi = phase;
  for (let it = 0; it < iterations; it++) {
    const tol = (it === 0 ? 0.25 : 0.15) * P;
    let sw = 0;
    let sk = 0;
    let st = 0;
    let skk = 0;
    let skt = 0;
    for (const o of onsets) {
      const k = Math.round((o.time - phi) / P);
      const r = o.time - phi - k * P;
      if (Math.abs(r) > tol) continue;
      sw += o.weight;
      sk += o.weight * k;
      st += o.weight * o.time;
      skk += o.weight * k * k;
      skt += o.weight * k * o.time;
    }
    if (sw <= 0) break;
    const varK = skk / sw - (sk / sw) ** 2;
    if (varK < 1e-9) break;
    const cov = skt / sw - (sk / sw) * (st / sw);
    const b = cov / varK;
    if (!(b > 0)) break;
    P = b;
    phi = st / sw - b * (sk / sw);
  }
  let wsum = 0;
  let fit = 0;
  for (const o of onsets) {
    const k = Math.round((o.time - phi) / P);
    const r = o.time - phi - k * P;
    wsum += o.weight;
    fit += o.weight * Math.exp(-0.5 * (r / (0.04 * P)) ** 2);
  }
  return { period: P, phase: phi, fit: wsum > 0 ? fit / wsum : 0 };
}

function gridFields(period: number, phase: number, firstOnset: number): { gridPhaseMs: number; firstBeatMs: number } {
  const gridPhase = ((phase % period) + period) % period;
  const firstBeat = phase + Math.round((firstOnset - phase) / period) * period;
  return { gridPhaseMs: gridPhase * 1000, firstBeatMs: firstBeat * 1000 };
}

export function tempoFromOnsets(onsets: Onset[], options: Partial<TempoOptions> = {}): TempoResult | null {
  const o: TempoOptions = { ...DEFAULT_TEMPO_OPTIONS, ...options };
  if (onsets.length < 4) return null;
  // Search an octave beyond the target range on both sides, then fold: a true
  // 180 BPM pulse must be found as 180 (and folded to 90), not as a 2:3 alias.
  const searchMin = o.minBpm / 2;
  const searchMax = o.maxBpm * 2;
  const maxPeriod = 60 / searchMin;
  const pairs = buildPairs(onsets, 4 * maxPeriod + 4 * o.sigmaSec);

  let bestScore = -Infinity;
  let bestP = 60 / o.priorCenterBpm;
  for (let bpm = searchMin; bpm < searchMax; bpm += o.stepBpm * Math.max(1, bpm / o.maxBpm)) {
    const P = 60 / bpm;
    let hit = 0;
    let miss = 0;
    for (let k = 1; k <= 4; k++) {
      hit += ac(pairs, k * P, o.sigmaSec);
      miss += ac(pairs, (k - 0.5) * P, o.sigmaSec);
    }
    const prior = Math.exp(-0.5 * (Math.log2(bpm / o.priorCenterBpm) / o.priorOctaves) ** 2);
    const score = (hit - 0.5 * miss) * (0.7 + 0.3 * prior);
    if (score > bestScore) {
      bestScore = score;
      bestP = P;
    }
  }

  const phase0 = circularPhase(onsets, bestP);
  const { period, phase, fit } = refineGrid(onsets, bestP, phase0);
  const rawBpm = 60 / period;
  const bpm = foldBpm(rawBpm, o.minBpm, o.maxBpm);
  const P = 60 / bpm;
  const firstOnset = Math.min(...onsets.map((x) => x.time));
  return {
    bpm,
    rawBpm,
    ...gridFields(P, phase, firstOnset),
    confidence: clamp(fit * Math.min(1, onsets.length / 8), 0, 1),
    source: 'note-ioi',
  };
}

export function tempoFromNotes(notes: Note[], options: Partial<TempoOptions> = {}): TempoResult | null {
  return tempoFromOnsets(onsetsFromNotes(notes), options);
}

/**
 * Convert an essentia RhythmExtractor2013 output into a TempoResult:
 * fold the BPM, fit the grid phase to the beat ticks.
 * Multifeature confidence is in [0, 5.32]; we normalise it to 0..1.
 */
export function tempoFromBeatTicks(
  rawBpm: number,
  ticks: ArrayLike<number>,
  rawConfidence: number,
  firstNoteTime: number | null,
  options: Partial<TempoOptions> = {},
): TempoResult | null {
  const o: TempoOptions = { ...DEFAULT_TEMPO_OPTIONS, ...options };
  if (!(rawBpm > 0) || ticks.length < 2) return null;
  const bpm = foldBpm(rawBpm, o.minBpm, o.maxBpm);
  const P = 60 / bpm;
  const onsets: Onset[] = Array.from(ticks, (t) => ({ time: t, weight: 1 }));
  const phase = circularPhase(onsets, P);
  const anchor = firstNoteTime ?? (onsets[0]?.time ?? 0);
  return {
    bpm,
    rawBpm,
    ...gridFields(P, phase, anchor),
    confidence: clamp(rawConfidence / 5.32, 0, 1),
    source: 'essentia-rhythm2013',
  };
}

export function chooseTempo(candidates: TempoResult[]): TempoResult | null {
  let best: TempoResult | null = null;
  for (const c of candidates) if (!best || c.confidence > best.confidence) best = c;
  return best;
}
