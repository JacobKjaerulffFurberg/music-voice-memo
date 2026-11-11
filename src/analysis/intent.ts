/**
 * "What did the singer mean?" — a musical interpretation pass applied on top
 * of the raw note detection, once key and tempo are known:
 *
 *  - fit to key: an out-of-key note that was sung leaning toward an in-key
 *    neighbour (by ≥ ~20 c) is moved there. A chromatic note sung confidently
 *    in tune stays.
 *  - quantize: move note starts/ends toward the grid by a strength (0–1),
 *    like Ableton's quantize amount; colliding notes are pushed to the next slot.
 *  - legato: close small gaps so each note lasts until the next one.
 */

import type { Mode, Note } from './types';
import { velocityOf } from './velocity';

export interface IntentOptions {
  fitToKey: boolean;
  /** Grid subdivisions per beat for quantize (2 = 1/8, 4 = 1/16, 3 = 1/8T); 0 = off. */
  quantizeGrid: number;
  /** 0..1 */
  quantizeStrength: number;
  legato: boolean;
  /** Drop detected notes quieter than this velocity (0 = keep all). Clears ghost notes. */
  minVelocity: number;
}

export const DEFAULT_INTENT: IntentOptions = {
  fitToKey: true,
  quantizeGrid: 4,
  quantizeStrength: 0.6,
  legato: false,
  minVelocity: 0,
};

export interface IntentContext {
  key: { tonic: number; mode: Mode } | null;
  bpm: number;
  firstBeatSec: number;
  /** Chords/played parts: notes overlap by design, so legato is skipped. */
  polyphonic?: boolean;
}

function keyScale(tonic: number, mode: Mode): Set<number> {
  // Minor also accepts the raised 7th (harmonic minor leading tone).
  const steps = mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11];
  return new Set(steps.map((s) => (tonic + s) % 12));
}

const pcOf = (m: number): number => ((m % 12) + 12) % 12;

/** Move out-of-key notes that lean toward an in-key neighbour. */
export function fitToKey(notes: Note[], key: { tonic: number; mode: Mode }, maxDistance = 0.8): Note[] {
  const scale = keyScale(key.tonic, key.mode);
  return notes.map((n) => {
    if (scale.has(pcOf(n.midi))) return n;
    const sung = n.midi + n.cents / 100;
    let best: number | null = null;
    for (const c of [n.midi - 1, n.midi + 1]) {
      if (!scale.has(pcOf(c))) continue;
      if (best === null || Math.abs(sung - c) < Math.abs(sung - best)) best = c;
    }
    if (best === null || Math.abs(sung - best) > maxDistance) return n;
    return { ...n, midi: best, cents: (sung - best) * 100 };
  });
}

export function quantizeNotes(notes: Note[], ctx: IntentContext, grid: number, strength: number): Note[] {
  if (grid <= 0 || strength <= 0) return notes.map((n) => ({ ...n }));
  const unit = 60 / ctx.bpm / grid;
  const first = ctx.firstBeatSec;
  const snap = (t: number): number => first + Math.round((t - first) / unit) * unit;
  const out: Note[] = [];
  // Melody: one note at a time, so notes landing in the same slot are pushed apart.
  // Chords: collisions only matter per pitch (several pitches at once is the point).
  const lastByPitch = new Map<number, Note>();
  const slot = (n: Note): number => (ctx.polyphonic ? n.midi : -1);
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    const end = n.start + n.duration;
    let s = n.start + strength * (snap(n.start) - n.start);
    let e = end + strength * (snap(end) - end);
    const prev = lastByPitch.get(slot(n));
    if (prev && s <= prev.start + 1e-3) s = prev.start + unit * Math.max(strength, 0.5);
    // Keep at least half a grid unit (or the original length if shorter).
    e = Math.max(e, s + Math.min(n.duration, unit / 2));
    if (prev && prev.start + prev.duration > s) prev.duration = Math.max(0.03, s - prev.start);
    const q = { ...n, start: s, duration: e - s };
    out.push(q);
    lastByPitch.set(slot(n), q);
  }
  return out.sort((a, b) => a.start - b.start || a.midi - b.midi);
}

export function legato(notes: Note[], maxGapSec: number): Note[] {
  const out = notes.map((n) => ({ ...n }));
  for (let i = 0; i + 1 < out.length; i++) {
    const gap = out[i + 1].start - (out[i].start + out[i].duration);
    if (gap > 0 && gap <= maxGapSec) out[i].duration = out[i + 1].start - out[i].start;
  }
  return out;
}

export function applyIntent(notes: Note[], ctx: IntentContext, o: IntentOptions = DEFAULT_INTENT): Note[] {
  let out = o.minVelocity > 0 ? notes.filter((n) => velocityOf(n) >= o.minVelocity) : notes;
  if (o.fitToKey && ctx.key) out = fitToKey(out, ctx.key);
  out = quantizeNotes(out, ctx, o.quantizeGrid, o.quantizeStrength);
  if (o.legato && !ctx.polyphonic) out = legato(out, 60 / ctx.bpm);
  return out;
}
