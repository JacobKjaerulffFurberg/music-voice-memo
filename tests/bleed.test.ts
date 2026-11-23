import { describe, expect, it } from 'vitest';
import { cancelBleed, findDelay } from '../src/audio/bleed';

const SR = 16000;
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A "song": a few chord tones and noisy drum hits. */
function song(sec: number): Float32Array {
  const r = rng(3);
  const x = new Float32Array(sec * SR);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = 0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 277 * t) + 0.1 * Math.sin(2 * Math.PI * 330 * t);
    const beat = t % 0.5;
    if (beat < 0.06) x[i] += (r() * 2 - 1) * 0.6 * Math.exp(-beat / 0.015);
  }
  return x;
}
/** A "voice": a gliding tone that comes and goes. */
function voice(n: number): Float32Array {
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (300 + 80 * Math.sin(t * 1.3))) / SR;
    x[i] = 0.25 * Math.sin(ph) * (Math.sin(t * 2.1) > -0.3 ? 1 : 0);
  }
  return x;
}
/** What the mic hears: the voice, plus the song late by `d` samples through a little room. */
function mic(ref: Float32Array, v: Float32Array, d: number, gain: number): Float32Array {
  const room = [1, 0, 0, 0.4, 0, -0.2, 0.15, 0, 0, 0.1];
  const x = new Float32Array(ref.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let k = 0; k < room.length; k++) {
      const j = i - d - k * 7;
      if (j >= 0) s += room[k] * ref[j];
    }
    x[i] = v[i] + gain * s;
  }
  return x;
}
const rms = (x: Float32Array, from = 0): number => {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length - from));
};

describe('song bleeding into a layer', () => {
  it('finds the phone round trip in the recording', () => {
    const ref = song(4);
    for (const ms of [40, 120, 260]) {
      const d = Math.round((ms / 1000) * SR);
      const got = findDelay(mic(ref, voice(ref.length), d, 0.5), ref, SR);
      expect(Math.abs(got.sec * 1000 - ms)).toBeLessThan(2);
      expect(got.strength).toBeGreaterThan(0.2);
    }
  });

  it('says when the song was not heard (headphones)', () => {
    const ref = song(4);
    expect(findDelay(voice(ref.length), ref, SR).strength).toBeLessThan(0.1);
  });

  it('takes most of the song out and leaves the voice', () => {
    const ref = song(6);
    const v = voice(ref.length);
    const d = Math.round(0.15 * SR);
    const x = mic(ref, v, d, 0.6);
    const found = findDelay(x, ref, SR);
    const clean = cancelBleed(x, ref, Math.round(found.sec * SR), 128);
    // After the filter has learned (first second), what is left besides the voice:
    const from = SR;
    const before = rms(x.map((s, i) => s - v[i]) as Float32Array, from);
    const after = rms(clean.map((s, i) => s - v[i]) as Float32Array, from);
    expect(20 * Math.log10(before / after)).toBeGreaterThan(12);
  });
});
