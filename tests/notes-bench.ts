/**
 * Note-detection benchmark on synthetic sloppy singing (full pipeline, audio level).
 * Run: BENCH=1 npx vite-node tests/notes-bench.ts
 */
import { analyze, analyzeHighQuality, type AnalyzeOptions } from '../src/analysis/pipeline';
import { synthMelody, TEST_MELODIES, type SynthOptions } from '../src/analysis/synth';
import type { AnalysisResult } from '../src/analysis/types';

const SR = 44100;

/** Rough singer: scoops, vibrato, timing + pitch errors, breath noise, room echo. */
export function singer(seed: number): Partial<SynthOptions> {
  const r = (k: number): number => {
    const x = Math.sin(seed * 9301 + k * 49297) * 233280;
    return x - Math.floor(x);
  };
  return {
    scoopCents: -80 - 140 * r(1),
    scoopSec: 0.06 + 0.06 * r(2),
    vibratoCents: 20 + 35 * r(3),
    vibratoHz: 4.5 + 2 * r(4),
    timingJitterSec: 0.02 + 0.03 * r(5),
    pitchErrorCents: 10 + 20 * r(6),
    detuneCents: -40 + 80 * r(7),
    harmonics: r(8) < 0.5 ? [1, 0.6, 0.35, 0.2] : [0.6, 1, 0.5, 0.3, 0.15],
    noise: 0.004 + 0.02 * r(9),
    gapSec: 0.01 + 0.05 * r(10),
    seed,
  };
}

/** Simple room: a few decaying echoes. */
function room(x: Float32Array, amount: number): Float32Array {
  if (amount <= 0) return x;
  const y = Float32Array.from(x);
  for (const [ms, g] of [
    [23, 0.35],
    [41, 0.25],
    [67, 0.18],
    [97, 0.12],
  ] as const) {
    const d = Math.round((ms / 1000) * SR);
    for (let i = d; i < x.length; i++) y[i] += amount * g * x[i - d];
  }
  return y;
}

/** Same pitch sung several times in a row (must stay separate notes). */
const REPEATS = { notes: [62, 62, 62, 64, 66, 66, 66, 64, 62, 62, 67, 67, 66, 64, 62].map((midi, i) => ({ midi, beats: i === 9 || i === 14 ? 2 : 1 })) };

export interface Case {
  name: string;
  samples: Float32Array;
  truth: { midi: number; start: number }[];
  bpm: number;
}

export function cases(n = 16, hard = false): Case[] {
  const out: Case[] = [];
  const mels = Object.entries(TEST_MELODIES);
  for (let i = 0; i < n; i++) {
    const [name, mel] = i % 4 === 3 ? ['Repeats', REPEATS] : mels[i % mels.length];
    const bpm = [84, 96, 108, 120, 132, 144][i % 6];
    const o = singer(i + 1);
    const echo = hard ? 1 + 0.3 * (i % 2) : i % 3 === 0 ? 0.8 : i % 3 === 1 ? 0.4 : 0;
    const samples = room(synthMelody(mel.notes, { ...o, ...(hard ? { noise: 0.03, timingJitterSec: 0.05, pitchErrorCents: 30 } : {}), bpm, sampleRate: SR }), echo);
    let t = 0.5;
    const truth = mel.notes.map((nt) => {
      const e = { midi: nt.midi, start: t };
      t += (nt.beats * 60) / bpm;
      return e;
    });
    out.push({ name: `${name} ${bpm} s${i + 1} echo${echo}`, samples, truth, bpm });
  }
  return out;
}

export function score(r: AnalysisResult, c: Case): { f1: number; exact: boolean; bpmOk: boolean } {
  const used = new Set<number>();
  let hit = 0;
  for (const t of c.truth) {
    const j = r.notes.findIndex((n, k) => !used.has(k) && n.midi === t.midi && Math.abs(n.start - t.start) < 0.09);
    if (j >= 0) {
      used.add(j);
      hit++;
    }
  }
  const p = r.notes.length ? hit / r.notes.length : 0;
  const rc = hit / c.truth.length;
  const bpm = r.tempo.chosen?.bpm ?? 0;
  return {
    f1: p + rc > 0 ? (2 * p * rc) / (p + rc) : 0,
    exact: r.notes.length === c.truth.length && hit === c.truth.length,
    bpmOk: Math.abs(bpm / c.bpm - 1) < 0.03,
  };
}

export function run(label: string, opts: Partial<AnalyzeOptions> & { hq?: boolean }, n = 16, hard = false): void {
  let f1 = 0;
  let exact = 0;
  let bpm = 0;
  const t0 = performance.now();
  const bad: string[] = [];
  for (const c of cases(n, hard)) {
    const r = opts.hq ? analyzeHighQuality(c.samples, SR, {}, opts) : analyze(c.samples, SR, {}, opts);
    const s = score(r, c);
    f1 += s.f1;
    if (s.exact) exact++;
    else bad.push(`${c.name} (${r.notes.length}/${c.truth.length}, f1 ${s.f1.toFixed(2)})`);
    if (s.bpmOk) bpm++;
  }
  const ms = (performance.now() - t0) / n;
  console.log(`${label}: noteF1 ${(f1 / n).toFixed(3)} · exact ${exact}/${n} · bpm ${bpm}/${n} · ${ms.toFixed(0)} ms/take`);
  if (bad.length) console.log('   misses: ' + bad.join(' | '));
}

if ((globalThis as { process?: { env: Record<string, string> } }).process?.env.BENCH) {
  run('normal', {});
}
