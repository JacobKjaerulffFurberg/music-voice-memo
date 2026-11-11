import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/pipeline';
import { synthMelody, TEST_MELODIES } from '../src/analysis/synth';
import { effectiveAnalysis } from '../src/model';

describe('edited notes', () => {
  const mel = TEST_MELODIES['D major'];
  const analysis = analyze(synthMelody(mel.notes, { bpm: 100 }), 44100);

  it('without edits, applies the interpretation pass (and nothing when it is all off)', () => {
    const off = { fitToKey: false, quantizeGrid: 0, quantizeStrength: 0, legato: false, minVelocity: 0 };
    expect(effectiveAnalysis({ analysis, intent: off })?.notes.map((n) => n.start)).toEqual(analysis.notes.map((n) => n.start));
    const q = effectiveAnalysis({ analysis, intent: { ...off, quantizeGrid: 4, quantizeStrength: 1 } });
    const t = analysis.tempo.chosen;
    const beat = 60 / (t?.bpm ?? 1);
    for (const n of q?.notes ?? []) {
      const pos = ((n.start - (t?.firstBeatMs ?? 0) / 1000) / beat) * 4;
      expect(Math.abs(pos - Math.round(pos))).toBeLessThan(1e-6);
    }
  });

  it('a tuning override re-reads which semitone each note is', () => {
    // Pretend the singer was actually 60 c flat of what was detected: every note moves down a semitone-ish.
    const t = analysis.tuning.cents;
    // Shift the reference by more than half a semitone so every (well-sung) note reads one semitone off.
    const eff = effectiveAnalysis({ analysis, overrides: { tuningCents: t - 60 }, intent: { fitToKey: false, quantizeGrid: 0, quantizeStrength: 0, legato: false, minVelocity: 0 } });
    expect(eff?.tuning.cents).not.toBe(t);
    const moved = eff?.notes.filter((n, i) => n.midi !== analysis.notes[i].midi).length ?? 0;
    expect(moved).toBe(analysis.notes.length);
  });

  it('swaps in edited notes and re-estimates the key from them', () => {
    // Transpose the whole melody up a whole tone → E major.
    const editedNotes = analysis.notes.map((n) => ({ ...n, midi: n.midi + 2 }));
    const eff = effectiveAnalysis({ analysis, editedNotes });
    expect(eff?.notes).toBe(editedNotes);
    expect(eff?.key.chosen?.name).toBe('E major');
    // Detected data is left alone.
    expect(analysis.key.chosen?.name).toBe('D major');
    expect(eff?.tempo).toBe(analysis.tempo);
  });
});
