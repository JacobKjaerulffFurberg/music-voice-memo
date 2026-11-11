/** App-level data model: stored recordings, manual overrides, effective DAW settings. */

import { keyName } from './analysis/music';
import { applyIntent, DEFAULT_INTENT, type IntentOptions } from './analysis/intent';
import { detectChords, refineKeyWithChords } from './analysis/chords';
import { estimateKeyFromNotes } from './analysis/key';
import { requantize } from './analysis/notes';
import type { AnalysisResult, InputSource, Mode, Note } from './analysis/types';

export interface Overrides {
  bpm?: number;
  firstBeatMs?: number;
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
}

export function intentOf(rec: { intent?: IntentOptions }): IntentOptions {
  return { ...DEFAULT_INTENT, ...rec.intent };
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
}): AnalysisResult | null {
  const raw = rec.analysis;
  if (!raw) return raw;
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
      firstBeat: o.firstBeatMs !== undefined,
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
