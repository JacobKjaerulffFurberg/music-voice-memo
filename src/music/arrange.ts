/**
 * Auto-accompaniment: drum patterns on the beat grid and diatonic chords
 * chosen to fit the sung melody. Pure functions → testable, and shared by
 * playback and MIDI export.
 */

import type { Mode, Note } from '../analysis/types';

// ---------------------------------------------------------------- grid

export interface GridSpec {
  bpm: number;
  /** Time of bar 1 beat 1, seconds. */
  firstBeatSec: number;
  beatsPerBar: number;
  durationSec: number;
}

/** Bars from the first downbeat until the end of the recording (last bar may be partial). */
export function barStarts(g: GridSpec): number[] {
  const bar = (60 / g.bpm) * g.beatsPerBar;
  const out: number[] = [];
  for (let t = g.firstBeatSec; t < g.durationSec - 0.05; t += bar) out.push(t);
  return out;
}

// ---------------------------------------------------------------- drums

export type DrumKind = 'kick' | 'snare' | 'hat' | 'openhat';
export type DrumPatternId = 'off' | 'rock' | 'halftime' | 'four' | 'ballad';

export interface DrumHit {
  time: number;
  kind: DrumKind;
  velocity: number;
}

/** 16 steps per 4/4 bar. Each row: step indices. */
interface Pattern {
  label: string;
  kick: number[];
  snare: number[];
  hat: number[];
  openhat: number[];
}

export const DRUM_PATTERNS: Record<Exclude<DrumPatternId, 'off'>, Pattern> = {
  rock: { label: 'Rock', kick: [0, 8, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], openhat: [] },
  halftime: { label: 'Half-time', kick: [0, 3, 10], snare: [8], hat: [0, 2, 4, 6, 8, 10, 12, 14], openhat: [] },
  four: { label: 'Four on the floor', kick: [0, 4, 8, 12], snare: [4, 12], hat: [], openhat: [2, 6, 10, 14] },
  ballad: { label: 'Ballad', kick: [0, 10], snare: [8], hat: [0, 4, 8, 12], openhat: [] },
};

export function drumHits(pattern: DrumPatternId, g: GridSpec): DrumHit[] {
  if (pattern === 'off') return [];
  const p = DRUM_PATTERNS[pattern];
  const step = 60 / g.bpm / 4;
  const stepsPerBar = g.beatsPerBar * 4;
  const hits: DrumHit[] = [];
  for (const bar of barStarts(g)) {
    const add = (kind: DrumKind, steps: number[], vel: (s: number) => number): void => {
      for (const s of steps) {
        if (s >= stepsPerBar) continue;
        const time = bar + s * step;
        if (time < g.durationSec) hits.push({ time, kind, velocity: vel(s) });
      }
    };
    add('kick', p.kick, (s) => (s === 0 ? 1 : 0.85));
    add('snare', p.snare, () => 0.9);
    add('hat', p.hat, (s) => (s % 4 === 0 ? 0.7 : 0.45));
    add('openhat', p.openhat, () => 0.55);
  }
  return hits.sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------- chords

export type Quality = 'maj' | 'min' | 'dom7' | 'min7' | 'maj7';

export interface Chord {
  start: number;
  duration: number;
  root: number; // pitch class
  quality: Quality;
  name: string;
  /** Roman numeral relative to the key. */
  numeral: string;
  /** Voiced chord tones (MIDI), close position around middle C. */
  voicing: number[];
  bass: number;
}

interface Degree {
  offset: number;
  quality: Quality;
  numeral: string;
  prior: number;
}

const MAJOR_DEGREES: Degree[] = [
  { offset: 0, quality: 'maj', numeral: 'I', prior: 1 },
  { offset: 5, quality: 'maj', numeral: 'IV', prior: 0.7 },
  { offset: 7, quality: 'maj', numeral: 'V', prior: 0.7 },
  { offset: 7, quality: 'dom7', numeral: 'V7', prior: 0.5 },
  { offset: 9, quality: 'min', numeral: 'vi', prior: 0.5 },
  { offset: 2, quality: 'min', numeral: 'ii', prior: 0.35 },
  { offset: 4, quality: 'min', numeral: 'iii', prior: 0.15 },
];

/** Minor uses the harmonic-minor dominant (major V / V7), as singers do. */
const MINOR_DEGREES: Degree[] = [
  { offset: 0, quality: 'min', numeral: 'i', prior: 1 },
  { offset: 5, quality: 'min', numeral: 'iv', prior: 0.6 },
  { offset: 7, quality: 'maj', numeral: 'V', prior: 0.6 },
  { offset: 7, quality: 'dom7', numeral: 'V7', prior: 0.5 },
  { offset: 8, quality: 'maj', numeral: 'VI', prior: 0.55 },
  { offset: 3, quality: 'maj', numeral: 'III', prior: 0.4 },
  { offset: 10, quality: 'maj', numeral: 'VII', prior: 0.4 },
];

const ROOT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const INTERVALS: Record<Quality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
};
const SUFFIX: Record<Quality, string> = { maj: '', min: 'm', dom7: '7', min7: 'm7', maj7: 'maj7' };

export function chordTones(root: number, quality: Quality): number[] {
  const r = ((root % 12) + 12) % 12;
  return INTERVALS[quality].map((i) => (r + i) % 12);
}

export function chordName(root: number, quality: Quality): string {
  return `${ROOT_NAMES[((root % 12) + 12) % 12]}${SUFFIX[quality]}`;
}

/** Turn recognised (played) chords into voiced backing chords. */
export function voicePlayedChords(played: { start: number; duration: number; root: number; quality: Quality; name: string }[]): Chord[] {
  const out: Chord[] = [];
  let prev: number[] | null = null;
  for (const c of played) {
    const voicing = voiceChord(c.root, c.quality, prev);
    out.push({ start: c.start, duration: c.duration, root: c.root, quality: c.quality, name: c.name, numeral: '', voicing, bass: 36 + c.root });
    prev = voicing;
  }
  return out;
}

/** Close-position voicing in [52, 70] nearest to the previous voicing (smooth voice leading). */
export function voiceChord(root: number, quality: Quality, prev: number[] | null): number[] {
  const tones = chordTones(root, quality);
  const n = tones.length;
  const candidates: number[][] = [];
  for (let inv = 0; inv < n; inv++) {
    const order = tones.map((_, k) => tones[(inv + k) % n]);
    for (let base = 48; base <= 60; base += 12) {
      const v: number[] = [];
      let last = -Infinity;
      for (const pc of order) {
        let m = base + pc;
        while (m <= last) m += 12;
        v.push(m);
        last = m;
      }
      if (v[0] >= 52 && v[n - 1] <= 70) candidates.push(v);
    }
  }
  const target = prev ?? [55, 60, 64];
  const centre = (v: number[]): number => v.reduce((s, m) => s + m, 0) / v.length;
  let best = candidates[0] ?? tones.map((pc) => 60 + pc);
  let bestCost = Infinity;
  for (const v of candidates) {
    // Each voice moves to the nearest tone of the new chord; also keep the register.
    let cost = 0;
    for (const m of target) cost += Math.min(...v.map((x) => Math.abs(x - m)));
    cost += 0.5 * Math.abs(centre(v) - centre(target));
    if (cost < bestCost) {
      bestCost = cost;
      best = v;
    }
  }
  return best;
}

export interface ChordOptions {
  /** 'auto' splits a bar into two chords when the melody clearly changes harmony mid-bar. */
  chordsPerBar: 1 | 2 | 'auto';
}

interface ScoreContext {
  key: { tonic: number; mode: Mode };
  degrees: Degree[];
  scale: Set<number>;
  prev: { root: number; quality: Quality } | null;
  edge: boolean;
}

/** Melody weight per pitch class in [start, end), strong-beat starts weighted up. */
function melodyWeights(notes: Note[], start: number, end: number): { w: Float64Array; total: number } {
  const w = new Float64Array(12);
  let total = 0;
  const len = end - start;
  for (const n of notes) {
    const overlap = Math.min(end, n.start + n.duration) - Math.max(start, n.start);
    if (overlap <= 0) continue;
    const onStrong = Math.abs(n.start - start) < 0.12 * len ? 1.6 : 1;
    const x = overlap * onStrong;
    w[((n.midi % 12) + 12) % 12] += x;
    total += x;
  }
  return { w, total };
}

/** Score one chord against the melody weights (higher = better fit). */
function scoreChord(d: Degree, w: Float64Array, total: number, ctx: ScoreContext): number {
  const { key } = ctx;
  const root = (key.tonic + d.offset) % 12;
  const toneList = chordTones(root, d.quality);
  const tones = new Set(toneList);
  let s = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (w[pc] === 0) continue;
    let v: number;
    if (tones.has(pc)) v = 1;
    else {
      const rel = (pc - root + 12) % 12;
      // Avoid notes: a semitone above a chord tone (b9-type rub), a major 7th
      // against a minor/dominant root (C# over Dm), or a tritone from the root.
      // Passing tones a semitone *below* the 3rd/5th (e.g. E over Dm) are fine.
      const clash = tones.has((pc + 11) % 12) || (rel === 11 && d.quality !== 'maj') || rel === 6;
      v = clash ? -1 : ctx.scale.has(pc) ? -0.3 : -0.8;
    }
    s += (w[pc] / total) * v;
  }
  // The leading tone is the strongest pointer to the dominant — in minor it
  // only exists in V / V7 (harmonic minor), so it practically decides the chord.
  const lt = w[(key.tonic + 11) % 12] / total;
  if (lt > 0) {
    const hasLt = tones.has((key.tonic + 11) % 12);
    if (key.mode === 'minor') s += hasLt ? 1.4 * lt : -0.8 * lt;
    else if (d.offset === 7) s += 0.4 * lt;
  }
  // The dominant 7th wins over a plain V only when the melody sings the 7th.
  if (d.quality === 'dom7') s -= 0.08;
  s += 0.25 * d.prior;
  if (ctx.edge && d.offset === 0) s += 0.2;
  if (ctx.prev && ctx.prev.root === root && ctx.prev.quality === d.quality) s += 0.06;
  return s;
}

function bestChord(w: Float64Array, total: number, ctx: ScoreContext): { degree: Degree; score: number } {
  let degree = ctx.degrees[0];
  let score = -Infinity;
  for (const d of ctx.degrees) {
    const s = scoreChord(d, w, total, ctx);
    if (s > score) {
      score = s;
      degree = d;
    }
  }
  return { degree, score };
}

/**
 * Pick diatonic chords (plus the dominant 7th, and the harmonic-minor V in
 * minor) that best cover the sung melody, per bar or half bar. Weighted by
 * overlap and metric position; clashing notes (semitone rubs, tritones) are
 * penalised; the leading tone pulls strongly toward V; functional prior,
 * tonic bias at the start/end, and a small bonus for holding a chord.
 */
export function suggestChords(
  notes: Note[],
  key: { tonic: number; mode: Mode },
  g: GridSpec,
  options: Partial<ChordOptions> = {},
): Chord[] {
  const mode = options.chordsPerBar ?? 'auto';
  const degrees = key.mode === 'major' ? MAJOR_DEGREES : MINOR_DEGREES;
  const scale = new Set(
    (key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11]).map((s) => (key.tonic + s) % 12),
  );
  const bar = (60 / g.bpm) * g.beatsPerBar;
  const bars = barStarts(g);

  const chords: Chord[] = [];
  let prev: Chord | null = null;
  const holdPrev = (): Degree =>
    prev ? (degrees.find((d) => (key.tonic + d.offset) % 12 === prev?.root && d.quality === prev.quality) ?? degrees[0]) : degrees[0];

  const emit = (start: number, end: number, d: Degree): void => {
    const root = (key.tonic + d.offset) % 12;
    const chord: Chord = {
      start,
      duration: end - start,
      root,
      quality: d.quality,
      name: chordName(root, d.quality),
      numeral: d.numeral,
      voicing: voiceChord(root, d.quality, prev?.voicing ?? null),
      bass: 36 + root,
    };
    chords.push(chord);
    prev = chord;
  };

  bars.forEach((b, bi) => {
    const end = Math.min(b + bar, g.durationSec);
    const edge = bi === 0 || bi === bars.length - 1;
    const ctx = (): ScoreContext => ({ key, degrees, scale, prev: prev ? { root: prev.root, quality: prev.quality } : null, edge });
    const whole = melodyWeights(notes, b, end);
    const mid = Math.min(b + bar / 2, end);
    const halves = end - mid > 0.05 ? [melodyWeights(notes, b, mid), melodyWeights(notes, mid, end)] : null;

    if (mode === 2 && halves) {
      for (const [k, h] of halves.entries()) {
        const [s0, s1] = k === 0 ? [b, mid] : [mid, end];
        emit(s0, s1, h.total > 0 ? bestChord(h.w, h.total, ctx()).degree : holdPrev());
      }
      return;
    }
    if (whole.total <= 0) {
      emit(b, end, holdPrev());
      return;
    }
    const one = bestChord(whole.w, whole.total, ctx());
    if (mode === 'auto' && halves && halves[0].total > 0 && halves[1].total > 0) {
      const first = bestChord(halves[0].w, halves[0].total, ctx());
      const savedPrev = prev;
      // Score the second half as if the first-half chord had been played.
      prev = { ...(prev ?? ({} as Chord)), root: (key.tonic + first.degree.offset) % 12, quality: first.degree.quality } as Chord;
      const second = bestChord(halves[1].w, halves[1].total, ctx());
      prev = savedPrev;
      const tw = halves[0].total + halves[1].total;
      const split = (first.score * halves[0].total + second.score * halves[1].total) / tw;
      const differs = first.degree !== second.degree;
      if (differs && split - one.score > 0.12) {
        emit(b, mid, first.degree);
        emit(mid, end, second.degree);
        return;
      }
    }
    emit(b, end, one.degree);
  });
  return chords;
}
