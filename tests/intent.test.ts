import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/pipeline';
import { applyIntent, fitToKey, legato, quantizeNotes } from '../src/analysis/intent';
import { synthMelody, TEST_MELODIES } from '../src/analysis/synth';
import type { Note } from '../src/analysis/types';

const SR = 44100;
const note = (midi: number, start: number, duration: number, cents = 0): Note => ({ midi, start, duration, cents, hz: 0, level: 0.1 });

/** A singer: scoops into notes, wobbles, is a bit early/late and a bit sharp/flat per note. */
const sloppy = {
  scoopCents: -120,
  scoopSec: 0.08,
  vibratoCents: 30,
  timingJitterSec: 0.035,
  pitchErrorCents: 18,
  detuneCents: 15,
  harmonics: [1, 0.6, 0.35, 0.2],
  noise: 0.006,
};

/** Worse: whole-tone scoops, notes run into each other, wide vibrato. */
const verySloppy = {
  ...sloppy,
  scoopCents: -200,
  scoopSec: 0.11,
  vibratoCents: 45,
  gapSec: 0.012,
  timingJitterSec: 0.045,
  pitchErrorCents: 25,
};

describe('detection on sloppy singing', () => {
  for (const [name, mel] of Object.entries(TEST_MELODIES)) {
    for (const seed of [1, 2, 3]) {
      it(`${name} (seed ${seed}): right notes despite scoops, wobble and timing`, () => {
        const bpm = 96 + seed * 8;
        const x = synthMelody(mel.notes, { ...sloppy, bpm, seed });
        const r = analyze(x, SR);
        expect(r.notes.map((n) => n.midi)).toEqual(mel.notes.map((n) => n.midi));
        expect(Math.abs((r.tempo.chosen?.bpm ?? 0) - bpm)).toBeLessThanOrEqual(2);
        expect(r.key.chosen?.tonic).toBe(mel.tonic);
        // Onsets include the scoop: the note starts when the singer starts, not after the glide.
        const beat = 60 / bpm;
        let t = 0.5;
        mel.notes.forEach((m, i) => {
          expect(Math.abs(r.notes[i].start - t)).toBeLessThan(0.06);
          t += m.beats * beat;
        });
      });
    }
  }
});

describe('detection on very sloppy singing', () => {
  for (const [name, mel] of Object.entries(TEST_MELODIES)) {
    for (const seed of [1, 2]) {
      it(`${name} (seed ${seed})`, () => {
        const bpm = 100 + seed * 6;
        const x = synthMelody(mel.notes, { ...verySloppy, bpm, seed });
        const r = analyze(x, SR);
        expect(r.notes.map((n) => n.midi)).toEqual(mel.notes.map((n) => n.midi));
        const beat = 60 / bpm;
        let t = 0.5;
        mel.notes.forEach((m, i) => {
          expect(Math.abs(r.notes[i].start - t)).toBeLessThan(0.07);
          t += m.beats * beat;
        });
      });
    }
  }
});

describe('intent: fit to key', () => {
  const D = { tonic: 2, mode: 'major' as const };
  it('moves an out-of-key note that leans toward an in-key neighbour', () => {
    // Sung 40 c above C4 (C is not in D major) → really meant C#4.
    const [n] = fitToKey([note(60, 0, 0.5, 40)], D);
    expect(n.midi).toBe(61);
    expect(Math.round(n.cents)).toBe(-60);
  });
  it('keeps a chromatic note that was sung in tune', () => {
    expect(fitToKey([note(60, 0, 0.5, 3)], D)[0].midi).toBe(60);
  });
  it('leaves in-key notes alone', () => {
    expect(fitToKey([note(62, 0, 0.5, 45)], D)[0].midi).toBe(62);
  });
});

describe('intent: quantize and legato', () => {
  const ctx = { key: null, bpm: 120, firstBeatSec: 0.5 };
  it('100% quantize snaps starts and ends to 1/16', () => {
    const q = quantizeNotes([note(60, 0.53, 0.22), note(62, 0.98, 0.5)], ctx, 4, 1);
    expect(q[0].start).toBeCloseTo(0.5, 6);
    expect(q[0].start + q[0].duration).toBeCloseTo(0.75, 6);
    expect(q[1].start).toBeCloseTo(1.0, 6);
  });
  it('partial strength moves part of the way', () => {
    const q = quantizeNotes([note(60, 0.54, 0.2)], ctx, 4, 0.5);
    expect(q[0].start).toBeCloseTo(0.52, 6);
  });
  it('two notes landing in the same slot are kept apart', () => {
    const q = quantizeNotes([note(60, 0.5, 0.05), note(62, 0.53, 0.2)], ctx, 4, 1);
    expect(q[1].start).toBeGreaterThan(q[0].start);
    expect(q[0].start + q[0].duration).toBeLessThanOrEqual(q[1].start + 1e-9);
  });
  it('chords stay together when quantized (polyphonic)', () => {
    const chord = [note(48, 0.52, 0.9), note(60, 0.51, 0.9), note(64, 0.53, 0.9), note(67, 0.5, 0.9)];
    const q = quantizeNotes(chord, { ...ctx, polyphonic: true }, 4, 1);
    for (const n of q) expect(n.start).toBeCloseTo(0.5, 6);
  });

  it('legato closes gaps up to a beat', () => {
    const l = legato([note(60, 0.5, 0.3), note(62, 1.0, 0.3), note(64, 3.0, 0.3)], 0.5);
    expect(l[0].start + l[0].duration).toBeCloseTo(1.0, 6);
    expect(l[1].duration).toBeCloseTo(0.3, 6);
  });
  it('full pipeline on sloppy singing lands on the grid', () => {
    const mel = TEST_MELODIES['E minor'];
    const x = synthMelody(mel.notes, { ...sloppy, bpm: 110, seed: 5 });
    const r = analyze(x, SR);
    const t = r.tempo.chosen;
    expect(t).not.toBeNull();
    const notes = applyIntent(r.notes, { key: r.key.chosen, bpm: t?.bpm ?? 0, firstBeatSec: (t?.firstBeatMs ?? 0) / 1000 }, {
      fitToKey: true,
      quantizeGrid: 4,
      quantizeStrength: 1,
      legato: false,
      minVelocity: 0,
    });
    const beat = 60 / (t?.bpm ?? 1);
    for (const n of notes) {
      const pos = (n.start - (t?.firstBeatMs ?? 0) / 1000) / beat;
      expect(Math.abs(pos - Math.round(pos))).toBeLessThan(0.02); // on a beat (melody is all quarters/halves)
    }
  });
});
