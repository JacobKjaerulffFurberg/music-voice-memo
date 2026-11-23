/**
 * Krumhansl–Schmuckler key finding on a duration-weighted pitch-class histogram.
 */

import { hzToMidi, keyName } from './music';
import type { KeyCandidate, KeyResult, Mode, Note, PitchTrack } from './types';

// Krumhansl & Kessler (1982) probe-tone profiles, index 0 = tonic.
export const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(x: ArrayLike<number>, y: ArrayLike<number>, rot: number): number {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < 12; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= 12;
  my /= 12;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < 12; i++) {
    const a = x[(i + rot) % 12] - mx;
    const b = y[i] - my;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

export function pitchClassHistogram(notes: Note[]): Float64Array {
  const h = new Float64Array(12);
  for (const n of notes) h[((n.midi % 12) + 12) % 12] += n.duration;
  return h;
}

/** Score all 24 keys against a pitch-class histogram. */
export function keyFromHistogram(hist: ArrayLike<number>, source: KeyResult['source'], bonus?: (tonic: number, mode: Mode) => number): KeyResult | null {
  let total = 0;
  for (let i = 0; i < 12; i++) total += hist[i];
  if (!(total > 0)) return null;

  const all: KeyCandidate[] = [];
  for (const mode of ['major', 'minor'] as Mode[]) {
    const profile = mode === 'major' ? KK_MAJOR : KK_MINOR;
    for (let tonic = 0; tonic < 12; tonic++) {
      all.push({ tonic, mode, name: keyName(tonic, mode), score: pearson(hist, profile, tonic) + (bonus?.(tonic, mode) ?? 0) });
    }
  }
  all.sort((p, q) => q.score - p.score);
  const best = all[0];
  // Softmax over correlations → probability-like confidence of the winner.
  const T = 0.08;
  let z = 0;
  for (const c of all) z += Math.exp((c.score - best.score) / T);
  const confidence = 1 / z;
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: best.name,
    confidence,
    candidates: all.slice(0, 3),
    source,
  };
}

/**
 * Near-ties between keys that share most notes (F major / A minor / C major) are settled the way a
 * listener would: a sung melody usually comes home to its tonic at the end, and a hummed idea is
 * more often major. Both nudges are small next to a clear histogram.
 */
export function estimateKeyFromNotes(notes: Note[]): KeyResult | null {
  if (notes.length < 3) return null;
  const pc = (m: number): number => ((Math.round(m) % 12) + 12) % 12;
  const last = [...notes].sort((a, b) => a.start + a.duration - (b.start + b.duration)).at(-1);
  const home = last ? pc(last.midi) : -1;
  return keyFromHistogram(pitchClassHistogram(notes), 'notes-ks', (tonic, mode) => (tonic === home ? 0.05 : 0) + (mode === 'major' ? 0.03 : 0));
}

/** Fallback "audio" key when essentia is unavailable: KS on voiced f0 frames (tuning-corrected). */
export function estimateKeyFromFrames(track: PitchTrack, tuningCents: number): KeyResult | null {
  const h = new Float64Array(12);
  for (let i = 0; i < track.f0Hz.length; i++) {
    const f = track.f0Hz[i];
    if (f <= 0) continue;
    const m = Math.round(hzToMidi(f) - tuningCents / 100);
    h[((m % 12) + 12) % 12] += track.confidence[i];
  }
  return keyFromHistogram(h, 'frames-ks');
}
