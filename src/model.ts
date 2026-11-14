/** App-level data model: stored recordings, manual overrides, effective DAW settings. */

import { keyName } from './analysis/music';
import { applyIntent, DEFAULT_INTENT, type IntentOptions } from './analysis/intent';
import { detectChords, refineKeyWithChords } from './analysis/chords';
import { estimateKeyFromNotes } from './analysis/key';
import { requantize } from './analysis/notes';
import { assignVelocities } from './analysis/velocity';
import type { AnalysisResult, InputSource, Mode, Note } from './analysis/types';
import { CHROMA_FIT_DISTANCE, type Quality } from './music/arrange';

export interface Overrides {
  bpm?: number;
  firstBeatMs?: number;
  /** firstBeatMs was fitted automatically after a tempo change (not placed by hand): re-fit on the next one. */
  firstBeatAuto?: boolean;
  keyTonic?: number;
  keyMode?: Mode;
  /** Manual tuning offset (cents vs A440). Re-reads which semitone each detected note is. */
  tuningCents?: number;
}

export interface StoredRecording {
  id: string;
  name: string;
  createdAt: number;
  sampleRate: number;
  samples: Float32Array;
  analysis: AnalysisResult | null;
  overrides: Overrides;
  /** Hand-edited melody; replaces analysis.notes everywhere when present. */
  editedNotes?: Note[];
  /** Interpretation settings (fit to key, quantize, legato) applied to detected notes. */
  intent?: IntentOptions;
  /** What the take is: auto-detected, or forced to melody / chords. */
  source?: InputSource;
  /** Chords picked by hand, by slot (beats from bar 1). */
  chordEdits?: Record<string, { root: number; quality: Quality }>;
  /** How spicy the chords are: 0 plain … 3 neo-soul. */
  spice?: number;
  /** Magic wand: seed for which colours and stand-in chords the spice picks. A new number = a new take on the chords. */
  wand?: number;
  /** How far the chords leave the key: 0 in key … 3 outside. */
  chroma?: number;
  /** Phone page: lo-fi drums on, with the recording slid and stretched onto their grid. */
  drums?: boolean;
  /** Phone page: chords play along (default on; false = off). */
  keys?: boolean;
  /** Phone page: how much the drums / the piano do. 0 sparse · 1 normal (default) · 2 busy. */
  drumFeel?: number;
  keysFeel?: number;
  /** Phone page: what kind of band plays along ('lofi' default, 'latin'). */
  genre?: string;
  /** Phone page: the vibe last picked (colours the app; see music/groove.ts). */
  vibe?: string;
  /** Phone page: rain ambience. */
  rain?: boolean;
  /** Loop region (seconds) and whether looping is on. */
  loop?: { start: number; end: number; on: boolean };
}

/** The chromatic dial also decides how readily sung outside notes are pulled into the key. */
export function intentOf(rec: { intent?: IntentOptions; chroma?: number }): IntentOptions {
  const level = Math.max(0, Math.min(3, rec.chroma ?? 0));
  return { ...DEFAULT_INTENT, fitMaxDistance: CHROMA_FIT_DISTANCE[level], ...rec.intent };
}

export function isChordsTake(a: AnalysisResult | null): boolean {
  return a?.input?.source === 'chords';
}

/**
 * The analysis as the user sees it:
 *  - no edits: detected notes run through the interpretation pass (fit to key,
 *    quantize, legato) using the effective key / tempo / grid;
 *  - edited: the edited notes, with the note-based key re-estimated from them;
 *  - chords takes: the played chords are re-recognised from the effective
 *    notes on the effective beat grid (so edits and tempo fixes carry through).
 */
export function effectiveAnalysis(rec: {
  analysis: AnalysisResult | null;
  editedNotes?: Note[];
  overrides?: Overrides;
  intent?: IntentOptions;
  chroma?: number;
}): AnalysisResult | null {
  const stored = rec.analysis;
  if (!stored) return stored;
  // Takes analysed before velocities existed get them computed from loudness.
  const raw: AnalysisResult =
    stored.notes.some((n) => n.velocity === undefined) ? { ...stored, notes: assignVelocities(stored.notes) } : stored;
  // A tuning override re-reads which semitone each detected note is.
  const tune = rec.overrides?.tuningCents;
  const a: AnalysisResult =
    tune !== undefined && Math.abs(tune - raw.tuning.cents) > 1e-6
      ? {
          ...raw,
          notes: requantize(raw.notes, raw.tuning.cents, tune),
          tuning: { ...raw.tuning, cents: tune, a4Hz: 440 * Math.pow(2, tune / 1200) },
        }
      : raw;
  if (a !== raw) {
    // Key from the re-read notes (unless the key is overridden, which effectiveSettings handles).
    const fromNotes = estimateKeyFromNotes(a.notes);
    if (fromNotes) a.key = { ...a.key, fromNotes, chosen: a.notes.length >= 6 ? fromNotes : (a.key.fromAudio ?? fromNotes) };
  }
  const poly = isChordsTake(a);
  let out: AnalysisResult;
  if (!rec.editedNotes) {
    const s = effectiveSettings(a, rec.overrides ?? {});
    const notes = applyIntent(a.notes, { key: s.key, bpm: s.bpm, firstBeatSec: s.firstBeatMs / 1000, polyphonic: poly }, intentOf(rec));
    out = { ...a, notes };
  } else {
    const notes = rec.editedNotes;
    const fromNotes = estimateKeyFromNotes(notes);
    const chosen = fromNotes && notes.length >= 6 ? fromNotes : (a.key.fromAudio ?? fromNotes);
    out = { ...a, notes, key: { ...a.key, fromNotes, chosen } };
  }
  if (poly) {
    const s = effectiveSettings(out, rec.overrides ?? {});
    out.playedChords = detectChords(out.notes, {
      stepSec: 60 / s.bpm,
      originSec: s.firstBeatMs / 1000,
      durationSec: a.durationSec,
      key: s.key,
      switchPenalty: 0.35,
    });
    // After edits the key was re-estimated from notes: let the progression settle major vs relative minor.
    const fromNotes = out.key.fromNotes;
    if (rec.editedNotes && fromNotes && out.playedChords.length) {
      const k = refineKeyWithChords(fromNotes.candidates, out.playedChords);
      if (k) out.key = { ...out.key, chosen: { ...fromNotes, tonic: k.tonic, mode: k.mode, name: k.name } };
    }
  }
  return out;
}

export interface Settings {
  bpm: number;
  bpmConfidence: number;
  bpmSource: string;
  firstBeatMs: number;
  key: { tonic: number; mode: Mode; name: string } | null;
  keyConfidence: number;
  tuningCents: number;
  a4Hz: number;
  overridden: { bpm: boolean; firstBeat: boolean; key: boolean; tuning: boolean };
}

export const DEFAULT_BPM = 120;

export function effectiveSettings(a: AnalysisResult | null, o: Overrides): Settings {
  const t = a?.tempo.chosen ?? null;
  const k = a?.key.chosen ?? null;
  const bpm = o.bpm ?? t?.bpm ?? DEFAULT_BPM;
  const firstBeatMs = o.firstBeatMs ?? t?.firstBeatMs ?? 0;
  let key: Settings['key'] = k ? { tonic: k.tonic, mode: k.mode, name: k.name } : null;
  if (o.keyTonic !== undefined && o.keyMode !== undefined) {
    key = { tonic: o.keyTonic, mode: o.keyMode, name: keyName(o.keyTonic, o.keyMode) };
  }
  return {
    bpm,
    bpmConfidence: o.bpm !== undefined ? 1 : (t?.confidence ?? 0),
    bpmSource: o.bpm !== undefined ? 'manual' : (t?.source ?? 'default'),
    firstBeatMs,
    key,
    keyConfidence: o.keyTonic !== undefined ? 1 : (k?.confidence ?? 0),
    tuningCents: o.tuningCents ?? a?.tuning.cents ?? 0,
    a4Hz: 440 * Math.pow(2, (o.tuningCents ?? a?.tuning.cents ?? 0) / 1200),
    overridden: {
      bpm: o.bpm !== undefined,
      firstBeat: o.firstBeatMs !== undefined && !o.firstBeatAuto,
      tuning: o.tuningCents !== undefined,
      key: o.keyTonic !== undefined,
    },
  };
}

/** Beat times (seconds) covering [0, duration]. */
export function beatTimes(bpm: number, firstBeatMs: number, durationSec: number): { time: number; index: number }[] {
  const P = 60 / bpm;
  const first = firstBeatMs / 1000;
  const kStart = Math.ceil((0 - first) / P);
  const kEnd = Math.floor((durationSec - first) / P);
  const out: { time: number; index: number }[] = [];
  for (let k = kStart; k <= kEnd; k++) out.push({ time: first + k * P, index: k });
  return out;
}

export function newId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
