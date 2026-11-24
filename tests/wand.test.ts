import { describe, expect, it } from 'vitest';
import { keyChoices } from '../src/music/wand';
import type { Note } from '../src/analysis/types';

const tune = (midis: number[], dur = 0.5): Note[] =>
  midis.map((midi, i) => ({ midi, start: i * dur, duration: dur, hz: 440 * Math.pow(2, (midi - 69) / 12), velocity: 0.7 }) as Note);

describe('wand keys', () => {
  it('starts with the heard key and offers the other homes for the same notes', () => {
    // G A B D E, ending on G: no C, no F/F#, so G major, E minor, C major, A minor, D major all fit.
    const ks = keyChoices(tune([67, 69, 71, 74, 76, 74, 71, 67]), { tonic: 7, mode: 'major' });
    const names = ks.map((k) => `${k.tonic} ${k.mode}`);
    expect(names[0]).toBe('7 major'); // heard key first
    expect(names).toContain('4 minor'); // E minor
    expect(names).toContain('9 minor'); // A minor
    expect(ks.length).toBeGreaterThanOrEqual(3);
    expect(ks.length).toBeLessThanOrEqual(5);
  });

  it('leaves out keys that clash with sung notes', () => {
    // C major scale with a clear F and B: G major (F#) must not be offered.
    const ks = keyChoices(tune([60, 62, 64, 65, 67, 69, 71, 72, 65, 60]), { tonic: 0, mode: 'major' });
    expect(ks.some((k) => k.tonic === 7 && k.mode === 'major')).toBe(false);
    expect(ks.some((k) => k.tonic === 9 && k.mode === 'minor')).toBe(true); // A minor: same notes
  });

  it('always has somewhere to go', () => {
    const ks = keyChoices([], { tonic: 2, mode: 'minor' });
    expect(ks).toEqual([
      { tonic: 2, mode: 'minor' },
      { tonic: 5, mode: 'major' },
    ]);
  });
});
