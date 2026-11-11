/**
 * Live "what am I playing?" guess from one input spectrum frame:
 * multi-pitch estimation → a chord name (2+ notes) or a single note with its
 * cents offset (tuner-style). Smoothed across calls so it doesn't flicker.
 */

import { chordFromWeights } from './chords';
import { noteName } from './music';
import { DEFAULT_POLY, MIN_HARMONICITY, multiPitchAnalyze, spectralPeaks } from './poly';
import type { Mode } from './types';

export interface LiveGuess {
  kind: 'none' | 'note' | 'chord';
  label: string;
  /** Notes heard (MIDI), strongest first. */
  notes: number[];
  /** For single notes: deviation from equal temperament (cents). */
  cents: number | null;
}

export interface LiveState {
  weights: Float64Array;
  bassWeights: Float64Array;
  lastLabel: string;
  hold: number;
}

export function newLiveState(): LiveState {
  return { weights: new Float64Array(12), bassWeights: new Float64Array(12), lastLabel: '—', hold: 0 };
}

export function liveGuess(
  mags: Float32Array,
  sampleRate: number,
  fftSize: number,
  rms: number,
  state: LiveState,
  tuningCents = 0,
  key: { tonic: number; mode: Mode } | null = null,
): LiveGuess {
  const decay = 0.6;
  for (let i = 0; i < 12; i++) {
    state.weights[i] *= decay;
    state.bassWeights[i] *= decay;
  }
  if (rms < 0.004) return settle(state, { kind: 'none', label: '—', notes: [], cents: null });

  const peaks = spectralPeaks(mags, sampleRate, fftSize, 60, 5000, -45);
  const { cands, harmonicity } = multiPitchAnalyze(peaks, tuningCents, { ...DEFAULT_POLY, maxPolyphony: 8 });
  // Squeaks, scrapes, breath: not explained by notes → show nothing.
  if (harmonicity < MIN_HARMONICITY) return settle(state, { kind: 'none', label: '—', notes: [], cents: null });
  const top = cands[0]?.salience ?? 0;
  const strong = cands.filter((c) => c.salience >= 0.15 * top);
  if (!strong.length) return settle(state, { kind: 'none', label: '—', notes: [], cents: null });

  const lowest = strong.reduce((m, c) => (c.midi < m.midi ? c : m), strong[0]);
  for (const c of strong) state.weights[((c.midi % 12) + 12) % 12] += c.salience / top;
  state.bassWeights[((lowest.midi % 12) + 12) % 12] += 1;

  // Distinct pitch classes clearly present in the smoothed picture.
  let maxW = 0;
  for (const v of state.weights) maxW = Math.max(maxW, v);
  const present = [...state.weights.keys()].filter((i) => state.weights[i] >= 0.35 * maxW);

  if (present.length <= 1 || strong.length === 1) {
    const m = strong[0].midi;
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    // Cents from the nearest spectral peak to the expected fundamental.
    let cents: number | null = null;
    let bestDist = Infinity;
    for (const p of peaks) {
      const d = Math.abs(1200 * Math.log2(p.freq / f0));
      if (d < 60 && d < bestDist) {
        bestDist = d;
        cents = 1200 * Math.log2(p.freq / f0);
      }
    }
    return settle(state, { kind: 'note', label: noteName(m), notes: [m], cents });
  }

  let bass = 0;
  for (let i = 1; i < 12; i++) if (state.bassWeights[i] > state.bassWeights[bass]) bass = i;
  const chord = chordFromWeights(state.weights, bass, key);
  if (!chord) return settle(state, { kind: 'none', label: '—', notes: [], cents: null });
  return settle(state, { kind: 'chord', label: chord.name, notes: strong.map((c) => c.midi), cents: null });
}

/** Require a new label to repeat once before switching (stops one-frame flicker). */
function settle(state: LiveState, g: LiveGuess): LiveGuess {
  if (g.label === state.lastLabel) {
    state.hold = 0;
    return g;
  }
  state.hold++;
  if (state.hold >= 2 || g.kind === 'none') {
    state.lastLabel = g.label;
    state.hold = 0;
    return g;
  }
  return { ...g, label: state.lastLabel };
}
