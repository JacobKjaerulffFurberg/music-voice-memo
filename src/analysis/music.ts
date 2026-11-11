/** Small music-theory helpers shared by analysis, UI and export. */

import type { Mode } from './types';

export const A4_HZ = 440;

export function hzToMidi(hz: number, a4 = A4_HZ): number {
  return 69 + 12 * Math.log2(hz / a4);
}

export function midiToHz(midi: number, a4 = A4_HZ): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${SHARP_NAMES[pitchClass(m)]}${Math.floor(m / 12) - 1}`;
}

export function keyName(tonic: number, mode: Mode): string {
  const pc = ((tonic % 12) + 12) % 12;
  const names = mode === 'major' ? MAJOR_KEY_NAMES : MINOR_KEY_NAMES;
  return `${names[pc]} ${mode}`;
}

/** Parse "C#", "Db", "Bb" … into a pitch class, or -1. */
export function parsePitchClass(name: string): number {
  const m = /^([A-Ga-g])([#b]?)$/.exec(name.trim());
  if (!m) return -1;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const letter = (m[1] ?? 'C').toUpperCase();
  let pc = base[letter] ?? 0;
  if (m[2] === '#') pc += 1;
  if (m[2] === 'b') pc -= 1;
  return ((pc % 12) + 12) % 12;
}

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

export function scalePitchClasses(tonic: number, mode: Mode): Set<number> {
  const steps = mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  return new Set(steps.map((s) => (tonic + s) % 12));
}

/** Fold a tempo into [lo, hi) by octaves. */
export function foldBpm(bpm: number, lo = 70, hi = 160): number {
  if (!(bpm > 0) || !Number.isFinite(bpm)) return bpm;
  let b = bpm;
  while (b < lo) b *= 2;
  while (b >= hi) b /= 2;
  return b;
}

export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = Float64Array.from(values).sort();
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
