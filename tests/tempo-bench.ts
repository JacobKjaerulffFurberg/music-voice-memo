/**
 * Tempo / downbeat benchmark on simulated sung takes (onset level, fast).
 * Run: npx vite-node tests/tempo-bench.ts
 */
import { tempoFromNotes } from '../src/analysis/tempo';
import type { Note } from '../src/analysis/types';

export interface SimTake {
  notes: Note[];
  bpm: number;
  downbeat: number; // seconds of a true bar line
}

function rng(seed: number): () => number {
  let s = Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0 || 1;
  for (let i = 0; i < 5; i++) s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// One-bar rhythm patterns: [beatPos, lengthBeats, accent]
const PATTERNS: [number, number, number][][] = [
  [[0, 1, 1], [1, 1, 0.7], [2, 1, 0.85], [3, 1, 0.7]],
  [[0, 2, 1], [2, 1, 0.8], [3, 1, 0.7]],
  [[0, 1.5, 1], [1.5, 0.5, 0.6], [2, 2, 0.85]],
  [[0, 0.5, 1], [0.5, 0.5, 0.6], [1, 1, 0.7], [2, 0.5, 0.85], [2.5, 0.5, 0.6], [3, 1, 0.7]],
  [[0, 3, 1], [3, 1, 0.7]],
  [[0, 1, 1], [1, 0.5, 0.6], [1.5, 1, 0.75], [2.5, 0.5, 0.6], [3, 1, 0.7]], // syncopated
  [[0, 4, 1]],
  [[0.5, 0.5, 0.7], [1, 1, 0.8], [2, 1, 0.9], [3, 0.5, 0.6], [3.5, 0.5, 0.7]], // starts off the 1
  [[0, 1, 1], [1, 1, 0.7], [2, 2, 0.85]],
];

export function simTake(seed: number): SimTake {
  const r = rng(seed);
  const bpm = 72 + Math.floor(r() * 85); // 72..156
  const P = 60 / bpm;
  const jitter = 0.015 + r() * 0.035; // 15–50 ms timing sloppiness
  const drift = (r() - 0.5) * 0.04; // ±2 % tempo drift over the take
  const bars = 4 + Math.floor(r() * 5);
  const lead = 0.3 + r() * 1.5; // silence before singing
  const pickup = r() < 0.35 ? (r() < 0.5 ? 1 : 0.5) : 0; // anacrusis in beats
  const downbeat = lead + pickup * P;
  const notes: Note[] = [];
  const timeOf = (beat: number): number => downbeat + beat * P * (1 + (drift * beat) / (bars * 4));
  const add = (beat: number, len: number, acc: number): void => {
    if (r() < 0.06) return; // missed note
    const t = timeOf(beat) + (r() * 2 - 1) * jitter + 0.01; // detectors are a little late
    const dur = Math.max(0.06, len * P * (0.55 + 0.4 * r()));
    const vel = Math.round(Math.min(127, Math.max(20, 95 * acc + (r() - 0.5) * 30)));
    notes.push({ midi: 60 + Math.floor(r() * 12), start: t, duration: dur, cents: 0, hz: 0, level: vel / 1000, velocity: vel });
  };
  if (pickup === 1) add(-1, 1, 0.6);
  if (pickup === 0.5) add(-0.5, 0.5, 0.6);
  const motif = Math.floor(r() * PATTERNS.length);
  for (let b = 0; b < bars; b++) {
    const pat = r() < 0.6 ? PATTERNS[motif] : PATTERNS[Math.floor(r() * PATTERNS.length)];
    for (const [pos, len, acc] of pat) add(b * 4 + pos, len, acc);
  }
  // Occasional doubled onsets (a consonant split into two notes).
  if (r() < 0.3 && notes.length > 3) {
    const n = notes[Math.floor(r() * notes.length)];
    notes.push({ ...n, start: n.start + 0.07, duration: n.duration / 2 });
  }
  notes.sort((a, b) => a.start - b.start);
  return { notes, bpm, downbeat };
}

export function evaluate(
  detect: (notes: Note[]) => { bpm: number; firstBeatMs: number } | null,
  n = 400,
): { bpmOk: number; octave: number; beatOk: number; barOk: number; medianBeatErrMs: number } {
  let bpmOk = 0;
  let octave = 0;
  let beatOk = 0;
  let barOk = 0;
  const errs: number[] = [];
  for (let i = 1; i <= n; i++) {
    const t = simTake(i);
    const r = detect(t.notes);
    if (!r) continue;
    const ratio = r.bpm / t.bpm;
    const exact = Math.abs(ratio - 1) < 0.03;
    if (exact) bpmOk++;
    else if ([0.5, 2, 2 / 3, 1.5].some((k) => Math.abs(ratio / k - 1) < 0.03)) octave++;
    if (!exact) continue;
    const P = 60 / t.bpm;
    const fb = r.firstBeatMs / 1000;
    const dBeat = (((fb - t.downbeat) / P) % 1 + 1.5) % 1 - 0.5;
    errs.push(Math.abs(dBeat * P * 1000));
    if (Math.abs(dBeat * P) < 0.06) {
      beatOk++;
      const dBar = Math.round((fb - t.downbeat) / P);
      if (((dBar % 4) + 4) % 4 === 0) barOk++;
    }
  }
  errs.sort((a, b) => a - b);
  return { bpmOk: bpmOk / n, octave: octave / n, beatOk: beatOk / n, barOk: barOk / n, medianBeatErrMs: errs[errs.length >> 1] ?? NaN };
}

if ((globalThis as { process?: { env: Record<string, string> } }).process?.env.BENCH) {
  console.log('current', evaluate((notes) => tempoFromNotes(notes)));
}
