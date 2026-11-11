import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/pipeline';
import { applyIntent, DEFAULT_INTENT } from '../src/analysis/intent';
import { assignVelocities } from '../src/analysis/velocity';
import { encodeMidi } from '../src/export/midi';
import { synthInstrument } from '../src/analysis/synth';
import type { Note } from '../src/analysis/types';

const n = (midi: number, level: number): Note => ({ midi, start: midi / 10, duration: 0.3, cents: 0, hz: 0, level });

describe('velocity', () => {
  it('maps loudness to 1–127 relative to the take', () => {
    const v = assignVelocities([n(60, 1), n(62, 0.9), n(64, 0.5), n(65, 0.08), n(67, 1)]).map((x) => x.velocity ?? 0);
    expect(v[0]).toBe(127);
    expect(v[2]).toBeGreaterThan(50);
    expect(v[2]).toBeLessThan(100);
    expect(v[3]).toBeLessThan(25);
  });

  it('min-velocity interpretation removes faint notes only', () => {
    const notes = assignVelocities([n(60, 1), n(72, 0.05), n(64, 0.8)]);
    const kept = applyIntent(notes, { key: null, bpm: 120, firstBeatSec: 0 }, { ...DEFAULT_INTENT, quantizeGrid: 0, fitToKey: false, minVelocity: 30 });
    expect(kept.map((x) => x.midi)).toEqual([60, 64]);
  });

  it('MIDI export writes the note velocity', () => {
    const notes = [{ ...n(60, 1), velocity: 37, start: 0 }];
    const bytes = Array.from(encodeMidi(notes, { bpm: 120, firstBeatSec: 0 }));
    const i = bytes.indexOf(0x90);
    expect(bytes.slice(i, i + 3)).toEqual([0x90, 60, 37]);
  });

  it('a quiet note under a loud chord gets a lower velocity than the chord', () => {
    const x = synthInstrument(
      [
        { midis: [48, 55, 60, 64], at: 0, beats: 4 },
        { midis: [81], at: 1, beats: 1, gain: 0.35 },
      ],
      { bpm: 100 },
    );
    const r = analyze(x, 44100, {}, { source: 'chords' });
    const chordVel = Math.max(...r.notes.filter((x2) => [48, 55, 60, 64].includes(x2.midi)).map((x2) => x2.velocity ?? 0));
    const quiet = r.notes.find((x2) => x2.midi === 81);
    expect(quiet).toBeDefined();
    expect(quiet?.velocity ?? 127).toBeLessThan(chordVel);
  });
});
