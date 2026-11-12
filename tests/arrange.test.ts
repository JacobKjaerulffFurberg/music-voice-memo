import { describe, expect, it } from 'vitest';
import { barStarts, chordChoices, chordTones, chromaChords, drumHits, flavours, floatChords, keysLift, revoice, spiceChords, suggestChords, voiceChord } from '../src/music/arrange';
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

describe('floaty chords', () => {
  it('moves chord changes onto nearby sung note starts and keeps chords contiguous', () => {
    const mk = (start: number, duration: number) => ({ start, duration, root: 0, quality: 'maj' as const, name: 'C', numeral: 'I', voicing: [60, 64, 67], bass: 48 });
    const chords = [mk(0.5, 2), mk(2.5, 2), mk(4.5, 2)];
    // Singer comes in a little early for bar 2 and late for bar 3.
    const notes = [n(60, 0), { ...n(62, 0), start: 2.38 }, { ...n(64, 0), start: 4.6 }];
    const f = floatChords(chords, notes, 0.25);
    expect(f[1].start).toBeCloseTo(2.38, 5);
    expect(f[2].start).toBeCloseTo(4.6, 5);
    expect(f[0].start + f[0].duration).toBeCloseTo(f[1].start, 5);
    expect(f[1].start + f[1].duration).toBeCloseTo(f[2].start, 5);
    expect(f[2].start + f[2].duration).toBeCloseTo(6.5, 5);
    // Nothing near enough: stays on the bar.
    expect(floatChords(chords, [n(60, 0)], 0.25)[1].start).toBe(2.5);
  });
});

describe('spice and chord choices', () => {
  const key = { tonic: 0, mode: 'major' as const };
  // C E G | F A C | G B D | C — melody on chord tones.
  const mel = [n(60, 0, 2), n(64, 2, 2), n(65, 4, 2), n(69, 6, 2), n(67, 8, 2), n(71, 10, 2), n(72, 12, 4)];
  const base = suggestChords(mel, key, g, { chordsPerBar: 1 });

  it('makes chords richer per level and keeps their function', () => {
    expect(base.map((c) => c.name)).toEqual(['C', 'F', 'G', 'C']);
    const l1 = spiceChords(base, mel, key, 1).map((c) => c.name);
    // Melody sits on the roots, so maj7 (a semitone under) gives way to 6.
    expect(l1).toEqual(['C6', 'F6', 'G7', 'C6']);
    const l2 = spiceChords(base, mel, key, 2).map((c) => c.name);
    expect(l2[2]).toBe('G9');
    // Every level sounds different from the one before.
    const l3 = spiceChords(base, mel, key, 3).map((c) => c.name);
    expect(new Set([base.map((c) => c.name).join(), l1.join(), l2.join(), l3.join()]).size).toBe(4);
    for (const level of [1, 2, 3]) {
      const sp = spiceChords(base, mel, key, level);
      sp.forEach((c, i) => expect(c.root).toBe(base[i].root));
    }
  });

  it('skips colours that rub against the melody', () => {
    // Melody holds E and G over C: maj7 (B) is fine here, but held C over it would rub.
    const ok = [n(64, 0, 2), n(67, 2, 2)];
    const c0 = suggestChords(ok, key, { ...g, durationSec: 2.5 }, { chordsPerBar: 1 });
    expect(spiceChords(c0, ok, key, 1)[0].name).toBe('Cmaj7');
    const rub = [n(60, 0, 1), n(72, 1, 1), n(72, 2, 2)];
    const c = suggestChords(rub, key, { ...g, durationSec: 2.5 }, { chordsPerBar: 1 });
    expect(spiceChords(c, rub, key, 1)[0].name).not.toBe('Cmaj7');
  });

  it('keeps chords the user picked', () => {
    const sp = spiceChords(base, mel, key, 2, new Set([0]));
    expect(sp[0].name).toBe('C');
  });

  it('offers the best-fitting chords first, plus borrowed ones', () => {
    const ch = chordChoices(mel, key, 2.5, 4.5); // the F bar
    expect(ch[0].name).toBe('F');
    expect(ch.map((c) => c.name)).toContain('Fm');
    expect(ch.map((c) => c.name)).toContain('Bb');
    expect(flavours(5, 'maj').map((c) => c.name)).toContain('Fmaj9');
  });

  it('voices the keys just above a low voice, never sky-high', () => {
    expect(keysLift([n(50, 0), n(52, 1), n(55, 2), n(62, 3)])).toBe(5); // centred around D3–G3
    expect(keysLift([n(57, 0), n(59, 1), n(60, 2), n(62, 3)])).toBe(3); // centred on B3: a little
    expect(keysLift([n(62, 0), n(64, 1), n(67, 2), n(55, 3)])).toBe(0); // centred on D4 or above
    expect(keysLift([])).toBe(0);
    const base = suggestChords([n(48, 0, 4)], { tonic: 0, mode: 'major' }, { ...g, durationSec: 2.5 });
    const [c] = revoice(base, 5);
    expect(Math.min(...c.voicing)).toBeGreaterThanOrEqual(55);
    expect(Math.max(...c.voicing)).toBeLessThanOrEqual(75);
    expect(c.bass).toBe(48);
    // Extended chords on every root stay at or below G#5 and above the voice.
    for (let root = 0; root < 12; root++) {
      for (const quality of ['min11', 'maj9', 'dom9sus4', 'six9'] as const) {
        const [x] = revoice([{ ...c, root, quality }], 5);
        expect(Math.max(...x.voicing)).toBeLessThanOrEqual(80);
        expect(Math.min(...x.voicing)).toBeGreaterThanOrEqual(55);
      }
    }
  });

  it('breaks out of the key more with each chromatic level', () => {
    const C = { tonic: 0, mode: 'major' as const };
    // C E G E | A C A F | D G B G | C: a plain C F G C tune.
    const mel = [n(60, 0), n(64, 1), n(67, 2), n(64, 3), n(69, 4), n(72, 5), n(69, 6), n(65, 7), n(62, 8), n(67, 9), n(71, 10), n(67, 11), n(60, 12, 4)];
    const plain = suggestChords(mel, C, g, { chordsPerBar: 1 });
    const scale = new Set([0, 2, 4, 5, 7, 9, 11]);
    const outside = (cs: typeof plain): number => cs.filter((c) => !chordTones(c.root, c.quality).every((pc) => scale.has(pc))).length;
    expect(outside(plain)).toBe(0);
    expect(chromaChords(plain, mel, C, 0)).toBe(plain);
    const counts = [1, 2, 3].map((lv) => outside(chromaChords(plain, mel, C, lv)));
    expect(counts[2]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThanOrEqual(counts[0]);
    expect(counts[2]).toBeGreaterThanOrEqual(counts[1]);
    const wild = chromaChords(plain, mel, C, 3);
    expect(wild[0].name).toBe(plain[0].name);
    expect(wild[wild.length - 1].name).toBe(plain[plain.length - 1].name);
    // Hand-picked chords are left alone.
    expect(chromaChords(plain, mel, C, 3, new Set([1, 2])).map((c) => c.name)).toEqual(plain.map((c) => c.name));
  });

  it('offers the augmented chord when the raised 5th is sung', () => {
    const D = { tonic: 2, mode: 'major' as const };
    // D F# A# D: the A# is outside D major and is the lifted 5th of D.
    const ch = chordChoices([n(62, 0), n(66, 1), n(70, 2), n(62, 3)], D, 0.5, 2.5);
    expect(ch.slice(0, 3).map((c) => c.name)).toContain('D+');
    expect(chordTones(2, 'aug')).toEqual([2, 6, 10]);
    expect(flavours(2, 'maj', true).map((c) => c.name)).toContain('D+');
    // Chosen automatically for the bar where the A# is sung, and kept when spiced.
    const mel = [n(62, 0), n(66, 1), n(69, 2), n(66, 3), n(62, 4), n(66, 5), n(70, 6, 2), n(71, 8, 2), n(74, 10, 2), n(62, 12, 4)];
    const auto = suggestChords(mel, D, g, { chordsPerBar: 1 });
    expect(auto.map((c) => c.name)).toEqual(['D', 'D+', 'G', 'D']);
    expect(spiceChords(auto, mel, D, 3)[1].name).toBe('D+');
    // Another outside note pulls in the borrowed chord that holds it: C natural in D major → C (bVII).
    const flat7 = [n(62, 0), n(66, 1), n(69, 2), n(66, 3), n(60, 4, 2), n(64, 6), n(67, 7), n(62, 8, 4)];
    expect(suggestChords(flat7, D, { ...g, durationSec: 6.5 }, { chordsPerBar: 1 }).map((c) => c.name)).toEqual(['D', 'C', 'D']);
    // Without the A#, it is not pushed.
    expect(chordChoices([n(62, 0), n(66, 1), n(69, 2)], D, 0.5, 2.5).map((c) => c.name)).not.toContain('D+');
  });

  it('voices rich chords in a playable range', () => {
    for (const c of revoice(spiceChords(base, mel, key, 3))) {
      expect(Math.min(...c.voicing)).toBeGreaterThanOrEqual(48);
      expect(Math.max(...c.voicing)).toBeLessThanOrEqual(76);
      expect(new Set(c.voicing.map((m) => m % 12)).size).toBe(c.voicing.length);
    }
  });
});
