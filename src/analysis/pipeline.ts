/**
 * Pure analysis pipeline: Float32Array + sampleRate → AnalysisResult.
 *
 * Two paths, chosen automatically from the measured polyphony (or forced):
 *  - melody (voice, whistling, single-note instrument lines): YIN f0 →
 *    HMM note tracking → note-based tuning/key/tempo
 *  - chords (piano, guitar): spectrogram → iterative multi-pitch estimation →
 *    polyphonic notes → chord recognition; tempo from attacks
 *
 * Optional essentia-derived inputs (pitch track, audio key, rhythm) can be
 * injected; anything missing falls back to the pure-TS implementations.
 */

import { detectChords, refineKeyWithChords } from './chords';
import { estimateKeyFromFrames, estimateKeyFromNotes } from './key';
import { requantize, segmentNotes } from './notes';
import { trackPitchYin } from './pitch';
import { analyzePolyFrames, trackPolyNotes, type PolyFrames } from './poly';
import { detectOnsets } from './spectrum';
import { chooseTempo, tempoFromBeatTicks, tempoFromNotes, tempoFromOnsets } from './tempo';
import { estimateTuning, tuningFromNotes } from './tuning';
import type { AnalysisResult, InputSource, KeyResult, Note, PitchTrack, TempoResult, TuningResult } from './types';

export interface RhythmInput {
  bpm: number;
  ticks: Float32Array;
  confidence: number;
}

export interface ExternalInputs {
  pitch?: PitchTrack | null;
  audioKey?: KeyResult | null;
  rhythm?: RhythmInput | null;
  essentiaVersion?: string | null;
  essentiaError?: string | null;
}

export interface AnalyzeOptions {
  source: InputSource;
}

/** Above this average number of simultaneous pitches, a take may be chords… */
export const POLYPHONY_THRESHOLD = 1.6;
/** …unless at least this share of loud frames is cleanly periodic (one note at a time). */
export const PERIODIC_MELODY = 0.7;

/** Share of loud frames where YIN finds one clean period (≈1 for a single line, low for chords). */
export function periodicity(track: PitchTrack): number {
  const { confidence, f0Hz, rms } = track;
  let peak = 0;
  for (const v of rms) peak = Math.max(peak, v);
  let loud = 0;
  let clean = 0;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] < 0.1 * peak) continue;
    loud++;
    if (f0Hz[i] > 0 && confidence[i] >= 0.85) clean++;
  }
  return loud ? clean / loud : 0;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function analyze(
  samples: Float32Array,
  sampleRate: number,
  ext: ExternalInputs = {},
  options: Partial<AnalyzeOptions> = {},
): AnalysisResult {
  const timings: Record<string, number> = {};
  let t = now();
  const lap = (name: string): void => {
    const n = now();
    timings[name] = Math.round(n - t);
    t = n;
  };

  const requested = options.source ?? 'auto';
  const onsets = detectOnsets(samples, sampleRate);
  lap('onsets');
  const pitch = ext.pitch ?? trackPitchYin(samples, sampleRate);
  lap('pitch');
  let poly: PolyFrames | null = null;
  if (requested !== 'melody') {
    poly = analyzePolyFrames(samples, sampleRate);
    lap('polyphony');
  }
  // Chords only if several pitches show up in the long analysis window AND the
  // sound isn't one clean periodic waveform. Fast single lines and reverberant
  // singing smear into the long window, but stay periodic in short frames.
  const periodic = periodicity(pitch);
  const source: 'melody' | 'chords' =
    requested === 'auto'
      ? (poly?.polyphony ?? 0) >= POLYPHONY_THRESHOLD && periodic < PERIODIC_MELODY
        ? 'chords'
        : 'melody'
      : requested;

  let tuning: TuningResult;
  let notes: Note[];
  if (source === 'chords' && poly) {
    tuning = poly.tuning;
    notes = trackPolyNotes(poly, onsets, tuning.cents);
    lap('notes');
  } else {
    // Segment at the frame tuning, take tuning from the notes' stable cores
    // (robust to scoops and vibrato), then segment again at that tuning.
    const onsetTimes = onsets.filter((o) => o.strength >= 0.2).map((o) => o.time);
    const frameTuning = estimateTuning(pitch);
    const firstPass = requantize(segmentNotes(pitch, frameTuning.cents, { onsets: onsetTimes }), frameTuning.cents, 0);
    tuning = firstPass.length >= 3 ? tuningFromNotes(firstPass) : frameTuning;
    lap('tuning');
    notes = segmentNotes(pitch, tuning.cents, { onsets: onsetTimes });
    lap('notes');
  }

  const fromNotes = estimateKeyFromNotes(notes);
  const fromAudio = ext.audioKey ?? (source === 'melody' ? estimateKeyFromFrames(pitch, tuning.cents) : null);
  let chosenKey = fromNotes && notes.length >= 6 ? fromNotes : (fromAudio ?? fromNotes);
  lap('key');

  const candidates: TempoResult[] = [];
  if (source === 'melody') {
    const noteTempo = tempoFromNotes(notes);
    if (noteTempo) candidates.push(noteTempo);
  } else {
    const onsetTempo = tempoFromOnsets(onsets.map((o) => ({ time: o.time, weight: Math.sqrt(o.strength) })));
    if (onsetTempo) candidates.push(onsetTempo);
  }
  if (ext.rhythm) {
    const r = tempoFromBeatTicks(ext.rhythm.bpm, ext.rhythm.ticks, ext.rhythm.confidence, notes[0]?.start ?? null);
    if (r) candidates.push(r);
  }
  const chosenTempo = chooseTempo(candidates);
  lap('tempo');

  let playedChords: AnalysisResult['playedChords'];
  if (source === 'chords') {
    const beat = chosenTempo ? 60 / chosenTempo.bpm : 0.5;
    playedChords = detectChords(notes, {
      stepSec: beat,
      originSec: chosenTempo ? chosenTempo.firstBeatMs / 1000 : 0,
      durationSec: samples.length / sampleRate,
      key: chosenKey ? { tonic: chosenKey.tonic, mode: chosenKey.mode } : null,
      switchPenalty: 0.35,
    });
    // The progression settles relative-key ambiguity (C major vs A minor).
    if (fromNotes && playedChords.length) {
      const k = refineKeyWithChords(fromNotes.candidates, playedChords);
      if (k && (k.tonic !== fromNotes.tonic || k.mode !== fromNotes.mode)) {
        chosenKey = { ...fromNotes, tonic: k.tonic, mode: k.mode, name: k.name };
      }
    }
    lap('chords');
  }

  return {
    version: 1,
    sampleRate,
    durationSec: samples.length / sampleRate,
    pitch,
    tuning,
    notes,
    key: { fromNotes, fromAudio, chosen: chosenKey },
    tempo: { candidates, chosen: chosenTempo },
    input: { source, polyphony: poly ? poly.polyphony : null, periodicity: periodic },
    ...(playedChords ? { playedChords } : {}),
    engine: {
      essentia: ext.essentiaVersion != null,
      essentiaVersion: ext.essentiaVersion ?? null,
      essentiaError: ext.essentiaError ?? null,
    },
    timingsMs: timings,
  };
}
