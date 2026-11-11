/**
 * Note velocities (MIDI 1–127) from detected loudness, relative to the take:
 * the loud notes of the take land near 127, faint notes (often ghost notes
 * from overtones or noise) land low, so playback and MIDI reflect how present
 * each note really was.
 */

import type { Note } from './types';

/** Velocity used for notes added by hand. */
export const DEFAULT_VELOCITY = 100;

export function velocityOf(n: Note): number {
  return n.velocity ?? DEFAULT_VELOCITY;
}

export function assignVelocities(notes: Note[]): Note[] {
  if (notes.length === 0) return notes;
  const levels = notes.map((n) => n.level).filter((l) => l > 0).sort((a, b) => a - b);
  // Reference = 90th percentile, so one freak loud note doesn't squash everyone else.
  const ref = levels.length ? levels[Math.floor(0.9 * (levels.length - 1))] : 0;
  return notes.map((n) => {
    if (!(ref > 0) || !(n.level > 0)) return { ...n, velocity: n.velocity ?? DEFAULT_VELOCITY };
    const ratio = Math.min(1, n.level / ref);
    return { ...n, velocity: Math.max(1, Math.min(127, Math.round(127 * Math.pow(ratio, 0.8)))) };
  });
}
