import { describe, expect, it } from 'vitest';
import { alignToGrid, lofiDownbeat, lofiDrums, lofiTempo, stretch } from '../src/music/lofi';

const SR = 16000;

/** Sine "notes" at the given times; silence elsewhere. */
function sing(notes: { start: number; duration: number; hz: number }[], dur: number): Float32Array {
  const x = new Float32Array(Math.round(dur * SR));
  for (const n of notes) {
    const a = Math.round(n.start * SR);
    const len = Math.round(n.duration * SR);
    for (let i = 0; i < len && a + i < x.length; i++) {
      const env = Math.min(1, i / 160, (len - i) / 160);
      x[a + i] = 0.5 * env * Math.sin((2 * Math.PI * n.hz * i) / SR);
    }
  }
  return x;
}

/** Dominant frequency by counting upward zero crossings. */
function pitchOf(x: Float32Array): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 && x[i] > 0) n++;
  return (n * SR) / x.length;
}

/** First sample louder than a threshold, in seconds from `from`. */
function onsetAfter(x: Float32Array, from: number): number {
  for (let i = Math.round(from * SR); i < x.length; i++) if (Math.abs(x[i]) > 0.1) return i / SR;
  return -1;
}

describe('lo-fi: stretch', () => {
  it('changes length, not pitch', () => {
    const x = sing([{ start: 0, duration: 1, hz: 220 }], 1);
    for (const ratio of [0.93, 1.07]) {
      const y = stretch(x, ratio, SR);
      expect(y.length).toBe(Math.round(x.length * ratio));
      const mid = y.subarray(Math.round(0.2 * SR), Math.round(0.8 * SR));
      expect(Math.abs(pitchOf(mid) - 220)).toBeLessThan(4);
      // No holes: the middle stays at about the original level.
      let peak = 0;
      for (const v of mid) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(0.4);
      expect(peak).toBeLessThan(0.62);
    }
  });
});

describe('lo-fi: align to grid', () => {
  // 120 BPM, bar 1 at 0.5 s: eighth notes every 0.25 s.
  const bpm = 120;
  const first = 0.5;
  const onGrid = (t: number): number => Math.abs(((t - first) / 0.25) - Math.round((t - first) / 0.25)) * 0.25;

  it('slides a late phrase back onto the beat without touching its length', () => {
    // Phrase 1 on the grid; phrase 2 starts 90 ms late.
    const notes = [
      { start: 0.5, duration: 0.4, hz: 220 },
      { start: 2.09, duration: 0.4, hz: 247 },
    ];
    const w = alignToGrid(sing(notes, 3.2), SR, notes, bpm, first);
    expect(w.phrases).toHaveLength(2);
    expect(w.phrases.every((p) => Math.abs(p.ratio - 1) < 1e-9)).toBe(true);
    expect(onGrid(w.map(0.5))).toBeLessThan(0.002);
    expect(w.map(2.09)).toBeCloseTo(2.0, 2);
    // The audio really moved: the second note now starts at 2.0 s.
    expect(onsetAfter(w.samples, 1.2)).toBeCloseTo(2.0, 1);
  });

  it('stretches a dragging phrase so its notes land on the grid', () => {
    // Sung 5 % slow: notes 0.2625 s apart instead of 0.25.
    const notes = [0, 1, 2, 3, 4, 5].map((k) => ({ start: 0.5 + k * 0.2625, duration: 0.2, hz: 220 }));
    const w = alignToGrid(sing(notes, 2.6), SR, notes, bpm, first);
    expect(w.phrases[0].ratio).toBeLessThan(0.97);
    for (const n of notes) expect(onGrid(w.map(n.start))).toBeLessThan(0.02);
    // Before: the last note was 62 ms off the grid.
    expect(onGrid(notes[5].start)).toBeGreaterThan(0.05);
  });

  it('never overlaps phrases and keeps time moving forward', () => {
    const notes = [
      { start: 0.62, duration: 0.5, hz: 220 },
      { start: 1.5, duration: 0.5, hz: 247 },
      { start: 2.41, duration: 0.6, hz: 262 },
    ];
    const w = alignToGrid(sing(notes, 3.4), SR, notes, bpm, first);
    let prev = -Infinity;
    for (let t = 0; t <= 3.4; t += 0.05) {
      const m = w.map(t);
      expect(m).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = m;
    }
    let peak = 0;
    for (const v of w.samples) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(0.62); // two phrases summed would exceed this
  });

  it('leaves a take with no notes alone', () => {
    const x = new Float32Array(SR);
    const w = alignToGrid(x, SR, [], bpm, first);
    expect(w.samples).toBe(x);
    expect(w.map(0.4)).toBe(0.4);
  });
});

describe('lo-fi: drums', () => {
  it('always plays slow, on the same grid as the take', () => {
    expect(lofiTempo(149)).toBe(74.5);
    expect(lofiTempo(90)).toBe(90);
    expect(lofiTempo(200)).toBe(100);
    expect(lofiTempo(40)).toBe(80);
    // A take read as 160 BPM: drum downbeats fall on every second bar line of the take.
    const kicks = lofiDrums(lofiTempo(160), 0.5, 9)
      .filter((h) => h.kind === 'kick' && h.velocity === 1)
      .map((h) => h.time);
    expect(kicks).toEqual([0.5, 3.5, 6.5]);
  });

  it('starts its bar where the singing leans on the strong beats', () => {
    // Take read as 160 BPM (beat 0.375 s): drums at 80, so the drum bar is 8 take beats long.
    // Phrases open 2 take beats after the take's bar 1, and again a drum bar later.
    const phrase = (t: number) => [0, 1, 2, 3].map((k) => ({ start: t + k * 0.75, duration: 0.6 }));
    const notes = [...phrase(0.5 + 0.75), ...phrase(0.5 + 0.75 + 3)];
    expect(lofiDownbeat(notes, 160, 0.5)).toBeCloseTo(1.25, 6);
    // Singing that already opens on bar 1 leaves it there.
    expect(lofiDownbeat([...phrase(0.5), ...phrase(3.5)], 160, 0.5)).toBeCloseTo(0.5, 6);
    expect(lofiDownbeat([], 160, 0.5)).toBe(0.5);
  });

  it('has three feels: super chill, normal, busy', () => {
    const count = (feel: number): number => lofiDrums(80, 0, 12, feel).length; // four 3-second bars
    expect(count(0)).toBeLessThan(count(1) / 1.5);
    expect(count(2)).toBeGreaterThan(count(1) * 1.3);
    // Super chill: at most 7 hits a bar, one snare, and it sits on beat 3.
    const chill = lofiDrums(80, 0, 3, 0);
    expect(chill.length).toBeLessThanOrEqual(7);
    const snares = chill.filter((h) => h.kind === 'snare');
    expect(snares).toHaveLength(1);
    expect(snares[0].time).toBeGreaterThan(1.5);
    expect(snares[0].time).toBeLessThan(1.56);
    // The default is the normal beat.
    expect(lofiDrums(80, 0, 12)).toEqual(lofiDrums(80, 0, 12, 1));
  });

  it('lays a swung beat on the grid for the whole length', () => {
    const hits = lofiDrums(120, 0.5, 8.5);
    const kicks = hits.filter((h) => h.kind === 'kick' && h.velocity === 1).map((h) => h.time);
    expect(kicks).toEqual([0.5, 2.5, 4.5, 6.5]);
    // Snare a hair late on beats 2 and 4.
    const snares = hits.filter((h) => h.kind === 'snare' && h.time > 0.5 && h.time < 2.5).map((h) => h.time);
    expect(snares[0]).toBeGreaterThan(1.0);
    expect(snares[0]).toBeLessThan(1.03);
    expect(hits.every((h) => h.time >= 0 && h.time < 8.5)).toBe(true);
    expect(hits.some((h) => h.kind === 'hat')).toBe(true);
  });
});
