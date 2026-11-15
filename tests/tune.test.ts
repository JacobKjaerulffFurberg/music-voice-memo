import { describe, expect, it } from 'vitest';
import { shiftPitch, tuneRatio, tuneVoice } from '../src/music/tune';

const SR = 22050;

/** A voice-like tone: a fundamental and two overtones. */
function tone(hz: number, sec: number): Float32Array {
  const x = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = 0.5 * Math.sin(2 * Math.PI * hz * t) + 0.25 * Math.sin(4 * Math.PI * hz * t) + 0.12 * Math.sin(6 * Math.PI * hz * t);
  }
  return x;
}

/** Pitch of a steady tone by autocorrelation (Hz). */
function pitchOf(x: Float32Array, from: number, to: number): number {
  const a = Math.round(from * SR);
  const n = Math.round((to - from) * SR);
  let best = 0;
  let bestLag = 0;
  const score = (lag: number): number => {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += x[a + i] * x[a + i + lag];
    return s / (n - lag);
  };
  for (let lag = Math.floor(SR / 400); lag <= Math.ceil(SR / 120); lag++) {
    const s = score(lag);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  // Parabolic refinement between lags.
  const [l, c, r] = [score(bestLag - 1), score(bestLag), score(bestLag + 1)];
  return SR / (bestLag + (0.5 * (l - r)) / (l - 2 * c + r));
}

const cents = (hz: number, ref: number): number => 1200 * Math.log2(hz / ref);

describe('tune', () => {
  it('moves a note by the distance to its pitch, and leaves the rest alone', () => {
    const a3 = 220;
    // 40 cents flat of A3.
    expect(cents(tuneRatio({ start: 0, duration: 1, midi: 57, hz: 220 * Math.pow(2, -40 / 1200) }), 1)).toBeCloseTo(40, 5);
    expect(tuneRatio({ start: 0, duration: 1, midi: 57, hz: a3 })).toBe(1); // already there
    expect(tuneRatio({ start: 0, duration: 1, midi: 60, hz: a3 })).toBe(1); // three semitones off: not a slip
    expect(tuneRatio({ start: 0, duration: 1, midi: 57, hz: 0 })).toBe(1);
    // The take's own tuning offset is the target, not A440.
    expect(cents(tuneRatio({ start: 0, duration: 1, midi: 57, hz: a3 }, 20), 1)).toBeCloseTo(20, 5);
    // Half strength: half the way.
    expect(cents(tuneRatio({ start: 0, duration: 1, midi: 57, hz: a3 }, 40, 0.5), 1)).toBeCloseTo(20, 5);
  });

  it('shifts pitch without changing length', () => {
    const x = tone(220, 1);
    const up = shiftPitch(x, Math.pow(2, 50 / 1200), SR);
    expect(up.length).toBe(x.length);
    expect(cents(pitchOf(up, 0.3, 0.7), 220)).toBeGreaterThan(40);
    expect(cents(pitchOf(up, 0.3, 0.7), 220)).toBeLessThan(60);
  });

  it('pulls a flat note and a sharp note onto pitch, keeps timing and silence', () => {
    const flat = 220 * Math.pow(2, -35 / 1200);
    const sharp = 261.63 * Math.pow(2, 30 / 1200);
    const x = new Float32Array(Math.round(3 * SR));
    x.set(tone(flat, 1), Math.round(0.2 * SR));
    x.set(tone(sharp, 1), Math.round(1.6 * SR));
    const notes = [
      { start: 0.2, duration: 1, midi: 57, hz: flat },
      { start: 1.6, duration: 1, midi: 60, hz: sharp },
    ];
    const y = tuneVoice(x, SR, notes);
    expect(y.length).toBe(x.length);
    expect(Math.abs(cents(pitchOf(y, 0.5, 0.9), 220))).toBeLessThan(8);
    expect(Math.abs(cents(pitchOf(y, 1.9, 2.3), 261.63))).toBeLessThan(8);
    // Silence stays silent, and the input is not touched.
    expect(Math.max(...y.subarray(Math.round(2.8 * SR)).map(Math.abs))).toBeLessThan(1e-6);
    expect(cents(pitchOf(x, 0.5, 0.9), 220)).toBeLessThan(-25);
    // Notes already in tune: the very same audio back.
    const same = tuneVoice(x, SR, [{ start: 0.2, duration: 1, midi: 57, hz: 220 }]);
    expect(Array.from(same.subarray(0, 2000))).toEqual(Array.from(x.subarray(0, 2000)));
  });
});
