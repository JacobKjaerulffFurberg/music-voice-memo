import { describe, expect, it } from 'vitest';
import { barStarts, chordTones, drumHits, suggestChords, voiceChord } from '../src/music/arrange';
import type { Note } from '../src/analysis/types';

const g = { bpm: 120, firstBeatSec: 0.5, beatsPerBar: 4, durationSec: 8.5 };
const n = (midi: number, beat: number, beats = 1): Note => ({
  midi,
  start: 0.5 + beat * 0.5,
  duration: beats * 0.5 - 0.05,
  cents: 0,
  hz: 0,
  level: 0.1,
});

describe('grid & drums', () => {
  it('lays bars from the first downbeat', () => {
    expect(barStarts(g)).toEqual([0.5, 2.5, 4.5, 6.5]);
  });

  it('rock pattern: kick on 1, snare on 2 and 4', () => {
    const hits = drumHits('rock', g);
    const firstBar = hits.filter((h) => h.time < 2.5);
    expect(firstBar.filter((h) => h.kind === 'kick').map((h) => h.time)[0]).toBeCloseTo(0.5);
    expect(firstBar.filter((h) => h.kind === 'snare').map((h) => h.time)).toEqual([1.0, 2.0]);
    expect(firstBar.filter((h) => h.kind === 'hat')).toHaveLength(8);
    expect(drumHits('off', g)).toEqual([]);
  });
});

describe('chords', () => {
  it('harmonizes a C major melody with I – IV – V – I', () => {
    const notes = [
      // bar 1: C E G E  → C
      n(60, 0), n(64, 1), n(67, 2), n(64, 3),
      // bar 2: F A C A  → F
      n(65, 4), n(69, 5), n(72, 6), n(69, 7),
      // bar 3: G B D B  → G
      n(67, 8), n(71, 9), n(74, 10), n(71, 11),
      // bar 4: C (long) → C
      n(72, 12, 4),
    ];
    const chords = suggestChords(notes, { tonic: 0, mode: 'major' }, g);
    expect(chords.map((c) => c.name)).toEqual(['C', 'F', 'G', 'C']);
    expect(chords.map((c) => c.numeral)).toEqual(['I', 'IV', 'V', 'I']);
  });

  it('uses minor-key chords (Am, Dm, E) in A minor', () => {
    const notes = [n(69, 0, 2), n(72, 2, 2), n(74, 4, 2), n(65, 6, 2), n(68, 8, 2), n(71, 10, 2), n(69, 12, 4)];
    const chords = suggestChords(notes, { tonic: 9, mode: 'minor' }, g);
    expect(chords.map((c) => c.name)).toEqual(['Am', 'Dm', 'E', 'Am']);
  });

  it('D minor: a sung C# (raised 7th) gets the dominant A, not Dm', () => {
    const Dm = { tonic: 2, mode: 'minor' as const };
    const notes = [
      // bar 1: D F A F → Dm
      n(62, 0), n(65, 1), n(69, 2), n(65, 3),
      // bar 2: E C# E A → A (the C# is the giveaway)
      n(64, 4), n(61, 5), n(64, 6), n(69, 7),
      // bar 3: D (long) → Dm
      n(62, 8, 4),
    ];
    const chords = suggestChords(notes, Dm, { ...g, durationSec: 6.5 });
    expect(chords.map((c) => c.name)).toEqual(['Dm', 'A', 'Dm']);
  });

  it('D minor: C# on a weak beat next to D still pulls to the dominant', () => {
    const Dm = { tonic: 2, mode: 'minor' as const };
    // bar 1: F E D C# … bar 2: D
    const notes = [n(65, 0), n(64, 1), n(62, 2), n(61, 3), n(62, 4, 4)];
    const chords = suggestChords(notes, Dm, { ...g, durationSec: 4.5 }, { chordsPerBar: 'auto' });
    expect(chords.map((c) => c.name)).toEqual(['Dm', 'A', 'Dm']);
  });

  it('sung 7th of the dominant gives V7', () => {
    const Dm = { tonic: 2, mode: 'minor' as const };
    // bar 1: D A F D; bar 2: C# E G E (A7); bar 3: D
    const notes = [n(62, 0), n(69, 1), n(65, 2), n(62, 3), n(61, 4), n(64, 5), n(67, 6), n(64, 7), n(62, 8, 4)];
    const chords = suggestChords(notes, Dm, { ...g, durationSec: 6.5 });
    expect(chords.map((c) => c.name)).toEqual(['Dm', 'A7', 'Dm']);
    expect(new Set(chords[1].voicing.map((m) => m % 12))).toEqual(new Set([9, 1, 4, 7]));
  });

  it('auto splits a bar when the harmony clearly changes halfway', () => {
    // C major, bar 1: C E | F A, bar 2: G B D B, bar 3: C
    const notes = [n(60, 0), n(64, 1), n(65, 2), n(69, 3), n(67, 4), n(71, 5), n(74, 6), n(71, 7), n(72, 8, 4)];
    const chords = suggestChords(notes, { tonic: 0, mode: 'major' }, { ...g, durationSec: 6.5 }, { chordsPerBar: 'auto' });
    expect(chords.map((c) => c.name)).toEqual(['C', 'F', 'G', 'C']);
    const one = suggestChords(notes, { tonic: 0, mode: 'major' }, { ...g, durationSec: 6.5 }, { chordsPerBar: 1 });
    expect(one).toHaveLength(3);
  });

  it('voicings contain the chord tones and move smoothly', () => {
    const c = voiceChord(0, 'maj', null);
    expect(new Set(c.map((m) => m % 12))).toEqual(new Set(chordTones(0, 'maj')));
    const f = voiceChord(5, 'maj', c);
    const moved = f.reduce((s, m, i) => s + Math.abs(m - c[i]), 0);
    expect(moved).toBeLessThanOrEqual(4); // C E G → C F A
  });

  it('two chords per bar doubles the segments', () => {
    expect(suggestChords([n(60, 0)], { tonic: 0, mode: 'major' }, g, { chordsPerBar: 2 })).toHaveLength(8);
  });
});
