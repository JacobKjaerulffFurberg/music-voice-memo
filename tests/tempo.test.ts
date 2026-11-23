import { describe, expect, it } from 'vitest';
import { fitGridAtBpm, onsetsFromNotes, tempoFromNotes, tempoNearHint } from '../src/analysis/tempo';
import { evaluate, simTake } from './tempo-bench';

describe('tempo on simulated sung takes', () => {
  it('finds tempo, beat and bar 1 on 400 sloppy takes (with pickups, drift, missed notes)', () => {
    const r = evaluate((notes) => tempoFromNotes(notes), 400);
    expect(r.bpmOk).toBeGreaterThan(0.88);
    expect(r.bpmOk + r.octave).toBeGreaterThan(0.97);
    expect(r.beatOk).toBeGreaterThan(0.85);
    expect(r.barOk).toBeGreaterThan(0.72);
  });

  it('re-fits beat phase and bar 1 when the tempo is given', () => {
    let ok = 0;
    for (let i = 1; i <= 100; i++) {
      const t = simTake(i);
      const fb = fitGridAtBpm(onsetsFromNotes(t.notes), t.bpm);
      const P = 60 / t.bpm;
      const d = (fb! - t.downbeat) / P;
      if (Math.abs(d - Math.round(d)) * P < 0.06) ok++;
    }
    expect(ok).toBeGreaterThan(85);
  });

  it('a tapped tempo guides the reading: off by up to 7 % (or tapped in half time), the singing still sets it', () => {
    let ok = 0;
    let n = 0;
    for (let i = 1; i <= 100; i++) {
      const t = simTake(i);
      for (const tap of [t.bpm * 0.94, t.bpm * 1.07, t.bpm / 2]) {
        n++;
        const r = tempoNearHint(onsetsFromNotes(t.notes), tap);
        const want = tap < t.bpm * 0.7 ? t.bpm / 2 : t.bpm;
        if (Math.abs(r.bpm / want - 1) < 0.02) ok++;
      }
    }
    expect(ok / n).toBeGreaterThan(0.85);
  });
});
