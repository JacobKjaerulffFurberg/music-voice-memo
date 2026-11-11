import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/pipeline';
import { synthInstrument, synthMelody, type InstrumentEvent } from '../src/analysis/synth';

const SR = 44100;

// A picked line with steps, leaps and repeated notes.
const LINE = [64, 67, 69, 71, 72, 71, 69, 67, 64, 64, 62, 64, 67, 67, 69, 72, 74, 72, 71, 69, 67, 69, 71, 67, 64, 62, 60, 62, 64, 64, 67, 64];

function score(notes: { midi: number; start: number }[], seq: number[], step: number, start = 0.5, tol = 0.04) {
  let found = 0;
  seq.forEach((m, i) => {
    const t = start + i * step;
    if (notes.some((n) => n.midi === m && Math.abs(n.start - t) < tol)) found++;
  });
  return found / seq.length;
}

describe('fast single-note lines', () => {
  for (const [bpm, perBeat] of [
    [120, 2], // 4 notes / s
    [100, 4], // 6.7 notes / s
    [120, 4], // 8 notes / s
  ] as const) {
    it(`guitar, ${((bpm / 60) * perBeat).toFixed(1)} notes/s`, () => {
      const step = 60 / bpm / perBeat;
      const ev: InstrumentEvent[] = LINE.map((m, i) => ({ midis: [m], at: i / perBeat, beats: 1 / perBeat }));
      const x = synthInstrument(ev, { bpm, decaySec: 0.6, inharmonicity: 0.00005 });
      const r = analyze(x, SR);
      const s = score(r.notes, LINE, step);
      console.log(`guitar ${bpm}x${perBeat}: source ${r.input?.source}, ${r.notes.length} notes, hit ${(s * 100).toFixed(0)}%`);
      expect(r.input?.source).toBe('melody');
      expect(s).toBeGreaterThanOrEqual(0.9);
    });
  }

  it('fast lead (6.7 notes/s) over ringing chords, chords mode', () => {
    const bpm = 100;
    const chords = [
      [40, 47, 52, 56, 59, 64],
      [45, 52, 57, 60, 64],
      [43, 47, 50, 55, 59, 67],
      [40, 47, 52, 56, 59, 64],
    ];
    const lead = [...LINE, ...LINE].map((m) => m + 12);
    const ev: InstrumentEvent[] = [
      ...chords.map((midis, bar) => ({ midis, at: bar * 4, beats: 4, gain: 0.7 })),
      ...lead.map((m, i) => ({ midis: [m], at: i / 4, beats: 1 / 4, gain: 0.5 })),
    ];
    const x = synthInstrument(ev, { bpm, strumSec: 0.01, decaySec: 0.7, inharmonicity: 0.00005 });
    const r = analyze(x, SR, {}, { source: 'chords' });
    const s = score(r.notes, lead, 60 / bpm / 4);
    console.log(`lead16 over chords: ${r.notes.length} notes, hit ${(s * 100).toFixed(0)}%`);
    expect(s).toBeGreaterThanOrEqual(0.8);
  });

  it('let-ring arpeggio (notes overlapping) is treated as chords', () => {
    const ev: InstrumentEvent[] = LINE.map((m, i) => ({ midis: [m], at: i / 4, beats: 3 / 4 }));
    const r = analyze(synthInstrument(ev, { bpm: 120, decaySec: 0.6 }), SR);
    expect(r.input?.source).toBe('chords');
  });

  it('sung/hummed eighths at 140 BPM (4.7 notes/s)', () => {
    const notes = LINE.slice(0, 24).map((midi) => ({ midi, beats: 0.5 }));
    const x = synthMelody(notes, { bpm: 140, gapSec: 0.03, harmonics: [1, 0.6, 0.35, 0.2], vibratoCents: 20 });
    const r = analyze(x, SR);
    const s = score(r.notes, notes.map((n) => n.midi), 60 / 140 / 2, 0.5, 0.05);
    console.log(`voice 140x2: ${r.notes.length} notes, hit ${(s * 100).toFixed(0)}%`);
    expect(s).toBeGreaterThanOrEqual(0.9);
  });
});
