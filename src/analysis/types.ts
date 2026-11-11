/** Shared analysis result types. Everything here is structured-clone safe. */

export interface PitchTrack {
  /** Seconds between frames. */
  hopSec: number;
  /** Frame centre times in seconds. */
  times: Float32Array;
  /** Fundamental frequency per frame in Hz; 0 when unvoiced. */
  f0Hz: Float32Array;
  /** Voicing confidence per frame, 0..1. */
  confidence: Float32Array;
  /** Frame RMS (linear amplitude). */
  rms: Float32Array;
  engine: 'yin-js' | 'essentia-pyin';
}

export interface TuningResult {
  /** Global deviation from A440 equal temperament in cents, in [-50, 50). */
  cents: number;
  /** Equivalent reference pitch for A4. */
  a4Hz: number;
  /** Number of frames (source 'frames') or notes (source 'notes') that contributed. */
  frameCount: number;
  /** Median absolute spread around the estimate (cents). Lower = more consistent. */
  spreadCents: number;
  /** 'notes' = from each note's stable core (preferred); 'frames' = all stable voiced frames. */
  source?: 'notes' | 'frames';
}

export interface Note {
  /** Quantised MIDI pitch after removing the global tuning offset. */
  midi: number;
  /** Start time in seconds. */
  start: number;
  /** Duration in seconds. */
  duration: number;
  /** Deviation from the quantised pitch (after tuning removal) in cents. */
  cents: number;
  /** Median f0 of the note in Hz. */
  hz: number;
  /** Mean RMS of the note (linear). */
  level: number;
}

export type Mode = 'major' | 'minor';

export interface KeyCandidate {
  /** Tonic pitch class, 0 = C. */
  tonic: number;
  mode: Mode;
  name: string;
  score: number;
}

export interface KeyResult {
  tonic: number;
  mode: Mode;
  name: string;
  /** 0..1 */
  confidence: number;
  candidates: KeyCandidate[];
  source: 'notes-ks' | 'frames-ks' | 'essentia-keyextractor';
}

export interface TempoResult {
  bpm: number;
  /** Grid phase: time of the first grid line at or after 0, in ms. */
  gridPhaseMs: number;
  /** First downbeat: the grid line nearest the first sung note, in ms. */
  firstBeatMs: number;
  /** 0..1 */
  confidence: number;
  source: 'note-ioi' | 'essentia-rhythm2013';
  /** Raw tempo before folding into the target range. */
  rawBpm: number;
}

export interface AnalysisResult {
  version: 1;
  sampleRate: number;
  durationSec: number;
  pitch: PitchTrack;
  tuning: TuningResult;
  notes: Note[];
  key: {
    fromNotes: KeyResult | null;
    fromAudio: KeyResult | null;
    chosen: KeyResult | null;
  };
  tempo: {
    candidates: TempoResult[];
    chosen: TempoResult | null;
  };
  /** What was recorded: a single line (voice / single notes) or chords (piano, guitar). */
  input?: {
    source: 'melody' | 'chords';
    /** Average simultaneous pitches over loud frames (null if not measured). */
    polyphony: number | null;
    /** Share of loud frames with one clean period (≈1 single line, low for chords). */
    periodicity?: number;
  };
  /** Chords recognised from the played notes (chords input only). */
  playedChords?: {
    start: number;
    duration: number;
    root: number;
    quality: 'maj' | 'min' | 'dom7' | 'min7' | 'maj7';
    name: string;
  }[];
  engine: {
    essentia: boolean;
    essentiaVersion: string | null;
    essentiaError: string | null;
  };
  timingsMs: Record<string, number>;
}

/**
 * 'auto': f0 from the pure-TS YIN (tested to ±3 c), essentia KeyExtractor + RhythmExtractor2013 when available.
 * 'essentia-pyin': as auto, but f0 from essentia PitchYinProbabilistic (experimental: biased / octave errors in essentia.js 0.1.3).
 * 'js': no essentia at all.
 */
export type EnginePreference = 'auto' | 'essentia-pyin' | 'js';

/** 'auto' decides from the measured polyphony. */
export type InputSource = 'auto' | 'melody' | 'chords';
