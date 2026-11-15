/**
 * Tune: nudge the sung voice onto its notes.
 *
 * Every note is moved as a whole, by the distance between where it was sung
 * (its median pitch) and the note it stands for. Vibrato, slides and the way
 * the singer bends into a note stay exactly as sung: only the centre moves.
 *
 * Pure function: the tuned audio is derived on demand and never stored, so
 * switching it off gives the untouched take back.
 */

import { stretch } from './lofi';

/** Further than this (in semitones) is not a tuning slip: the note is left as sung. */
const MAX_SHIFT = 1.3;
/** Less than this (in cents) is not worth touching. */
const MIN_SHIFT = 4;

export interface TuneNote {
  start: number;
  duration: number;
  /** The note it should be (MIDI, before the take's tuning offset). */
  midi: number;
  /** The median pitch it was sung at. */
  hz: number;
}

/** How far each note is moved, as a frequency ratio (1 = left alone). */
export function tuneRatio(n: TuneNote, tuningCents = 0, strength = 1): number {
  if (!(n.hz > 0)) return 1;
  const want = 440 * Math.pow(2, (n.midi - 69 + tuningCents / 100) / 12);
  const semis = 12 * Math.log2(want / n.hz);
  if (Math.abs(semis) > MAX_SHIFT || Math.abs(semis) * 100 < MIN_SHIFT) return 1;
  return Math.pow(2, (semis * Math.max(0, Math.min(1, strength))) / 12);
}

/** Change the pitch of a stretch of audio by `ratio`, keeping its length. */
export function shiftPitch(x: Float32Array, ratio: number, sampleRate: number): Float32Array {
  // Make it longer (or shorter) at the same pitch, then read it back faster (or slower).
  const long = stretch(x, ratio, sampleRate);
  const out = new Float32Array(x.length);
  const last = long.length - 1;
  for (let i = 0; i < out.length; i++) {
    const p = Math.min(last, i * ratio);
    const k = Math.floor(p);
    const f = p - k;
    out[i] = long[k] * (1 - f) + long[Math.min(last, k + 1)] * f;
  }
  return out;
}

/**
 * The take with every note moved onto its pitch. Same length, same timing.
 * `tuningCents` is the take's own offset from A440 (the band plays at it too).
 */
export function tuneVoice(samples: Float32Array, sampleRate: number, notes: TuneNote[], tuningCents = 0, strength = 1): Float32Array {
  const out = new Float32Array(samples);
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const fade = Math.round(sampleRate * 0.012);
  sorted.forEach((n, i) => {
    const ratio = tuneRatio(n, tuningCents, strength);
    if (ratio === 1) return;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const end = n.start + n.duration;
    // The note's own audio: a breath before and its tail after, up to halfway to its neighbours.
    const a = Math.max(0, n.start - 0.03, prev ? (prev.start + prev.duration + n.start) / 2 : 0);
    const b = Math.min(samples.length / sampleRate, end + 0.08, next ? Math.max(end, (end + next.start) / 2) : Infinity);
    const i0 = Math.max(0, Math.round(a * sampleRate) - fade);
    const i1 = Math.min(samples.length, Math.round(b * sampleRate) + fade);
    if (i1 - i0 < fade * 4) return;
    const moved = shiftPitch(samples.subarray(i0, i1), ratio, sampleRate);
    const len = i1 - i0;
    for (let k = 0; k < len; k++) {
      // Blend in and out over a few milliseconds so the joins don't click.
      const w = Math.min(1, k / fade, (len - 1 - k) / fade);
      out[i0 + k] = out[i0 + k] * (1 - w) + moved[k] * w;
    }
  });
  return out;
}
