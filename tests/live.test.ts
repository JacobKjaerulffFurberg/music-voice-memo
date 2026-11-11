import { describe, expect, it } from 'vitest';
import { liveGuess, newLiveState } from '../src/analysis/live';
import { stft } from '../src/analysis/spectrum';
import { synthInstrument } from '../src/analysis/synth';

const SR = 48000;

function guessAt(midis: number[], frames = 4, detune = 0) {
  const x = synthInstrument([{ midis, at: 0, beats: 4 }], { bpm: 60, sampleRate: SR, strumSec: 0.01, detuneCents: detune });
  const spec = stft(x, SR, 8192, 2048);
  const state = newLiveState();
  // Frames well inside the ringing chord (it starts at 0.5 s; 8192/2048 frames at 48 kHz).
  const first = spec.times.findIndex((t) => t > 0.75);
  let g = liveGuess(spec.mags[first], SR, 8192, spec.rms[first], state);
  for (let i = 1; i <= frames; i++) g = liveGuess(spec.mags[first + i], SR, 8192, spec.rms[first + i], state);
  return g;
}

describe('live chord / note readout', () => {
  it.each([
    [[48, 55, 60, 64, 67], 'C'],
    [[45, 52, 57, 60, 64], 'Am'],
    [[50, 57, 62, 65], 'Dm'],
    [[43, 47, 50, 55, 59, 65], 'G7'],
    [[40, 47, 52, 55, 59, 64], 'Em'],
  ])('%j → %s', (midis, name) => {
    const g = guessAt(midis as number[]);
    expect(g.kind).toBe('chord');
    expect(g.label).toBe(name);
  });

  it('a single note shows its name and cents (tuner)', () => {
    const g = guessAt([69], 4, 12);
    expect(g.kind).toBe('note');
    expect(g.label).toBe('A4');
    expect(Math.abs((g.cents ?? 99) - 12)).toBeLessThan(6);
  });

  it('silence shows nothing', () => {
    const state = newLiveState();
    expect(liveGuess(new Float32Array(4097), SR, 8192, 0, state).kind).toBe('none');
  });
});
