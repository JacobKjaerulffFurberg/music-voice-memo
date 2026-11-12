import { describe, expect, it } from 'vitest';
import { fitGridAtBpm, onsetsFromNotes, tempoFromNotes } from '../src/analysis/tempo';
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
});
