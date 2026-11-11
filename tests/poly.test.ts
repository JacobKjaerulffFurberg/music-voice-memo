import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/pipeline';
import { synthInstrument, synthMelody, TEST_MELODIES, type InstrumentEvent } from '../src/analysis/synth';
import { detectOnsets } from '../src/analysis/spectrum';
import { detectChords } from '../src/analysis/chords';
import type { Note } from '../src/analysis/types';

const SR = 44100;

function centsDiff(a: number, b: number): number {
  const d = (((a - b + 50) % 100) + 100) % 100 - 50;
  return Math.abs(d);
}

/** Each chord for one bar, struck on every beat (pattern = beats in the bar it is struck). */
function bars(chords: number[][], strikes: number[] = [0, 1, 2, 3], len = 1): InstrumentEvent[] {
  const ev: InstrumentEvent[] = [];
  chords.forEach((midis, bar) => {
    for (const s of strikes) ev.push({ midis, at: bar * 4 + s, beats: len });
  });
  return ev;
}

/** Chord name per bar (the chord covering the middle of each bar). */
function chordPerBar(chords: { start: number; duration: number; name: string }[], bpm: number, firstBeatSec: number, n: number): string[] {
  const bar = (60 / bpm) * 4;
  return Array.from({ length: n }, (_, i) => {
    const t = firstBeatSec + (i + 0.5) * bar;
    return chords.find((c) => c.start <= t && t < c.start + c.duration)?.name ?? '-';
  });
}

describe('onsets', () => {
  it('finds plucks to within 15 ms', () => {
    const x = synthInstrument(bars([[60, 64, 67]], [0, 1, 2, 3]), { bpm: 120 });
    const on = detectOnsets(x, SR);
    expect(on.length).toBe(4);
    on.forEach((o, i) => expect(Math.abs(o.time - (0.5 + i * 0.5))).toBeLessThan(0.015));
  });
});

describe('chord recognition from notes', () => {
  const n = (midi: number, start: number, duration: number): Note => ({ midi, start, duration, cents: 0, hz: 0, level: 0.5 });
  it('names triads, sevenths and uses the bass', () => {
    const notes = [
      ...[48, 60, 64, 67].map((m) => n(m, 0, 2)), // C
      ...[45, 60, 64, 69].map((m) => n(m, 2, 2)), // Am
      ...[43, 59, 62, 65, 67].map((m) => n(m, 4, 2)), // G7
      ...[41, 60, 64, 65, 69].map((m) => n(m, 6, 2)), // Fmaj7
    ];
    const c = detectChords(notes, { stepSec: 0.5, originSec: 0, durationSec: 8, key: { tonic: 0, mode: 'major' }, switchPenalty: 0.35 });
    expect(c.map((x) => x.name)).toEqual(['C', 'Am', 'G7', 'Fmaj7']);
  });
});

describe('piano: block chords', () => {
  const prog = [
    [48, 60, 64, 67], // C
    [45, 60, 64, 69], // Am
    [41, 60, 65, 69], // F
    [43, 59, 62, 67], // G
    [48, 60, 64, 67], // C
  ];
  for (const [bpm, detune] of [
    [100, 20],
    [84, -25],
    [126, 0],
  ]) {
    it(`C Am F G C at ${bpm} BPM, ${detune} c`, () => {
      const x = synthInstrument(bars(prog, [0, 2], 2), { bpm, detuneCents: detune });
      const r = analyze(x, SR);
      expect(r.input?.source).toBe('chords');
      expect(Math.abs((r.tempo.chosen?.bpm ?? 0) - bpm)).toBeLessThanOrEqual(2);
      expect(r.key.chosen?.name).toBe('C major');
      expect(centsDiff(r.tuning.cents, detune)).toBeLessThanOrEqual(8);
      const t = r.tempo.chosen;
      expect(chordPerBar(r.playedChords ?? [], t?.bpm ?? bpm, (t?.firstBeatMs ?? 0) / 1000, 5)).toEqual(['C', 'Am', 'F', 'G', 'C']);
      // Each chord is struck twice per bar (half notes): notes shouldn't run across strikes.
      const beat = 60 / bpm;
      const long = r.notes.filter((n) => n.duration > 2.6 * beat).length;
      expect(long / r.notes.length).toBeLessThan(0.15);
      // Octave / twelfth doublings above the bass survive cancellation: most struck notes are found.
      expect(r.notes.length).toBeGreaterThanOrEqual(36);
      expect(r.notes.length).toBeLessThanOrEqual(46);
    });
  }
});

describe('guitar: strummed chords', () => {
  it('Dm A7 Gm A7 Dm, strummed on every beat', () => {
    const prog = [
      [50, 57, 62, 65], // Dm
      [45, 52, 55, 61, 64], // A7
      [43, 50, 55, 58, 62], // Gm
      [45, 52, 55, 61, 64], // A7
      [50, 57, 62, 65], // Dm
    ];
    const bpm = 92;
    const x = synthInstrument(bars(prog), { bpm, strumSec: 0.012, decaySec: 0.9, inharmonicity: 0.00005, detuneCents: 12 });
    const r = analyze(x, SR);
    expect(r.input?.source).toBe('chords');
    expect(Math.abs((r.tempo.chosen?.bpm ?? 0) - bpm)).toBeLessThanOrEqual(2);
    expect(r.key.chosen?.name).toBe('D minor');
    const t = r.tempo.chosen;
    expect(chordPerBar(r.playedChords ?? [], t?.bpm ?? bpm, (t?.firstBeatMs ?? 0) / 1000, 5)).toEqual(['Dm', 'A7', 'Gm', 'A7', 'Dm']);
    // Every strum re-strikes the strings: most played notes should be about a beat long, not a bar.
    const beat = 60 / bpm;
    const long = r.notes.filter((n) => n.duration > 1.6 * beat).length;
    expect(long / r.notes.length).toBeLessThan(0.15);
  });
});

describe('guitar: high lead notes over chords', () => {
  // Chord strummed once per bar (ringing), with a fast 1/8-note lead up high.
  const chords = [
    [40, 47, 52, 56, 59, 64], // E
    [45, 52, 57, 60, 64], // Am
    [43, 47, 50, 55, 59, 67], // G
    [40, 47, 52, 56, 59, 64], // E
  ];
  const lead = [76, 79, 81, 83, 84, 83, 81, 79, 81, 84, 86, 84, 83, 81, 79, 76, 79, 83, 86, 88, 86, 83, 79, 83, 80, 83, 88, 86, 83, 80, 76, 80];
  for (const bpm of [96, 120]) {
    it(`finds the lead at ${bpm} BPM (E5–E6, eighth notes)`, () => {
      const ev: InstrumentEvent[] = [
        ...chords.map((midis, bar) => ({ midis, at: bar * 4, beats: 4 })),
        // Single picked notes are much quieter than a full strum.
        ...lead.map((m, i) => ({ midis: [m], at: i * 0.5, beats: 0.5, gain: 0.45 })),
      ];
      const x = synthInstrument(ev, { bpm, strumSec: 0.01, decaySec: 0.8, inharmonicity: 0.00005 });
      const r = analyze(x, SR, {}, { source: 'chords' });
      const beat = 60 / bpm;
      let found = 0;
      let lenOk = 0;
      lead.forEach((m, i) => {
        const t = 0.5 + i * 0.5 * beat;
        const hit = r.notes.find((n) => n.midi === m && Math.abs(n.start - t) < 0.06);
        if (hit) {
          found++;
          if (hit.duration > 0.6 * 0.5 * beat) lenOk++;
        }
      });
      // Remaining misses: lead notes struck together with a full strum *and* sitting
      // exactly on a partial of the strummed chord (same frequency → can't be separated).
      expect(found / lead.length).toBeGreaterThanOrEqual(0.8);
      expect(lenOk / lead.length).toBeGreaterThanOrEqual(0.8);
      const t = r.tempo.chosen;
      expect(chordPerBar(r.playedChords ?? [], t?.bpm ?? bpm, (t?.firstBeatMs ?? 0) / 1000, 4).map((c) => c.replace('7', ''))).toEqual(['E', 'Am', 'G', 'E']);
    });
  }
});

/** Add string-squeak-like bursts: a fast inharmonic chirp cluster with noise, ~120 ms. */
function addSqueaks(x: Float32Array, times: number[], sr = SR, level = 0.25): Float32Array {
  const out = x.slice();
  let seed = 11;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const t of times) {
    const a = Math.round(t * sr);
    const len = Math.round(0.12 * sr);
    const partials = Array.from({ length: 7 }, () => ({ f: 900 + rnd() * 3200, glide: 1 + rnd() * 0.6, ph: 0 }));
    for (let i = 0; i < len && a + i < out.length; i++) {
      const env = Math.sin((Math.PI * i) / len);
      let s = 0;
      for (const p of partials) {
        p.ph += (2 * Math.PI * p.f * (1 + (p.glide - 1) * (i / len))) / sr;
        s += Math.sin(p.ph);
      }
      out[a + i] += level * env * (s / partials.length + 0.6 * (rnd() * 2 - 1));
    }
  }
  return out;
}

describe('noise robustness', () => {
  it('string squeaks between strums do not create chords or notes', () => {
    const prog = [
      [50, 57, 62, 65], // Dm
      [45, 52, 55, 61, 64], // A7
      [43, 50, 55, 58, 62], // Gm
      [45, 52, 55, 61, 64], // A7
      [50, 57, 62, 65], // Dm
    ];
    const bpm = 92;
    const beat = 60 / bpm;
    // Strum on beats 1 and 3, squeak (chord change slide) just before each new bar.
    const clean = synthInstrument(bars(prog, [0, 2], 2), { bpm, strumSec: 0.012, decaySec: 0.9, inharmonicity: 0.00005 });
    const squeakTimes = [1, 2, 3, 4].map((b) => 0.5 + b * 4 * beat - 0.18);
    const x = addSqueaks(clean, squeakTimes);
    const r = analyze(x, SR);
    expect(r.input?.source).toBe('chords');
    const t = r.tempo.chosen;
    expect(chordPerBar(r.playedChords ?? [], t?.bpm ?? bpm, (t?.firstBeatMs ?? 0) / 1000, 5)).toEqual(['Dm', 'A7', 'Gm', 'A7', 'Dm']);
    // No notes born inside the squeaks.
    const inSqueak = r.notes.filter((n) => squeakTimes.some((s) => n.start > s - 0.02 && n.start < s + 0.1));
    expect(inSqueak.length).toBeLessThanOrEqual(1);
    // No extra chord changes caused by squeaks.
    expect((r.playedChords ?? []).length).toBe(5);
  });
});

describe('single-line instrument and voice stay in melody mode', () => {
  it('plucked melody with repeated notes: every pluck is a note', () => {
    const seq = [64, 64, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60];
    const ev: InstrumentEvent[] = seq.map((m, i) => ({ midis: [m], at: i, beats: 1 }));
    const x = synthInstrument(ev, { bpm: 110, decaySec: 0.7 });
    const r = analyze(x, SR);
    expect(r.input?.source).toBe('melody');
    expect(r.notes.map((nn) => nn.midi)).toEqual(seq);
    expect(Math.abs((r.tempo.chosen?.bpm ?? 0) - 110)).toBeLessThanOrEqual(2);
  });

  for (const name of Object.keys(TEST_MELODIES)) {
    it(`sung ${name} is detected as melody`, () => {
      const mel = TEST_MELODIES[name];
      const x = synthMelody(mel.notes, { bpm: 100, harmonics: [1, 0.6, 0.35, 0.2], vibratoCents: 35, scoopCents: -120, scoopSec: 0.08 });
      const r = analyze(x, SR);
      expect(r.input?.source).toBe('melody');
      expect(r.notes.map((nn) => nn.midi)).toEqual(mel.notes.map((nn) => nn.midi));
    });
  }
});
