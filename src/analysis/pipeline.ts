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
import { requantize, segmentNotes, type NoteOptions } from './notes';
import { HQ_YIN, trackPitchYin } from './pitch';
import { analyzePolyFrames, trackPolyNotes, type PolyFrames } from './poly';
import { detectOnsets } from './spectrum';
import { chooseTempo, gridScore, onsetsFromNotes, tempoFromBeatTicks, tempoFromOnsets, type Onset } from './tempo';
import { estimateTuning, tuningFromNotes } from './tuning';
import { assignVelocities } from './velocity';
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
  /** 'high': finer, slower pitch tracking (see HQ_YIN). */
  quality?: 'normal' | 'high';
  /** Extra note-segmentation options (used by the high-quality pass). */
  notes?: Partial<NoteOptions>;
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
  const pitch = ext.pitch ?? trackPitchYin(samples, sampleRate, options.quality === 'high' ? HQ_YIN : {});
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
    const firstPass = requantize(segmentNotes(pitch, frameTuning.cents, { onsets: onsetTimes, ...options.notes }), frameTuning.cents, 0);
    tuning = firstPass.length >= 3 ? tuningFromNotes(firstPass) : frameTuning;
    lap('tuning');
    notes = segmentNotes(pitch, tuning.cents, { onsets: onsetTimes, ...options.notes });
    lap('notes');
  }
  notes = assignVelocities(notes);

  const fromNotes = estimateKeyFromNotes(notes);
  const fromAudio = ext.audioKey ?? (source === 'melody' ? estimateKeyFromFrames(pitch, tuning.cents) : null);
  let chosenKey = fromNotes && notes.length >= 6 ? fromNotes : (fromAudio ?? fromNotes);
  lap('key');

  const candidates: TempoResult[] = [];
  const tempoOnsets: Onset[] =
    source === 'melody'
      ? onsetsFromNotes(notes)
      : onsets.map((o) => ({ time: o.time, weight: Math.sqrt(o.strength), accent: o.strength }));
  const ownTempo = tempoFromOnsets(tempoOnsets);
  if (ownTempo) candidates.push(ownTempo);
  if (ext.rhythm) {
    const r = tempoFromBeatTicks(ext.rhythm.bpm, ext.rhythm.ticks, ext.rhythm.confidence, tempoOnsets);
    if (r) candidates.push(r);
  }
  const chosenTempo = chooseTempo(candidates, tempoOnsets);
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

/** Note-detection settings tried by the high-quality pass, loose → strict. */
const HQ_VARIANTS: Partial<NoteOptions>[] = [{}, { dipRatio: 0.35, onsetJump: 3 }, { dipRatio: 0.25, onsetJump: 4 }];

/**
 * How believable a set of notes is: notes that sit on a steady beat grid
 * (at the take's own tempo) score high; fragments from echo / vibrato wobble
 * land between grid lines and very short notes cost extra.
 */
export function notePlausibility(r: AnalysisResult): number {
  const t = r.tempo.chosen;
  if (!t || r.notes.length < 4) return 0;
  const onsets = onsetsFromNotes(r.notes);
  const fit = gridScore(onsets, 60 / t.bpm, t.firstBeatMs / 1000);
  const beat = 60 / t.bpm;
  const tiny = r.notes.filter((n) => n.duration < 0.3 * beat).length / r.notes.length;
  return fit - 0.5 * tiny;
}

/**
 * High-quality analysis (slower): finer pitch tracking, then note detection
 * run loose → strict, keeping the result whose notes are most plausible.
 * Chords takes and very short takes fall back to one pass.
 */
export function analyzeHighQuality(
  samples: Float32Array,
  sampleRate: number,
  ext: ExternalInputs = {},
  options: Partial<AnalyzeOptions> = {},
): AnalysisResult {
  const t0 = now();
  const pitch = ext.pitch ?? trackPitchYin(samples, sampleRate, HQ_YIN);
  const withPitch = { ...ext, pitch };
  let best: AnalysisResult | null = null;
  let bestScore = -Infinity;
  for (const v of HQ_VARIANTS) {
    const r = analyze(samples, sampleRate, withPitch, { ...options, notes: { ...options.notes, ...v } });
    if (r.input?.source === 'chords') return { ...r, quality: 'high' };
    const s = notePlausibility(r) + (best ? 0 : 0.01); // ties go to the loosest
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  const out = best as AnalysisResult;
  return { ...out, quality: 'high', timingsMs: { ...out.timingsMs, total: Math.round(now() - t0) } };
}
