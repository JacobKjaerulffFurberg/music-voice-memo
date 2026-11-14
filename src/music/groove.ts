/**
 * Phone page: what plays along, by genre, and the big "vibes" that pick a
 * genre, a colour and a way of reading the take in one tap.
 *
 *  - lofi:  the lazy swung kit (lofi.ts) under floaty electric piano.
 *  - latin: salsa. Clave, congas, cáscara, bell; the piano plays a montuno
 *           and the bass a tumbao, both pushing ahead of the chord changes.
 *
 * Everything here is pure (times in seconds), so it can be tested without audio.
 */

import { chordTones, type Chord, type DrumHit } from './arrange';
import { lofiDrums, lofiTempo } from './lofi';

export type Genre = 'lofi' | 'latin';
export const GENRES: { id: Genre; label: string }[] = [
  { id: 'lofi', label: 'Lo-fi' },
  { id: 'latin', label: 'Latin' },
];

export function genreOf(rec: { genre?: string } | null | undefined): Genre {
  return rec?.genre === 'latin' ? 'latin' : 'lofi';
}

/**
 * A vibe: one vague word that sets the colour of the app, how the take is read
 * (chord spice, how far outside the key) and what plays along (genre, how busy).
 * Picking one just writes these values onto the take; each can still be changed by hand.
 */
export interface Vibe {
  /** How much room is put on the voice (reverb send, 0–1). */
  room: number;
  id: string;
  label: string;
  /** Where the chord colours start on the colour wheel (the tonic's hue). */
  hue: number;
  genre: Genre;
  drumFeel: number;
  keysFeel: number;
  spice: number;
  chroma: number;
  /** How bright the keys are (low-pass, Hz). */
  tone: number;
  /** Turn the drums on with it (a vibe that is nothing without them). */
  drums?: boolean;
  /** Rain comes with it (and goes with the others). */
  rain?: boolean;
  /** Degrees of hue between neighbouring chords: small keeps every chord inside the vibe's own colours. */
  spread: number;
  /** How colourful the chords are drawn (1 = normal). */
  sat: number;
}

export const VIBES: Vibe[] = [
  // Airy and wide: lush chords, a relaxed beat, a clear piano that keeps moving.
  { id: 'cool', label: 'Cool', hue: 200, genre: 'lofi', drumFeel: 1, keysFeel: 2, spice: 3, chroma: 0, tone: 3400, room: 0.14, spread: 9, sat: 1 },
  // The band: salsa percussion wide open, a bright montuno, plain strong chords.
  { id: 'hot', label: 'Hot', hue: 14, genre: 'latin', drumFeel: 1, keysFeel: 1, spice: 1, chroma: 0, tone: 5600, room: 0.05, drums: true, spread: 7, sat: 1.15 },
  // Late night: half-time, one muffled touch per chord, chords that wander out of the key, rain, the voice far off in a big room.
  { id: 'dark', label: 'Dark', hue: 258, genre: 'lofi', drumFeel: 0, keysFeel: 0, spice: 2, chroma: 2, tone: 1250, room: 0.38, rain: true, spread: 6, sat: 0.4 },
];

export function vibeOf(rec: { vibe?: string } | null | undefined): Vibe | null {
  return VIBES.find((v) => v.id === rec?.vibe) ?? null;
}

/**
 * The tempo the groove counts its bar at, on the take's own grid (only ever
 * halved or doubled). Lo-fi sits at 50–100. Latin counts 56–112, the pulse the
 * singer feels, with the percussion filling in 16ths around it.
 */
export function grooveTempo(genre: Genre, bpm: number): number {
  if (genre !== 'latin') return lofiTempo(bpm);
  let t = bpm;
  while (t >= 112) t /= 2;
  while (t < 56) t *= 2;
  return t;
}

export function grooveDrums(genre: Genre, bpm: number, firstBeatSec: number, endSec: number, feel = 1): DrumHit[] {
  return genre === 'latin' ? latinDrums(bpm, firstBeatSec, endSec, feel) : lofiDrums(bpm, firstBeatSec, endSec, feel);
}

/** 3-2 son clave, in 16ths of the groove bar. */
export const CLAVE = [0, 3, 6, 10, 12];
/** Cáscara (the stick on the timbale shell), 3-2. */
const CASCARA = [0, 2, 3, 5, 7, 8, 10, 12, 13, 15];
/** The piano's montuno: beat 1, beat 2, then every off-beat. */
const MONTUNO = [0, 2, 3, 5, 7, 9, 11, 13, 15];

/**
 * Salsa percussion, straight (no swing), one clave cycle per bar. Covers [0, endSec).
 * The beat the singer feels is always stated (kick on 1 and 3, and from the normal
 * feel a bell on every beat), so the syncopation has something to lean against.
 * `feel`: 0 = kick, clave and a quiet conga · 1 = + bell and shaker · 2 = + cáscara, bell pairs, pushes, timbale fills.
 */
export function latinDrums(bpm: number, firstBeatSec: number, endSec: number, feel = 1): DrumHit[] {
  const beat = 60 / bpm;
  const bar = 4 * beat;
  const step = beat / 4;
  const hits: DrumHit[] = [];
  for (let k = Math.floor((0 - firstBeatSec) / bar); firstBeatSec + k * bar < endSec; k++) {
    const b = firstBeatSec + k * bar;
    const add = (kind: DrumHit['kind'], s: number, velocity: number): void => {
      const time = b + s * step;
      if (time >= 0 && time < endSec) hits.push({ time, kind, velocity });
    };
    add('kick', 0, 0.85);
    add('kick', 8, 0.6);
    for (const s of CLAVE) add('clave', s, feel <= 0 ? 0.6 : 0.75);
    // Conga tumbao, twice a bar: slap on 2, two open tones on 4 and 4-and.
    for (const h of [0, 8]) {
      add('slap', h + 2, feel <= 0 ? 0.4 : 0.65);
      add('conga', h + 6, feel <= 0 ? 0.5 : 0.8);
      add('conga', h + 7, feel <= 0 ? 0.4 : 0.65);
      if (feel >= 2) for (const s of [0, 1, 3, 4, 5]) add('conga', h + s, 0.14); // the quiet heel-toe in between
    }
    if (feel >= 1) {
      for (let s = 0; s < 16; s += 4) add('cowbell', s, s % 8 === 0 ? 0.8 : 0.55);
      for (let s = 0; s < 16; s += 2) add('shaker', s, s % 4 === 0 ? 0.6 : 0.35);
    }
    if (feel >= 2) {
      // The band opens up: the stick on the shell, bell pairs between the beats, a soft kick pushing into 1 and 3.
      for (const s of CASCARA) add('shell', s, s % 4 === 0 ? 0.5 : 0.32);
      for (const h of [0, 8]) {
        for (const s of [2, 3, 6, 7]) add('cowbell', h + s, 0.35);
        add('kick', h + 6, 0.5);
      }
      if (((k % 4) + 4) % 4 === 3) for (const [s, v] of [[12, 0.5], [13, 0.6], [14, 0.75], [15, 0.9]]) add('timbale', s, v);
    }
  }
  return hits.sort((x, y) => x.time - y.time);
}

export interface CompNote {
  midi: number;
  start: number;
  duration: number;
  /** 0–1. */
  velocity: number;
  /** Left hand / bass: held, not stabbed. */
  bass?: boolean;
}

/**
 * Latin piano and bass over a chord progression, on the groove's 16th grid.
 * Piano: the montuno, octaves answering the inside of the chord. Bass: root on
 * the beat, fifth on 2-and, root again on 4, so the harmony always lands with the singer.
 * Only the busy feel plays it the salsa way, with piano and bass reaching the
 * next chord before it arrives.
 * `feel`: 0 = half the hits, bass on 1 and 3 · 1 = the montuno · 2 = anticipations, an octave on top, pickups.
 */
export function montuno(chords: Chord[], bpm: number, firstBeatSec: number, endSec: number, feel = 1): CompNote[] {
  if (!chords.length) return [];
  const beat = 60 / bpm;
  const bar = 4 * beat;
  const step = beat / 4;
  const from = chords[0].start;
  const to = Math.min(endSec, chords[chords.length - 1].start + chords[chords.length - 1].duration);
  const chordAt = (t: number): Chord | null => chords.find((c) => t >= c.start - 1e-6 && t < c.start + c.duration - 1e-6) ?? null;
  /** The chord a hit plays: the one that is about to arrive, if it changes on the next step. */
  const ahead = (t: number, steps: number): Chord | null => (feel >= 2 ? chordAt(t + steps * step) : null) ?? chordAt(t);
  const out: CompNote[] = [];
  const put = (midi: number, start: number, duration: number, velocity: number, bass = false): void => {
    if (start >= from - step - 1e-6 && start >= 0 && start < to) out.push({ midi, start, duration, velocity, ...(bass ? { bass } : {}) });
  };
  const pattern = feel <= 0 ? [0, 3, 7, 11, 15] : MONTUNO;
  let opened = false;
  for (let k = Math.floor((from - firstBeatSec) / bar); firstBeatSec + k * bar < to; k++) {
    const b = firstBeatSec + k * bar;
    pattern.forEach((s, i) => {
      const t = b + s * step;
      const c = ahead(t, s % 2 ? 1 : 0);
      if (!c) return;
      // The hand sits around middle C: the chord's lowest tone and its octave on the outside, the rest in between.
      const pcs = [...new Set(c.voicing.map((m) => ((m % 12) + 12) % 12))];
      const lo = 60 + pcs[0];
      const inside = pcs.slice(1).map((pc) => lo + ((pc - pcs[0] + 12) % 12));
      const outer = i % 2 === 0 || inside.length === 0;
      const dur = step * 0.85;
      if (outer) {
        const v = s === 0 ? 0.95 : 0.78;
        put(lo, t, dur, v * 0.85);
        put(lo + 12, t, dur, v);
        if (feel >= 2) put(lo + 24, t, dur, v * 0.6);
      } else {
        inside.slice(0, 3).forEach((m) => put(m, t, dur, 0.62));
      }
    });
    if (feel >= 2) {
      // A pickup run into the next bar.
      const t = b + 14 * step;
      const c = chordAt(t);
      if (c) put(72 + (((c.voicing[c.voicing.length - 1] % 12) + 12) % 12), t, step * 0.85, 0.5);
    }
    for (const h of [0, 8]) {
      const t0 = b + h * step;
      const c0 = chordAt(t0);
      // On the beat (the busy feel leaves it out after the first bar: its root already arrived early).
      if (c0 && (feel < 2 || !opened)) put(c0.bass, t0, (feel <= 0 ? 7 : 3) * step, 0.95, true);
      if (c0) opened = true;
      if (feel <= 0) continue;
      const t5 = b + (h + 3) * step;
      const c5 = chordAt(t5);
      if (c5) {
        const has5 = chordTones(c5.root, c5.quality).includes((c5.root + 7) % 12);
        const fifth = !has5 ? c5.bass : c5.bass + 7 > 55 ? c5.bass - 5 : c5.bass + 7;
        put(fifth, t5, 3 * step, 0.8, true);
      }
      const t1 = b + (h + 6) * step;
      const c1 = ahead(t1, 2);
      if (c1) put(c1.bass, t1, (feel >= 2 ? 5 : 2) * step, 0.9, true);
    }
  }
  return out.sort((x, y) => x.start - y.start);
}
