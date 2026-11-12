/**
 * Tempo + beat grid + bar 1 from note onsets.
 *
 * 1. Tempo + phase: every candidate period P in the target range is scored by
 *    how well the onsets sit on a rhythmic ladder anchored on the beat — full
 *    credit on the beat, partial on 8ths / triplets / 16ths — at the best
 *    phase. This rejects the classic aliases of inter-onset methods (the 8th
 *    pulse, the dotted-quarter 2:3 pulse) because their ladders miss the notes.
 * 2. Refine period + phase with a least-squares fit of the on-beat / on-8th
 *    onsets to the grid.
 * 3. Bar 1: of the four possible bar offsets, pick the one whose beats 1 (and,
 *    weaker, 3) carry the loud / long notes, then place it on the first bar
 *    line at or after the first note (a sung pickup stays before bar 1).
 */

import { clamp, foldBpm } from './music';
import type { Note, TempoResult } from './types';

export interface Onset {
  time: number;
  /** How much the onset counts for tempo (longer notes more). */
  weight: number;
  /** Metric accent 0..1 (loudness × length) used to find beat 1. Defaults to weight. */
  accent?: number;
}

export interface TempoOptions {
  minBpm: number;
  maxBpm: number;
  /** Onset timing jitter assumed by the grid score (seconds). */
  sigmaSec: number;
  priorCenterBpm: number;
  /** Prior width in octaves. */
  priorOctaves: number;
  stepBpm: number;
  beatsPerBar: number;
}

export const DEFAULT_TEMPO_OPTIONS: TempoOptions = {
  minBpm: 70,
  maxBpm: 160,
  sigmaSec: 0.035,
  priorCenterBpm: 105,
  priorOctaves: 1,
  stepBpm: 0.5,
  beatsPerBar: 4,
};

export function onsetsFromNotes(notes: Note[]): Onset[] {
  return notes.map((n) => {
    const len = Math.sqrt(clamp(n.duration, 0.05, 1));
    const vel = (n.velocity ?? 90) / 127;
    return { time: n.start, weight: len * (0.5 + 0.5 * vel), accent: len * vel * vel };
  });
}

const frac = (x: number): number => x - Math.round(x);

/** How well one onset sits on the rhythmic ladder of a beat grid (0..1). */
function ladder(x: number, P: number, inv2s2: number): number {
  const g = (r: number): number => Math.exp(-r * r * inv2s2);
  const beat = g(frac(x) * P);
  const eighth = g((frac(2 * x) * P) / 2);
  const trip = g((frac(3 * x) * P) / 3);
  const six = g((frac(4 * x) * P) / 4);
  return Math.max(beat, 0.55 * eighth, 0.3 * trip, 0.2 * six);
}

/** Weighted mean ladder score of all onsets on the grid (P, phase). */
export function gridScore(onsets: Onset[], P: number, phase: number, sigmaSec = DEFAULT_TEMPO_OPTIONS.sigmaSec): number {
  const sigma = Math.min(sigmaSec, 0.09 * P);
  const inv = 1 / (2 * sigma * sigma);
  let s = 0;
  let w = 0;
  for (const o of onsets) {
    s += o.weight * ladder((o.time - phase) / P, P, inv);
    w += o.weight;
  }
  return w > 0 ? s / w : 0;
}

/** Best phase in [0, P) for a fixed period (coarse scan + local refinement). */
function bestPhase(onsets: Onset[], P: number, sigmaSec: number): { phase: number; score: number } {
  const steps = 32;
  let best = { phase: 0, score: -1 };
  for (let i = 0; i < steps; i++) {
    const phase = (i / steps) * P;
    const score = gridScore(onsets, P, phase, sigmaSec);
    if (score > best.score) best = { phase, score };
  }
  let step = P / steps / 2;
  for (let it = 0; it < 5; it++, step /= 2) {
    for (const d of [-step, step]) {
      const score = gridScore(onsets, P, best.phase + d, sigmaSec);
      if (score > best.score) best = { phase: best.phase + d, score };
    }
  }
  return best;
}

/** Weighted least-squares refinement of (period, phase) using onsets on beats or 8ths. */
export function refineGrid(
  onsets: Onset[],
  period: number,
  phase: number,
  iterations = 4,
): { period: number; phase: number; fit: number } {
  let P = period;
  let phi = phase;
  for (let it = 0; it < iterations; it++) {
    // Positions in half-beats: 8th notes pin the grid as well as quarters.
    const tol = (it === 0 ? 0.2 : 0.14) * P;
    let sw = 0;
    let sk = 0;
    let st = 0;
    let skk = 0;
    let skt = 0;
    for (const o of onsets) {
      const k = Math.round((2 * (o.time - phi)) / P) / 2;
      const r = o.time - phi - k * P;
      if (Math.abs(r) > tol / (Number.isInteger(k) ? 1 : 2)) continue;
      const w = o.weight * (Number.isInteger(k) ? 1 : 0.5);
      sw += w;
      sk += w * k;
      st += w * o.time;
      skk += w * k * k;
      skt += w * k * o.time;
    }
    if (sw <= 0) break;
    const varK = skk / sw - (sk / sw) ** 2;
    if (varK < 1e-9) break;
    const b = (skt / sw - (sk / sw) * (st / sw)) / varK;
    // Never let the fit run off to a different tempo.
    if (!(b > 0.95 * period && b < 1.05 * period)) break;
    P = b;
    phi = st / sw - b * (sk / sw);
  }
  let wsum = 0;
  let fit = 0;
  for (const o of onsets) {
    const r = frac((o.time - phi) / P) * P;
    const r2 = (frac((2 * (o.time - phi)) / P) * P) / 2;
    wsum += o.weight;
    fit += o.weight * Math.max(Math.exp(-0.5 * (r / (0.05 * P)) ** 2), 0.6 * Math.exp(-0.5 * (r2 / (0.05 * P)) ** 2));
  }
  return { period: P, phase: phi, fit: wsum > 0 ? fit / wsum : 0 };
}

/**
 * Time of bar 1 for a known beat grid: picks which beat of the bar is "1"
 * from where the accented (loud, long) notes fall, then returns the first bar
 * line at or after the first onset (minus a little slack for early singing).
 */
export function findDownbeat(onsets: Onset[], period: number, phase: number, beatsPerBar = 4): number {
  if (onsets.length === 0) return phase;
  const P = period;
  const first = Math.min(...onsets.map((o) => o.time));
  const score = new Array<number>(beatsPerBar).fill(0);
  // Index beats from the first onset so "beat 0" is the first sung beat.
  const k0 = Math.round((first - phase) / P);
  for (const o of onsets) {
    const x = (o.time - phase) / P;
    const k = Math.round(x);
    if (Math.abs(x - k) > 0.2) continue; // off-beat notes don't say where 1 is
    const a = o.accent ?? o.weight;
    const pos = (((k - k0) % beatsPerBar) + beatsPerBar) % beatsPerBar;
    score[pos] += a;
    if (beatsPerBar === 4) score[(pos + 2) % 4] += 0.35 * a; // beat 3 is the next-strongest
  }
  // Mild prior: singers usually start on beat 1.
  score[0] *= 1.5;
  let best = 0;
  for (let i = 1; i < beatsPerBar; i++) if (score[i] > score[best]) best = i;
  const bar = phase + (k0 + best) * P; // a bar line near the start
  const barLen = beatsPerBar * P;
  // First bar line at or after the first note (a pickup stays before it).
  return bar + Math.ceil((first - 0.25 * P - bar) / barLen) * barLen;
}

/** Re-fit phase + bar 1 for a given tempo (used when the BPM is set by hand). */
export function fitGridAtBpm(onsets: Onset[], bpm: number, options: Partial<TempoOptions> = {}): number | null {
  const o: TempoOptions = { ...DEFAULT_TEMPO_OPTIONS, ...options };
  if (onsets.length < 2 || !(bpm > 0)) return null;
  const P = 60 / bpm;
  const { phase } = bestPhase(onsets, P, o.sigmaSec);
  // Keep the tempo fixed; only nudge phase with a fixed-period fit.
  let phi = phase;
  let sw = 0;
  let sr = 0;
  for (const on of onsets) {
    const r = frac((on.time - phi) / P) * P;
    if (Math.abs(r) > 0.15 * P) continue;
    sw += on.weight;
    sr += on.weight * r;
  }
  if (sw > 0) phi += sr / sw;
  return findDownbeat(onsets, P, phi, o.beatsPerBar);
}

function prior(bpm: number, o: TempoOptions): number {
  return Math.exp(-0.5 * (Math.log2(bpm / o.priorCenterBpm) / o.priorOctaves) ** 2);
}

/**
 * Share (0..1) of gaps between consecutive on-beat onsets that are an odd
 * number (> 1) of beats. Strums on 1 and 3 are 2 beats apart at the true tempo
 * but 3 beats apart at the 3:2 alias, which otherwise fits just as well.
 */
function oddGaps(onsets: Onset[], P: number, phase: number): number {
  let prev: number | null = null;
  let odd = 0;
  let all = 0;
  for (const o of onsets) {
    const x = (o.time - phase) / P;
    const k = Math.round(x);
    if (Math.abs(x - k) > 0.15) continue;
    if (prev !== null && k > prev) {
      const d = k - prev;
      all += o.weight;
      if (d > 1 && d % 2 === 1) odd += o.weight;
    }
    prev = k;
  }
  return all > 0 ? odd / all : 0;
}

/** Comparable score of one tempo: grid fit × tempo prior × penalty for 3-beat gaps. */
function candidateScore(onsets: Onset[], bpm: number, o: TempoOptions): { phase: number; score: number } {
  const P = 60 / bpm;
  const { phase, score } = bestPhase(onsets, P, o.sigmaSec);
  const odd = oddGaps(onsets, P, phase);
  return { phase, score: score * (0.85 + 0.15 * prior(bpm, o)) * (1 - 0.2 * odd) };
}

export function tempoFromOnsets(input: Onset[], options: Partial<TempoOptions> = {}): TempoResult | null {
  const o: TempoOptions = { ...DEFAULT_TEMPO_OPTIONS, ...options };
  const onsets = [...input].sort((a, b) => a.time - b.time);
  if (onsets.length < 4) return null;
  const scored: { bpm: number; phase: number; score: number }[] = [];
  for (let bpm = o.minBpm; bpm < o.maxBpm; bpm += o.stepBpm) {
    scored.push({ bpm, ...candidateScore(onsets, bpm, o) });
  }
  // Fine search around the best few coarse peaks.
  scored.sort((a, b) => b.score - a.score);
  let best = scored[0];
  for (const c of scored.slice(0, 4)) {
    for (let bpm = c.bpm - o.stepBpm; bpm <= c.bpm + o.stepBpm; bpm += 0.1) {
      const c2 = candidateScore(onsets, bpm, o);
      if (c2.score > best.score) best = { bpm, ...c2 };
    }
  }

  const { period, phase, fit } = refineGrid(onsets, 60 / best.bpm, best.phase);
  const bpm = clamp(60 / period, o.minBpm * 0.97, o.maxBpm * 1.03);
  const P = 60 / bpm;
  const firstBeat = findDownbeat(onsets, P, phase, o.beatsPerBar);
  return {
    bpm,
    rawBpm: bpm,
    gridPhaseMs: (((firstBeat % P) + P) % P) * 1000,
    firstBeatMs: firstBeat * 1000,
    confidence: clamp(fit * Math.min(1, onsets.length / 8), 0, 1),
    source: 'note-ioi',
  };
}

export function tempoFromNotes(notes: Note[], options: Partial<TempoOptions> = {}): TempoResult | null {
  return tempoFromOnsets(onsetsFromNotes(notes), options);
}

/**
 * Convert an essentia RhythmExtractor2013 output into a TempoResult: fold the
 * BPM, then fit phase and bar 1 to the sung onsets when there are any (beat
 * ticks on a voice are unreliable), else to the ticks.
 * Multifeature confidence is in [0, 5.32]; we normalise it to 0..1.
 */
export function tempoFromBeatTicks(
  rawBpm: number,
  ticks: ArrayLike<number>,
  rawConfidence: number,
  onsets: Onset[] | null,
  options: Partial<TempoOptions> = {},
): TempoResult | null {
  const o: TempoOptions = { ...DEFAULT_TEMPO_OPTIONS, ...options };
  if (!(rawBpm > 0) || ticks.length < 2) return null;
  const bpm = foldBpm(rawBpm, o.minBpm, o.maxBpm);
  const P = 60 / bpm;
  const pts: Onset[] = onsets && onsets.length >= 4 ? onsets : Array.from(ticks, (t) => ({ time: t, weight: 1 }));
  const firstBeat = fitGridAtBpm(pts, bpm, o) ?? 0;
  return {
    bpm,
    rawBpm,
    gridPhaseMs: (((firstBeat % P) + P) % P) * 1000,
    firstBeatMs: firstBeat * 1000,
    confidence: clamp(rawConfidence / 5.32, 0, 1),
    source: 'essentia-rhythm2013',
  };
}

/**
 * Pick among candidates. With onsets, every candidate is judged on the same
 * scale (how well the notes sit on its grid); otherwise by its own confidence.
 */
export function chooseTempo(candidates: TempoResult[], input: Onset[] = [], options: Partial<TempoOptions> = {}): TempoResult | null {
  const o: TempoOptions = { ...DEFAULT_TEMPO_OPTIONS, ...options };
  const onsets = [...input].sort((a, b) => a.time - b.time);
  if (candidates.length <= 1 || onsets.length < 4) {
    let best: TempoResult | null = null;
    for (const c of candidates) if (!best || c.confidence > best.confidence) best = c;
    return best;
  }
  let best: TempoResult | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const s = candidateScore(onsets, c.bpm, o).score + 0.02 * c.confidence;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}
