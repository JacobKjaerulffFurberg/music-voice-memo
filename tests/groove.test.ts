import { describe, expect, it } from 'vitest';
import type { Chord } from '../src/music/arrange';
import { CLAVE, genreOf, grooveDrums, grooveTempo, latinDrums, montuno, VIBES, vibeOf } from '../src/music/groove';
import { lofiDrums } from '../src/music/lofi';

const chord = (start: number, duration: number, root: number, voicing: number[]): Chord => ({
  start,
  duration,
  root,
  quality: 'maj',
  name: '',
  numeral: '',
  voicing,
  bass: 36 + root,
});

describe('groove: genres and vibes', () => {
  it('defaults to lo-fi and keeps lo-fi exactly as it was', () => {
    expect(genreOf(null)).toBe('lofi');
    expect(genreOf({ genre: 'latin' })).toBe('latin');
    expect(grooveTempo('lofi', 149)).toBe(74.5);
    expect(grooveDrums('lofi', 80, 0, 12, 2)).toEqual(lofiDrums(80, 0, 12, 2));
  });

  it('counts latin at 56–112, the pulse of the take', () => {
    expect(grooveTempo('latin', 90)).toBe(90);
    expect(grooveTempo('latin', 180)).toBe(90);
    expect(grooveTempo('latin', 120)).toBe(60);
    expect(grooveTempo('latin', 50)).toBe(100);
  });

  it('every vibe is a full preset with a known genre', () => {
    expect(VIBES.map((v) => v.id)).toEqual(['cool', 'hot', 'dark']);
    expect(vibeOf({ vibe: 'hot' })?.genre).toBe('latin');
    expect(vibeOf({})).toBeNull();
  });
});

describe('groove: latin percussion', () => {
  it('plays the 3-2 son clave, straight, every bar', () => {
    // 120 BPM: bar 2 s, 16th 0.125 s.
    const claves = latinDrums(120, 0, 4, 1)
      .filter((h) => h.kind === 'clave')
      .map((h) => h.time);
    const one = CLAVE.map((s) => s * 0.125);
    expect(claves).toEqual([...one, ...one.map((t) => t + 2)]);
  });

  it('has three feels and stays inside the span', () => {
    const count = (feel: number): number => latinDrums(100, 0.3, 9.6, feel).length;
    expect(count(0)).toBeLessThan(count(1) / 1.5);
    expect(count(2)).toBeGreaterThan(count(1) * 1.2);
    const all = latinDrums(100, 0.3, 9.6, 2);
    expect(all.every((h) => h.time >= 0 && h.time < 9.6)).toBe(true);
    expect(latinDrums(100, 0.3, 9.6, 0).every((h) => ['kick', 'clave', 'conga', 'slap'].includes(h.kind))).toBe(true);
    // The singer's pulse is always stated: a kick on 1 and 3, and a bell on every beat from the normal feel.
    const one = latinDrums(120, 0, 2, 1);
    expect(one.filter((h) => h.kind === 'kick').map((h) => h.time)).toEqual([0, 1]);
    expect(one.filter((h) => h.kind === 'cowbell').map((h) => h.time)).toEqual([0, 0.5, 1, 1.5]);
    expect(all.some((h) => h.kind === 'cowbell')).toBe(true);
  });
});

describe('groove: montuno', () => {
  // 120 BPM: bar 2 s, 16th 0.125 s. C for a bar, then F for a bar.
  const chords = [chord(0, 2, 0, [60, 64, 67]), chord(2, 2, 5, [60, 65, 69])];
  const notes = montuno(chords, 120, 0, 4, 1);
  const piano = notes.filter((n) => !n.bass);
  const bass = notes.filter((n) => n.bass);

  it('plays beat 1, beat 2, then the off-beats, as short stabs', () => {
    const steps = [...new Set(piano.filter((n) => n.start < 2 - 1e-6).map((n) => Math.round(n.start / 0.125)))];
    expect(steps).toEqual([0, 2, 3, 5, 7, 9, 11, 13, 15]);
    expect(piano.every((n) => n.duration < 0.125)).toBe(true);
    // Octaves on the outside.
    const first = piano.filter((n) => n.start === 0).map((n) => n.midi);
    expect(first).toEqual([60, 72]);
  });

  it('lands the harmony with the singer, and only the busy feel reaches ahead', () => {
    const pcs = (t: number): number[] => piano.filter((n) => Math.abs(n.start - t) < 1e-6).map((n) => n.midi % 12);
    expect(pcs(2 + 2 * 0.125).sort()).toEqual([5, 9]); // inside of F on beat 2 of bar 2
    expect(pcs(2 * 0.125).sort()).toEqual([4, 7]); // inside of C on beat 2 of bar 1
    const at = (list: typeof bass, step: number): number | undefined => list.find((n) => Math.abs(n.start - step * 0.125) < 1e-6)?.midi;
    // Bass: root on 1 and 3, fifth on 2-and, root on 4; F arrives on bar 2, not before.
    expect(at(bass, 0)).toBe(36);
    expect(at(bass, 3)).toBe(43);
    expect(at(bass, 8)).toBe(36);
    expect(at(bass, 14)).toBe(36);
    expect(at(bass, 16)).toBe(41);
    // Busy: the tumbao, with F's root already on beat 4 of bar 1.
    const busy = montuno(chords, 120, 0, 4, 2).filter((n) => n.bass);
    expect(at(busy, 14)).toBe(41);
    expect(at(busy, 16)).toBeUndefined();
  });

  it('has a sparse and a busy way, and nothing without chords', () => {
    expect(montuno(chords, 120, 0, 4, 0).length).toBeLessThan(notes.length);
    expect(montuno(chords, 120, 0, 4, 2).length).toBeGreaterThan(notes.length);
    expect(montuno([], 120, 0, 4)).toEqual([]);
    expect(notes.every((n) => n.start >= 0 && n.start < 4)).toBe(true);
  });
});
