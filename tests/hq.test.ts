import { describe, expect, it } from 'vitest';
import { analyze, analyzeHighQuality } from '../src/analysis/pipeline';
import { cases, score } from './notes-bench';

describe('high-quality analysis', () => {
  it('finds the sung notes at least as well as the normal pass on echoey, wobbly takes', () => {
    const hard = cases(6, true);
    let normal = 0;
    let hq = 0;
    for (const c of hard) {
      normal += score(analyze(c.samples, 44100), c).f1;
      const r = analyzeHighQuality(c.samples, 44100);
      expect(r.quality).toBe('high');
      hq += score(r, c).f1;
    }
    expect(hq).toBeGreaterThanOrEqual(normal);
    expect(hq / hard.length).toBeGreaterThan(0.75);
  }, 120000);
});
