/**
 * Global tuning offset: median cents deviation of stable voiced frames from
 * the nearest equal-tempered semitone (A440 reference).
 *
 * Deviations live on a circle (+49 c and -49 c are 2 c apart), so we first
 * find the circular mean, then take the median of deviations re-centred on it.
 */

import { hzToMidi, median } from './music';
import type { Note, PitchTrack, TuningResult } from './types';

export interface TuningOptions {
  minConfidence: number;
  /** Frames whose pitch moves more than this (cents) from the previous frame are skipped (glides, vibrato edges). */
  maxSlopeCents: number;
}

const DEFAULTS: TuningOptions = { minConfidence: 0.5, maxSlopeCents: 15 };

function wrapCents(c: number): number {
  return ((((c + 50) % 100) + 100) % 100) - 50;
}

export function estimateTuning(track: PitchTrack, options: Partial<TuningOptions> = {}): TuningResult {
  const o = { ...DEFAULTS, ...options };
  const devs: number[] = [];
  const { f0Hz, confidence } = track;
  for (let i = 1; i < f0Hz.length; i++) {
    const f = f0Hz[i];
    const p = f0Hz[i - 1];
    if (f <= 0 || p <= 0 || confidence[i] < o.minConfidence) continue;
    if (Math.abs(1200 * Math.log2(f / p)) > o.maxSlopeCents) continue;
    const m = hzToMidi(f);
    devs.push((m - Math.round(m)) * 100);
  }
  return tuningFromDeviations(devs);
}

/**
 * Tuning from segmented notes (each note's stable-core pitch, weighted by
 * duration). Robust to scoops, slides and vibrato, which bias frame statistics.
 * Notes must have been segmented with a 0-cent offset.
 */
export function tuningFromNotes(notes: Note[]): TuningResult {
  const devs: number[] = [];
  for (const n of notes) {
    const reps = Math.max(1, Math.round(n.duration / 0.05));
    for (let k = 0; k < reps; k++) devs.push(n.cents);
  }
  const r = tuningFromDeviations(devs);
  return { ...r, frameCount: notes.length, source: 'notes' };
}

/** Exposed for testing: tuning from a list of per-frame cent deviations. */
export function tuningFromDeviations(devs: number[]): TuningResult {
  if (devs.length === 0) return { cents: 0, a4Hz: 440, frameCount: 0, spreadCents: NaN, source: 'frames' };
  let sx = 0;
  let sy = 0;
  for (const d of devs) {
    const th = (d / 100) * 2 * Math.PI;
    sx += Math.cos(th);
    sy += Math.sin(th);
  }
  const centre = (Math.atan2(sy, sx) / (2 * Math.PI)) * 100;
  const recentred = devs.map((d) => wrapCents(d - centre));
  const cents = wrapCents(median(recentred) + centre);
  const spread = median(recentred.map((d) => Math.abs(d - (cents - centre))));
  return {
    cents,
    a4Hz: 440 * Math.pow(2, cents / 1200),
    frameCount: devs.length,
    spreadCents: spread,
    source: 'frames',
  };
}
