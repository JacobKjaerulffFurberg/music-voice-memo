/**
 * Chord recognition from played notes (piano / guitar), per beat with a
 * Viterbi smoother so chords don't flicker:
 *  - pitch-class weights from note overlap × level, bass (lowest note) weighted extra
 *  - vocabulary: 12 roots × maj, min, 7, m7, maj7
 *  - score: chord tones present − non-chord tones, missing-tone penalty,
 *    bass-is-root bonus, slight preference for triads and for in-key chords
 */

import type { Mode, Note } from './types';

export type ChordQuality = 'maj' | 'min' | 'dom7' | 'min7' | 'maj7';

export const QUALITY_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
};

const SUFFIX: Record<ChordQuality, string> = { maj: '', min: 'm', dom7: '7', min7: 'm7', maj7: 'maj7' };
const ROOT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function chordLabel(root: number, quality: ChordQuality): string {
  return `${ROOT_NAMES[((root % 12) + 12) % 12]}${SUFFIX[quality]}`;
}

export interface DetectedChord {
  start: number;
  duration: number;
  root: number;
  quality: ChordQuality;
  name: string;
}

interface ChordDef {
  root: number;
  quality: ChordQuality;
  tones: Set<number>;
}

const VOCAB: ChordDef[] = [];
for (const q of Object.keys(QUALITY_INTERVALS) as ChordQuality[]) {
  for (let r = 0; r < 12; r++) VOCAB.push({ root: r, quality: q, tones: new Set(QUALITY_INTERVALS[q].map((i) => (r + i) % 12)) });
}

function segmentWeights(notes: Note[], start: number, end: number): { w: Float64Array; total: number; bass: number } {
  const w = new Float64Array(12);
  let total = 0;
  let bass = -1;
  let bassMidi = Infinity;
  for (const n of notes) {
    const ov = Math.min(end, n.start + n.duration) - Math.max(start, n.start);
    if (ov <= 0) continue;
    const pc = ((n.midi % 12) + 12) % 12;
    const x = ov * (0.3 + n.level);
    w[pc] += x;
    total += x;
    if (n.midi < bassMidi && ov > 0.3 * (end - start)) {
      bassMidi = n.midi;
      bass = pc;
    }
  }
  if (bass >= 0) {
    w[bass] += 0.25 * total; // the bass note defines the chord more than its share of time
    total *= 1.25;
  }
  return { w, total, bass };
}

function scoreChord(c: ChordDef, w: Float64Array, total: number, bass: number, inKey: Set<number> | null): number {
  let s = 0;
  for (let pc = 0; pc < 12; pc++) s += (w[pc] / total) * (c.tones.has(pc) ? 1 : -0.8);
  for (const t of c.tones) if (w[t] < 0.04 * total) s -= t === c.root ? 0.35 : 0.15;
  // A 7th chord needs its 7th clearly played (a faint overtone ghost isn't enough).
  if (c.tones.size > 3) {
    const seventh = (c.root + QUALITY_INTERVALS[c.quality][3]) % 12;
    if (w[seventh] < 0.1 * total) s -= 0.3;
  }
  if (bass === c.root) s += 0.15;
  if (c.tones.size > 3) s -= 0.06;
  if (inKey) {
    let fits = true;
    for (const t of c.tones) if (!inKey.has(t)) fits = false;
    if (fits) s += 0.04;
  }
  return s;
}

/**
 * Settle relative-key ambiguity (C major vs A minor share every note) from the
 * progression: a key whose tonic chord opens / closes the take, or takes up
 * most of the time, wins among the histogram's top candidates.
 */
export function refineKeyWithChords<K extends { tonic: number; mode: Mode; score: number }>(candidates: K[], chords: DetectedChord[]): K | null {
  if (!candidates.length) return null;
  if (!chords.length) return candidates[0];
  const isMinor = (q: ChordQuality): boolean => q === 'min' || q === 'min7';
  const isTonic = (c: DetectedChord, k: K): boolean => c.root === k.tonic && isMinor(c.quality) === (k.mode === 'minor');
  const total = chords.reduce((s, c) => s + c.duration, 0) || 1;
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const k of candidates) {
    const time = chords.filter((c) => isTonic(c, k)).reduce((s, c) => s + c.duration, 0) / total;
    const s = k.score + (isTonic(chords[0], k) ? 0.12 : 0) + (isTonic(chords[chords.length - 1], k) ? 0.18 : 0) + 0.15 * time;
    if (s > bestScore) {
      bestScore = s;
      best = k;
    }
  }
  return best;
}

/** Best chord for a pitch-class weight vector (used by the live readout). */
export function chordFromWeights(
  w: ArrayLike<number>,
  bass: number,
  key: { tonic: number; mode: Mode } | null = null,
): { root: number; quality: ChordQuality; name: string; score: number } | null {
  let total = 0;
  for (let i = 0; i < 12; i++) total += w[i];
  if (!(total > 0)) return null;
  const wf = Float64Array.from({ length: 12 }, (_, i) => w[i]);
  const inKey = key
    ? new Set((key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11]).map((s) => (key.tonic + s) % 12))
    : null;
  let best: ChordDef | null = null;
  let bestScore = -Infinity;
  for (const c of VOCAB) {
    const s = scoreChord(c, wf, total, bass, inKey);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best ? { root: best.root, quality: best.quality, name: chordLabel(best.root, best.quality), score: bestScore } : null;
}

export interface ChordDetectOptions {
  /** Seconds per analysis step (usually one beat). */
  stepSec: number;
  /** First step boundary (usually the first downbeat). */
  originSec: number;
  durationSec: number;
  key: { tonic: number; mode: Mode } | null;
  /** Cost of changing chord between steps. */
  switchPenalty: number;
}

export function detectChords(notes: Note[], o: ChordDetectOptions): DetectedChord[] {
  if (notes.length === 0 || o.stepSec <= 0) return [];
  const inKey = o.key
    ? new Set((o.key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11]).map((s) => (o.key!.tonic + s) % 12))
    : null;
  // Steps cover the whole take (including a pickup before the first downbeat).
  const k0 = Math.floor((0 - o.originSec) / o.stepSec);
  const k1 = Math.ceil((o.durationSec - o.originSec) / o.stepSec);
  const steps: { start: number; end: number; scores: Float64Array | null }[] = [];
  for (let k = k0; k < k1; k++) {
    const start = Math.max(0, o.originSec + k * o.stepSec);
    const end = Math.min(o.durationSec, o.originSec + (k + 1) * o.stepSec);
    if (end - start < 0.02) continue;
    const { w, total, bass } = segmentWeights(notes, start, end);
    if (total <= 0) {
      steps.push({ start, end, scores: null });
      continue;
    }
    const scores = new Float64Array(VOCAB.length);
    VOCAB.forEach((c, i) => (scores[i] = scoreChord(c, w, total, bass, inKey)));
    steps.push({ start, end, scores });
  }

  // Viterbi over chord labels; silent steps don't vote.
  const S = VOCAB.length;
  let cost = new Float64Array(S);
  const back: Int16Array[] = [];
  steps.forEach((st, t) => {
    const next = new Float64Array(S);
    const bp = new Int16Array(S);
    let bestPrev = 0;
    for (let i = 1; i < S; i++) if (cost[i] > cost[bestPrev]) bestPrev = i;
    for (let i = 0; i < S; i++) {
      const stay = cost[i];
      const jump = cost[bestPrev] - o.switchPenalty;
      const em = st.scores ? st.scores[i] : 0;
      if (t === 0 || stay >= jump) {
        next[i] = stay + em;
        bp[i] = i;
      } else {
        next[i] = jump + em;
        bp[i] = bestPrev;
      }
    }
    back.push(bp);
    cost = next;
  });
  if (!steps.length) return [];
  const path = new Int16Array(steps.length);
  let best = 0;
  for (let i = 1; i < S; i++) if (cost[i] > cost[best]) best = i;
  path[steps.length - 1] = best;
  for (let t = steps.length - 1; t > 0; t--) path[t - 1] = back[t][path[t]];

  // Merge runs; drop leading/trailing silent steps.
  const out: DetectedChord[] = [];
  const firstSounding = steps.findIndex((s) => s.scores);
  const lastSounding = steps.length - 1 - [...steps].reverse().findIndex((s) => s.scores);
  if (firstSounding < 0) return [];
  for (let t = firstSounding; t <= lastSounding; t++) {
    const c = VOCAB[path[t]];
    const prev = out[out.length - 1];
    if (prev && prev.root === c.root && prev.quality === c.quality) {
      prev.duration = steps[t].end - prev.start;
    } else {
      out.push({ start: steps[t].start, duration: steps[t].end - steps[t].start, root: c.root, quality: c.quality, name: chordLabel(c.root, c.quality) });
    }
  }
  return out;
}
