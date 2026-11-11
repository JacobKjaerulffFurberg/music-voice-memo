import { describe, expect, it } from 'vitest';
import { encodeMidi, keySignatureFifths, noteTicks } from '../src/export/midi';
import { decodeWav, encodeWav } from '../src/export/wav';
import type { Note } from '../src/analysis/types';

const note = (midi: number, start: number, duration: number): Note => ({ midi, start, duration, cents: 0, hz: 0, level: 0.1 });

describe('wav', () => {
  it.each([16, 24, 32] as const)('round-trips %s-bit at 48 kHz', (bits) => {
    const x = new Float32Array(1000).map((_, i) => 0.8 * Math.sin(i / 7));
    const back = decodeWav(encodeWav(x, 48000, bits).buffer as ArrayBuffer);
    expect(back.sampleRate).toBe(48000);
    expect(back.samples.length).toBe(1000);
    const tol = bits === 16 ? 1e-4 : 1e-6;
    for (let i = 0; i < x.length; i += 97) expect(Math.abs(back.samples[i] - x[i])).toBeLessThan(tol);
  });
});

describe('midi', () => {
  it('writes a valid header, tempo and notes', () => {
    const bytes = encodeMidi([note(60, 0.5, 0.4), note(62, 1.0, 0.4)], { bpm: 120, firstBeatSec: 0.5, key: { tonic: 2, mode: 'major' } });
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    expect(String.fromCharCode(...bytes.slice(14, 18))).toBe('MTrk');
    // Tempo meta FF 51 03 07 A1 20 = 500000 µs per quarter.
    const s = Array.from(bytes).join(',');
    expect(s).toContain([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20].join(','));
    // Key signature D major = 2 sharps.
    expect(s).toContain([0xff, 0x59, 0x02, 2, 0].join(','));
  });

  it('aligns the first downbeat to tick 0 and shifts pickups into a leading bar', () => {
    const o = { bpm: 100, firstBeatSec: 1.0, ppq: 480, beatsPerBar: 4, quantize: 0, key: null, trackName: 't' };
    const t = noteTicks([note(60, 1.0, 0.3), note(62, 1.6, 0.3)], o);
    expect(t[0].on).toBe(0);
    expect(t[1].on).toBe(480);
    const p = noteTicks([note(59, 0.4, 0.3), note(60, 1.0, 0.3)], o);
    expect(p[1].on).toBe(1920); // bar 2 beat 1
    expect(p[0].on).toBe(1920 - 480);
  });

  it('quantizes to 1/16', () => {
    const o = { bpm: 120, firstBeatSec: 0, ppq: 480, beatsPerBar: 4, quantize: 4, key: null, trackName: 't' };
    const t = noteTicks([note(60, 0.51, 0.24)], o);
    expect(t[0].on).toBe(480);
    expect(t[0].off).toBe(720);
  });

  it('writes format 1 with chord, bass and drum tracks when backing is given', () => {
    const chords = [{ start: 0.5, duration: 2, root: 0, quality: 'maj' as const, name: 'C', numeral: 'I', voicing: [60, 64, 67], bass: 36 }];
    const drums = [{ time: 0.5, kind: 'kick' as const, velocity: 1 }];
    const bytes = encodeMidi([note(60, 0.5, 0.4)], { bpm: 120, firstBeatSec: 0.5 }, { chords, drums });
    expect(bytes[9]).toBe(1); // format 1
    expect(bytes[11]).toBe(4); // melody, chords, bass, drums
    const s = Array.from(bytes).join(',');
    expect(s).toContain([0x99, 36].join(',')); // kick on channel 10
    expect(s).toContain([0x91, 64, 70].join(',')); // chord tone on channel 2
  });

  it('key signature fifths', () => {
    expect(keySignatureFifths(0, 'major')).toBe(0);
    expect(keySignatureFifths(9, 'minor')).toBe(0);
    expect(keySignatureFifths(4, 'minor')).toBe(1);
    expect(keySignatureFifths(5, 'major')).toBe(-1);
    expect(keySignatureFifths(3, 'minor')).toBe(-6);
  });
});
