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

export type DrumKind =
  | 'kick'
  | 'snare'
  | 'hat'
  | 'openhat'
  // Latin percussion (phone page).
  | 'clave'
  | 'conga'
  | 'slap'
  | 'shell'
  | 'shaker'
  | 'cowbell'
  | 'timbale';
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

export type Quality =
  | 'maj'
  | 'min'
  | 'dom7'
  | 'min7'
  | 'maj7'
  // Spicier colours (used by "spice up" and the chord picker).
  | 'sus2'
  | 'sus4'
  | 'add9'
  | 'madd9'
  | 'six'
  | 'six9'
  | 'maj9'
  | 'min9'
  | 'dom9'
  | 'min11'
  | 'dom9sus4'
  // Raised 5th (D F# A#): chosen when the melody sings that raised 5th.
  | 'aug';

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
  /** Slot id (beats from bar 1) used to store the user's edit of this chord. */
  slot?: string;
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
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Keys written with sharps (G, D, A, E, B, F# major and their relative minors). */
export function prefersSharps(key: { tonic: number; mode: Mode } | null): boolean {
  if (!key) return false;
  const major = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12;
  return [7, 2, 9, 4, 11, 6].includes(major);
}

const INTERVALS: Record<Quality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  six: [0, 4, 7, 9],
  six9: [0, 4, 9, 14],
  // Big chords drop the 5th so the voicing stays soft and close.
  maj9: [0, 4, 11, 14],
  min9: [0, 3, 10, 14],
  dom9: [0, 4, 10, 14],
  min11: [0, 3, 10, 14, 17],
  dom9sus4: [0, 5, 10, 14],
  aug: [0, 4, 8],
};
const SUFFIX: Record<Quality, string> = {
  maj: '',
  min: 'm',
  dom7: '7',
  min7: 'm7',
  maj7: 'maj7',
  sus2: 'sus2',
  sus4: 'sus4',
  add9: 'add9',
  madd9: 'm(add9)',
  six: '6',
  six9: '6/9',
  maj9: 'maj9',
  min9: 'm9',
  dom9: '9',
  min11: 'm11',
  dom9sus4: '9sus4',
  aug: '+',
};

/** Triad family of a quality (for spicing and for keeping a chord's function). */
export function baseQuality(q: Quality): 'maj' | 'min' | 'dom' | 'sus' {
  if (q === 'min' || q === 'min7' || q === 'madd9' || q === 'min9' || q === 'min11') return 'min';
  if (q === 'dom7' || q === 'dom9') return 'dom';
  if (q === 'sus2' || q === 'sus4' || q === 'dom9sus4') return 'sus';
  return 'maj';
}

export function chordTones(root: number, quality: Quality): number[] {
  const r = ((root % 12) + 12) % 12;
  return INTERVALS[quality].map((i) => (r + i) % 12);
}

export function chordName(root: number, quality: Quality, sharps = false): string {
  return `${(sharps ? SHARP_NAMES : ROOT_NAMES)[((root % 12) + 12) % 12]}${SUFFIX[quality]}`;
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

/**
 * Close-position voicing in [50, 70] (big chords up to 75) nearest to the previous
 * voicing (smooth voice leading). `lift` slides that whole window up by semitones.
 */
export function voiceChord(root: number, quality: Quality, prev: number[] | null, lift = 0): number[] {
  // Keep the stacking order (9ths / 11ths above the 7th), not sorted pitch classes.
  const tones = INTERVALS[quality].map((i) => (((root % 12) + 12) % 12) + i);
  const n = tones.length;
  const candidates: number[][] = [];
  for (let inv = 0; inv < n; inv++) {
    const order = tones.map((_, k) => tones[(inv + k) % n] % 12);
    for (let base = 48; base <= 72; base += 12) {
      const v: number[] = [];
      let last = -Infinity;
      for (const pc of order) {
        let m = base + pc;
        while (m <= last) m += 12;
        v.push(m);
        last = m;
      }
      if (v[0] >= 50 + lift && v[n - 1] <= (n >= 4 ? 75 : 70) + lift) candidates.push(v);
    }
  }
  const target = prev ?? [55 + lift, 60 + lift, 64 + lift];
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
  /** 0–3: how readily chords from outside the key are used where the melody sings outside notes. */
  chroma: number;
}

interface ScoreContext {
  /** 0–3, see ChordOptions.chroma. */
  chroma?: number;
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

/**
 * Chords for sung notes from outside the key. They are only ever candidates
 * where the melody really has such a note, and they still have to fit the rest
 * of the melody better than the in-key chords: a plain tonic stays a tonic.
 *
 * Always: the augmented chord whose raised 5th is the note (A# over D → D+),
 * and borrowed chords containing it (C over D major → C, the bVII).
 * Chromatic level 1+: dominant 7ths that lead to a chord of the key.
 * Level 2+: any major or minor triad containing the note.
 * Higher levels also make these chords win more readily.
 */
function raisedFifths(w: Float64Array, total: number, ctx: ScoreContext): Degree[] {
  const out: Degree[] = [];
  if (total <= 0) return out;
  const level = ctx.chroma ?? 0;
  const prior = 0.1 + 0.12 * level;
  const tonic = ctx.key.tonic;
  for (let pc = 0; pc < 12; pc++) {
    if (ctx.scale.has(pc) || w[pc] / total < 0.04) continue;
    const has = (offset: number, quality: Quality): boolean => chordTones(tonic + offset, quality).includes(pc);
    for (const d of ctx.degrees) {
      if (d.quality === 'maj' && (tonic + d.offset + 8) % 12 === pc) {
        out.push({ offset: d.offset, quality: 'aug', numeral: `${d.numeral}+`, prior: d.prior * 0.5 + 0.1 * level });
      }
    }
    for (const b of BORROWED[ctx.key.mode]) if (has(b.offset, b.quality)) out.push({ ...b, prior });
    if (level >= 1) {
      for (const d of ctx.degrees) {
        const offset = (d.offset + 7) % 12;
        if (d.quality !== 'dom7' && d.offset !== 0 && has(offset, 'dom7')) out.push({ offset, quality: 'dom7', numeral: `V7/${d.numeral}`, prior });
      }
    }
    if (level >= 2) {
      for (let offset = 0; offset < 12; offset++) {
        for (const quality of ['maj', 'min'] as const) if (has(offset, quality)) out.push({ offset, quality, numeral: '', prior: prior - 0.08 });
      }
    }
  }
  return out;
}

function bestChord(w: Float64Array, total: number, ctx: ScoreContext): { degree: Degree; score: number } {
  let degree = ctx.degrees[0];
  let score = -Infinity;
  for (const d of [...ctx.degrees, ...raisedFifths(w, total, ctx)]) {
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
    prev
      ? (degrees.find((d) => (key.tonic + d.offset) % 12 === prev?.root && d.quality === prev.quality) ??
        degrees.find((d) => (key.tonic + d.offset) % 12 === prev?.root) ??
        degrees[0])
      : degrees[0];

  const emit = (start: number, end: number, d: Degree): void => {
    const root = (key.tonic + d.offset) % 12;
    const chord: Chord = {
      start,
      duration: end - start,
      root,
      quality: d.quality,
      name: chordName(root, d.quality, prefersSharps(key)),
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
    const ctx = (): ScoreContext => ({ key, degrees, scale, prev: prev ? { root: prev.root, quality: prev.quality } : null, edge, chroma: options.chroma ?? 0 });
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
      const differs = first.degree.offset !== second.degree.offset || first.degree.quality !== second.degree.quality;
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

/**
 * Loosen chord changes onto the singing: each change moves to the nearest sung
 * note start within `maxShiftSec` (early entries win ties, as singers often
 * anticipate the bar), and the neighbouring chords stretch to meet it.
 */
export function floatChords(chords: Chord[], notes: Note[], maxShiftSec: number): Chord[] {
  if (chords.length < 2 || notes.length === 0) return chords;
  const out = chords.map((c) => ({ ...c }));
  const starts = notes.map((n) => n.start);
  for (let i = 1; i < out.length; i++) {
    const b = out[i].start;
    let best = b;
    let bestD = maxShiftSec;
    for (const t of starts) {
      const d = Math.abs(t - b) * (t < b ? 0.9 : 1);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    const prevStart = out[i - 1].start;
    const end = out[i].start + out[i].duration;
    best = Math.max(prevStart + 0.25, Math.min(end - 0.25, best));
    out[i - 1].duration = best - prevStart;
    out[i].start = best;
    out[i].duration = end - best;
  }
  return out;
}

// ---------------------------------------------------------------- spice + editing

export const SPICE_LEVELS = ['Plain', '7ths', 'Lush', 'Neo-soul'] as const;

/** The spiced quality of a chord at a spice level, by its function in the key. */
function spiced(root: number, q: Quality, key: { tonic: number; mode: Mode }, level: number): Quality[] {
  if (level <= 0 || q === 'aug') return [q];
  const fam = baseQuality(q);
  const deg = (root - key.tonic + 12) % 12;
  const isDominant = fam === 'dom' || (fam === 'maj' && deg === 7);
  if (isDominant) return level === 1 ? ['dom7'] : level === 2 ? ['dom9', 'dom7'] : ['dom9sus4', 'dom9', 'dom7'];
  if (fam === 'min') return level === 1 ? ['min7'] : level === 2 ? ['min9', 'min7'] : ['min11', 'min9', 'min7'];
  if (fam === 'sus') return [q];
  // Major, non-dominant: maj7 on I / IV (or III / VI / VII in minor), add9 otherwise.
  return level === 1 ? ['maj7', 'six'] : level === 2 ? ['maj9', 'add9'] : ['maj9', 'six9', 'add9'];
}

/** Melody notes a semitone above an added tone grind against it: those colours are skipped. */
function clashes(root: number, q: Quality, w: Float64Array, total: number): boolean {
  if (total <= 0) return false;
  const base = new Set(INTERVALS[baseQuality(q) === 'min' ? 'min' : 'maj'].map((i) => (root + i) % 12));
  const r = ((root % 12) + 12) % 12;
  // A melody note on the chord's 3rd / 5th carries the chord: colours next to it are fine.
  const rubs = (m: number): boolean => !(base.has(m) && m !== r);
  for (const i of INTERVALS[q]) {
    const pc = (root + i) % 12;
    if (base.has(pc)) continue;
    const up = (pc + 1) % 12;
    const down = (pc + 11) % 12;
    if ((rubs(up) && w[up] / total > 0.12) || (rubs(down) && w[down] / total > 0.25)) return true;
  }
  return false;
}

/** Small seeded random source (mulberry32): the same seed always gives the same chords. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pool = [quality: Quality, weight: number][];
/** Colours to draw from, per family and spice level (1–3): a mix, not one extension for everything. */
const COLOURS: Record<'maj' | 'min' | 'dom', Pool[]> = {
  maj: [
    [['maj', 2], ['add9', 2], ['maj7', 2], ['six', 1]],
    [['maj7', 2], ['maj9', 2], ['add9', 2], ['six9', 1], ['six', 1]],
    [['maj9', 3], ['six9', 2], ['maj7', 1], ['add9', 1]],
  ],
  min: [
    [['min', 1], ['min7', 3], ['madd9', 1]],
    [['min7', 2], ['min9', 2], ['madd9', 1], ['min11', 1]],
    [['min11', 2], ['min9', 3], ['min7', 1], ['madd9', 1]],
  ],
  dom: [
    [['dom7', 3], ['maj', 1]],
    [['dom7', 1], ['dom9', 2], ['dom9sus4', 1]],
    [['dom9sus4', 2], ['dom9', 2], ['dom7', 1]],
  ],
};

/**
 * Other chords that could stand where one is (offsets from the tonic): every 7th chord of
 * the key, from level 2 the borrowed ones (bVII9, minor iv, bVImaj7) and a dominant leading
 * into the chord that follows, and at the top level the tritone substitute of a dominant.
 * Which of them is actually allowed is decided by the melody (see spiceChords).
 */
function standIns(deg: number, dominant: boolean, mode: Mode, level: number, nextDeg: number | null): { offset: number; quality: Quality }[] {
  const out: { offset: number; quality: Quality }[] =
    mode === 'major'
      ? [
          { offset: 0, quality: 'maj7' },
          { offset: 2, quality: 'min7' },
          { offset: 4, quality: 'min7' },
          { offset: 5, quality: 'maj7' },
          { offset: 7, quality: 'dom7' },
          { offset: 9, quality: 'min7' },
        ]
      : [
          { offset: 0, quality: 'min7' },
          { offset: 3, quality: 'maj7' },
          { offset: 5, quality: 'min7' },
          { offset: 7, quality: 'dom7' },
          { offset: 8, quality: 'maj7' },
          { offset: 10, quality: 'dom7' },
        ];
  if (level >= 2) {
    if (mode === 'major') out.push({ offset: 10, quality: 'dom9' }, { offset: 5, quality: 'madd9' }, { offset: 8, quality: 'maj7' });
    else out.push({ offset: 1, quality: 'maj7' }, { offset: 5, quality: 'dom7' });
    if (nextDeg !== null) out.push({ offset: (nextDeg + 7) % 12, quality: 'dom7' });
  }
  if (level >= 3 && dominant) out.push({ offset: (deg + 6) % 12, quality: 'dom7' });
  return out.filter((x) => x.offset !== deg);
}

/** How much of the melody a chord carries, and how much sits a semitone above one of its tones. */
function carries(root: number, q: Quality, w: Float64Array, total: number): { cover: number; rub: number } {
  if (total <= 0) return { cover: 1, rub: 0 };
  const tones = new Set(chordTones(root, q));
  let cover = 0;
  let rub = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (tones.has(pc)) cover += w[pc];
    else if (tones.has((pc + 11) % 12)) rub += w[pc];
  }
  return { cover: cover / total, rub: rub / total };
}

/**
 * Spice the chords up, skipping colours the melody would rub against.
 * Without a seed: one fixed colour per function and level (every dominant a 9th, and so on).
 * With a seed: a mix. Each chord draws its own colour, neighbours avoid wearing the same one,
 * and many chords are swapped for another that carries the melody just as well (more of them, and
 * from further away, the higher the level).
 * The first and last chord stay home. A new seed is a new take on the same progression.
 */
export function spiceChords(chords: Chord[], notes: Note[], key: { tonic: number; mode: Mode }, level: number, keep: Set<number> = new Set(), seed = 0): Chord[] {
  if (!seed || level <= 0) {
    return chords.map((c, i) => {
      if (keep.has(i)) return c;
      const { w, total } = melodyWeights(notes, c.start, c.start + c.duration);
      const q = spiced(c.root, c.quality, key, level).find((x) => !clashes(c.root, x, w, total)) ?? c.quality;
      return q === c.quality ? c : { ...c, quality: q, name: chordName(c.root, q, prefersSharps(key)) };
    });
  }
  const lv = Math.min(3, Math.round(level));
  const sharps = prefersSharps(key);
  let last: { root: number; quality: Quality } | null = null;
  return chords.map((c, i) => {
    const out = ((): Chord => {
      if (keep.has(i) || c.quality === 'aug') return c;
      const rnd = seeded(seed * 7919 + i * 104729 + lv * 31);
      const { w, total } = melodyWeights(notes, c.start, c.start + c.duration);
      const fam = baseQuality(c.quality);
      const deg = (c.root - key.tonic + 12) % 12;
      const dominant = fam === 'dom' || (fam === 'maj' && deg === 7);
      // Often: another chord altogether, if it carries the melody as well as this one.
      const edge = i === 0 || i === chords.length - 1;
      let root = c.root;
      let quality: Quality = c.quality;
      let swapped = false;
      if (!edge && rnd() < [0.35, 0.55, 0.75][lv - 1]) {
        const own = carries(c.root, c.quality, w, total);
        const next = chords[i + 1];
        const options = standIns(deg, dominant, key.mode, lv, next ? (next.root - key.tonic + 12) % 12 : null).filter((x) => {
          const r = (key.tonic + x.offset) % 12;
          const fit = carries(r, x.quality, w, total);
          return fit.cover >= own.cover - 0.1 && fit.rub < 0.1 && !clashes(r, x.quality, w, total) && r !== last?.root && r !== next?.root;
        });
        if (options.length) {
          const x = options[Math.floor(rnd() * options.length)];
          root = (key.tonic + x.offset) % 12;
          quality = x.quality;
          swapped = true;
        }
      }
      const moved = (q: Quality): Chord => (swapped ? { ...c, root, quality: q, name: chordName(root, q, sharps), numeral: '' } : q === c.quality ? c : { ...c, quality: q, name: chordName(c.root, q, sharps) });
      const nowFam = baseQuality(quality);
      if (nowFam === 'sus' || quality === 'madd9') return moved(quality);
      const nowDom = swapped ? nowFam === 'dom' : dominant;
      // Its colour: drawn by weight; one that rubs the melody, or that the chord before already wears, is passed over.
      const pool = COLOURS[nowDom ? 'dom' : nowFam === 'min' ? 'min' : 'maj'][lv - 1].map(([q, wt]) => ({ q, r: Math.pow(rnd(), 1 / wt) }));
      pool.sort((x, y) => y.r - x.r);
      const ok = pool.map((x) => x.q).filter((q) => !clashes(root, q, w, total));
      return moved(ok.find((x) => x !== last?.quality) ?? ok[0] ?? quality);
    })();
    last = { root: out.root, quality: out.quality };
    return out;
  });
}

export const CHROMA_LEVELS = ['In key', 'Loose', 'Chromatic', 'Free'] as const;

/**
 * How far (semitones) a sung outside note may be pulled onto its in-key neighbour,
 * per chromatic level. 0.8 pulls anything leaning 20 cents or more; 0 never pulls.
 */
export const CHROMA_FIT_DISTANCE = [0.8, 0.65, 0.55, 0] as const;

/**
 * Re-voice a progression for smooth voice leading (after edits / spice).
 * `lift` (see keysLift) slides the register up; at the full lift the bass goes up an octave too.
 */
export function revoice(chords: Chord[], lift = 0): Chord[] {
  let prev: number[] | null = null;
  return chords.map((c) => {
    const voicing = voiceChord(c.root, c.quality, prev, lift);
    prev = voicing;
    return { ...c, voicing, bass: 36 + c.root + (lift >= MAX_LIFT ? 12 : 0) };
  });
}

/** A fourth: enough to clear a low voice, while 9ths and 11ths stay below ~G5. */
const MAX_LIFT = 5;

/**
 * Semitones to slide the keys' register up so they sit just above a low voice
 * instead of inside it. The close voicings live around middle C (50–70): the
 * lower the voice is centred below D4, the more they rise, up to a fourth.
 * (A full octave put the extended chords far too high.)
 */
export function keysLift(notes: Note[]): number {
  if (notes.length === 0) return 0;
  const byPitch = [...notes].sort((a, b) => a.midi - b.midi);
  const half = byPitch.reduce((s, n) => s + n.duration, 0) / 2;
  let acc = 0;
  for (const n of byPitch) {
    acc += n.duration;
    if (acc >= half) return Math.max(0, Math.min(MAX_LIFT, 62 - n.midi));
  }
  return 0;
}

export interface ChordChoice {
  root: number;
  quality: Quality;
  name: string;
  /** Roman numeral, or '' for chords from outside the key. */
  numeral: string;
  /** How well it fits the melody in that slot (higher = better). */
  fit: number;
}

/** Borrowed chords worth offering (they sound great over many melodies). */
const BORROWED: Record<Mode, { offset: number; quality: Quality; numeral: string }[]> = {
  major: [
    { offset: 5, quality: 'min', numeral: 'iv' },
    { offset: 10, quality: 'maj', numeral: 'bVII' },
    { offset: 8, quality: 'maj', numeral: 'bVI' },
    { offset: 2, quality: 'maj', numeral: 'II' },
    { offset: 4, quality: 'maj', numeral: 'III' },
  ],
  minor: [
    { offset: 5, quality: 'maj', numeral: 'IV' },
    { offset: 2, quality: 'min', numeral: 'ii' },
    { offset: 1, quality: 'maj', numeral: 'bII' },
  ],
};

/** Chords that could go in [start, end), best fit to the melody first (diatonic, then borrowed). */
export function chordChoices(notes: Note[], key: { tonic: number; mode: Mode }, start: number, end: number): ChordChoice[] {
  const degrees = key.mode === 'major' ? MAJOR_DEGREES : MINOR_DEGREES;
  const scale = new Set((key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11]).map((x) => (key.tonic + x) % 12));
  const { w, total } = melodyWeights(notes, start, end);
  const ctx: ScoreContext = { key, degrees, scale, prev: null, edge: false };
  const seen = new Set<string>();
  const out: ChordChoice[] = [];
  const add = (d: Degree, bias: number): void => {
    const root = (key.tonic + d.offset) % 12;
    const id = `${root}:${d.quality}`;
    if (seen.has(id)) return;
    seen.add(id);
    const fit = total > 0 ? scoreChord(d, w, total, ctx) + bias : d.prior;
    out.push({ root, quality: d.quality, name: chordName(root, d.quality, prefersSharps(key)), numeral: d.numeral, fit });
  };
  for (const d of degrees) if (d.quality !== 'dom7') add(d, 0);
  for (const b of BORROWED[key.mode]) add({ ...b, prior: 0.1 }, -0.15);
  for (const d of raisedFifths(w, total, ctx)) add(d, 0.2);
  return out.sort((a, b) => b.fit - a.fit);
}

/** Colour variants of one chord root, for the picker. */
export function flavours(root: number, q: Quality, sharps = false): ChordChoice[] {
  const fam = baseQuality(q);
  const list: Quality[] =
    fam === 'min'
      ? ['min', 'min7', 'min9', 'min11', 'madd9', 'sus2', 'sus4']
      : fam === 'dom'
        ? ['maj', 'dom7', 'dom9', 'dom9sus4', 'sus4', 'sus2']
        : ['maj', 'maj7', 'maj9', 'add9', 'six', 'six9', 'sus2', 'sus4', 'dom7', 'aug'];
  return list.map((quality) => ({ root, quality, name: chordName(root, quality, sharps), numeral: '', fit: 0 }));
}
