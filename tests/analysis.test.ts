import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/pipeline';
import { trackPitchYin } from '../src/analysis/pitch';
import { estimateTuning, tuningFromDeviations } from '../src/analysis/tuning';
import { segmentNotes } from '../src/analysis/notes';
import { estimateKeyFromNotes } from '../src/analysis/key';
import { tempoFromOnsets } from '../src/analysis/tempo';
import { synthMelody, TEST_MELODIES } from '../src/analysis/synth';
import { foldBpm, hzToMidi } from '../src/analysis/music';

const SR = 44100;

function centsDiff(a: number, b: number): number {
  const d = (((a - b + 50) % 100) + 100) % 100 - 50;
  return Math.abs(d);
}

describe('pitch (YIN)', () => {
  it.each([110, 220, 440, 659.26])('tracks a steady %s Hz sine within 3 cents', (hz) => {
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
    const track = trackPitchYin(x, SR);
    const voiced = Array.from(track.f0Hz).filter((f) => f > 0);
    expect(voiced.length).toBeGreaterThan(track.f0Hz.length * 0.9);
    const med = voiced.sort((a, b) => a - b)[voiced.length >> 1];
    expect(Math.abs(1200 * Math.log2(med / hz))).toBeLessThan(3);
  });

  it('works at 48 kHz too', () => {
    const x = synthMelody(TEST_MELODIES['D major'].notes, { sampleRate: 48000, bpm: 100 });
    const track = trackPitchYin(x, 48000);
    expect(track.f0Hz.some((f) => f > 0)).toBe(true);
  });
});

describe('tuning', () => {
  it('handles wrap-around near ±50 cents', () => {
    const r = tuningFromDeviations([48, 49, -49, -48, 50, -50, 47]);
    expect(Math.abs(Math.abs(r.cents) - 49)).toBeLessThan(2.5);
  });

  it.each([-30, -12, 0, 17, 30])('detects %s cents detune within ±5', (detune) => {
    const x = synthMelody(TEST_MELODIES['D major'].notes, { detuneCents: detune, bpm: 110, harmonics: [1, 0.5, 0.25] });
    const t = estimateTuning(trackPitchYin(x, SR));
    expect(centsDiff(t.cents, detune)).toBeLessThanOrEqual(5);
    expect(t.a4Hz).toBeCloseTo(440 * Math.pow(2, t.cents / 1200), 6);
  });
});

describe('notes', () => {
  it('segments a melody into the right quantised pitches', () => {
    const mel = TEST_MELODIES['E minor'];
    const x = synthMelody(mel.notes, { detuneCents: -30, bpm: 100 });
    const track = trackPitchYin(x, SR);
    const tuning = estimateTuning(track);
    const notes = segmentNotes(track, tuning.cents);
    expect(notes.map((n) => n.midi)).toEqual(mel.notes.map((n) => n.midi));
    for (const n of notes) expect(Math.abs(n.cents)).toBeLessThan(10);
    // Onsets on the beat grid (100 BPM, start 0.5 s).
    expect(Math.abs(notes[0].start - 0.5)).toBeLessThan(0.03);
  });

  it('splits repeated same-pitch notes separated by short gaps', () => {
    const x = synthMelody(
      [60, 60, 60, 60, 62, 62, 64].map((midi) => ({ midi, beats: 1 })),
      { bpm: 120, gapSec: 0.06 },
    );
    const track = trackPitchYin(x, SR);
    const notes = segmentNotes(track, estimateTuning(track).cents);
    expect(notes.map((n) => n.midi)).toEqual([60, 60, 60, 60, 62, 62, 64]);
  });

  it('drops blips shorter than 80 ms', () => {
    const x = synthMelody(
      [
        { midi: 60, beats: 1 },
        { midi: 67, beats: 0.12 },
        { midi: 64, beats: 1 },
      ],
      { bpm: 120, gapSec: 0.0 },
    );
    const track = trackPitchYin(x, SR);
    const notes = segmentNotes(track, 0);
    expect(notes.map((n) => n.midi)).toEqual([60, 64]);
  });
});

describe('key (Krumhansl–Schmuckler)', () => {
  for (const [name, mel] of Object.entries(TEST_MELODIES)) {
    for (const detune of [-30, 30]) {
      it(`${name} detuned ${detune} c`, () => {
        const x = synthMelody(mel.notes, { detuneCents: detune, bpm: 105, harmonics: [1, 0.4] });
        const r = analyze(x, SR);
        expect(r.key.fromNotes?.tonic).toBe(mel.tonic);
        expect(r.key.fromNotes?.mode).toBe(mel.mode);
        expect(r.key.fromNotes?.candidates).toHaveLength(3);
        expect(centsDiff(r.tuning.cents, detune)).toBeLessThanOrEqual(5);
      });
    }
  }

  it('returns null with too few notes', () => {
    expect(estimateKeyFromNotes([])).toBeNull();
  });
});

describe('tempo', () => {
  it('folds BPM into 70–160', () => {
    expect(foldBpm(50)).toBe(100);
    expect(foldBpm(200)).toBe(100);
    expect(foldBpm(160)).toBe(80);
    expect(foldBpm(120)).toBe(120);
  });

  it('recovers tempo and phase from exact onsets', () => {
    const P = 60 / 93;
    const onsets = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 12].map((k) => ({ time: 0.37 + k * P, weight: 1 }));
    const r = tempoFromOnsets(onsets);
    expect(r).not.toBeNull();
    expect(Math.abs((r?.bpm ?? 0) - 93)).toBeLessThan(0.5);
    expect(Math.abs((r?.firstBeatMs ?? 0) - 370)).toBeLessThan(5);
  });

  for (const bpm of [78, 92, 100, 120, 135, 150]) {
    for (const [name, mel] of Object.entries(TEST_MELODIES).slice(0, 2)) {
      it(`${name} at ${bpm} BPM within ±2`, () => {
        const x = synthMelody(mel.notes, { bpm, detuneCents: bpm % 2 === 0 ? 30 : -30, harmonics: [1, 0.5, 0.3] });
        const r = analyze(x, SR);
        expect(r.tempo.chosen).not.toBeNull();
        expect(Math.abs((r.tempo.chosen?.bpm ?? 0) - bpm)).toBeLessThanOrEqual(2);
        // First downbeat close to the first note (0.5 s), allowing for onset detection latency.
        expect(Math.abs((r.tempo.chosen?.firstBeatMs ?? 0) - 500)).toBeLessThan(40);
      });
    }
  }

  it('folds a 180 BPM melody to 90', () => {
    const x = synthMelody(TEST_MELODIES['F major'].notes, { bpm: 180, gapSec: 0.03 });
    const r = analyze(x, SR);
    expect(Math.abs((r.tempo.chosen?.bpm ?? 0) - 90)).toBeLessThanOrEqual(2);
  });
});

describe('robustness', () => {
  it('handles vibrato without changing tuning or notes', () => {
    const mel = TEST_MELODIES['A minor'];
    const x = synthMelody(mel.notes, { bpm: 90, detuneCents: 20, vibratoCents: 25, harmonics: [1, 0.6, 0.3, 0.2], noise: 0.01 });
    const r = analyze(x, SR);
    expect(centsDiff(r.tuning.cents, 20)).toBeLessThanOrEqual(5);
    expect(r.notes.map((n) => n.midi)).toEqual(mel.notes.map((n) => n.midi));
  });

  it('silence produces an empty but valid result', () => {
    const r = analyze(new Float32Array(SR * 2), SR);
    expect(r.notes).toEqual([]);
    expect(r.tempo.chosen).toBeNull();
    expect(r.key.chosen).toBeNull();
    expect(Number.isFinite(hzToMidi(r.tuning.a4Hz))).toBe(true);
  });
});
