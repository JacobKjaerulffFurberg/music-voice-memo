import { describe, expect, it } from 'vitest';
import { foldOntoLoop, roughLevel } from '../src/music/layers';

const SR = 1000;

describe('layers: singing over a loop', () => {
  it('puts what was sung where the band was', () => {
    // A 2 s loop; 0.5 s sung starting 0.75 s into it.
    const x = new Float32Array(500).fill(1);
    const out = foldOntoLoop(x, SR, 0.75, 2);
    expect(out.length).toBe(2000);
    expect(out[700]).toBe(0);
    expect(out[1000]).toBe(1);
    expect(out[1300]).toBe(0);
    // Faded in and out, no click.
    expect(out[750]).toBe(0);
    expect(out[755]).toBeLessThan(1);
    expect(out[1249]).toBe(0);
  });

  it('wraps round the loop and stacks the passes', () => {
    // 3 s sung over a 2 s loop from 1.5 s in: the middle second is sung twice.
    const x = new Float32Array(3000).fill(0.5);
    const out = foldOntoLoop(x, SR, 1.5, 2);
    // Pass 1 covers 1.5–2.0, pass 2 the whole loop, pass 3 covers 0–0.5.
    expect(out[250]).toBeCloseTo(1); // passes 2 and 3
    expect(out[1000]).toBeCloseTo(0.5); // pass 2 only
    expect(out[1750]).toBeCloseTo(1); // passes 1 and 2
  });

  it('takes a start before the loop (latency, pre-roll) as the end of the pass before', () => {
    const x = new Float32Array(400).fill(1);
    const out = foldOntoLoop(x, SR, -0.2, 2);
    expect(out[1900]).toBe(1);
    expect(out[100]).toBe(1);
    expect(out[300]).toBe(0);
  });

  it('measures how loud a take is', () => {
    expect(roughLevel(new Float32Array(100))).toBe(0);
    expect(roughLevel(new Float32Array(100).fill(0.5))).toBeCloseTo(0.5);
    const x = new Float32Array(200);
    x.fill(0.5, 100);
    expect(roughLevel(x, 100)).toBeCloseTo(0.5);
  });
});
