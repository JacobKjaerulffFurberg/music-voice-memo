/**
 * The chords of a take as the user hears them: suggested (or played) chords,
 * with the user's per-slot edits, the take's spice level, re-voiced for smooth
 * voice leading, optionally floated onto the singing. Shared by the DAW page,
 * the phone page and the MIDI export, so edits made anywhere show up everywhere.
 */

import { effectiveAnalysis, isChordsTake, type Settings, type StoredRecording } from '../model';
import { chordName, chromaChords, floatChords, keysLift, prefersSharps, revoice, spiceChords, suggestChords, voicePlayedChords, type Chord } from './arrange';

export interface TakeChordOptions {
  chordsPerBar: 1 | 2 | 'auto';
  /** Chord changes follow the sung note starts instead of the bar line. */
  floaty: boolean;
}

/** Stable id of a chord slot: its position in beats from bar 1 (survives re-voicing and floating). */
export function slotOf(start: number, s: Settings): string {
  const beat = 60 / s.bpm;
  return String(Math.round(((start - s.firstBeatMs / 1000) / beat) * 2) / 2);
}

export function takeChords(rec: StoredRecording, s: Settings, o: TakeChordOptions): Chord[] {
  const eff = effectiveAnalysis(rec);
  if (!eff) return [];
  const played = isChordsTake(eff) && !!eff.playedChords?.length;
  let base: Chord[];
  if (played) base = voicePlayedChords(eff.playedChords ?? []);
  else if (s.key) {
    const grid = { bpm: s.bpm, firstBeatSec: s.firstBeatMs / 1000, beatsPerBar: 4, durationSec: rec.samples.length / rec.sampleRate };
    base = suggestChords(eff.notes, s.key, grid, { chordsPerBar: o.chordsPerBar });
  } else return [];

  const edits = rec.chordEdits ?? {};
  const keep = new Set<number>();
  base = base.map((c, i) => {
    const slot = slotOf(c.start, s);
    const e = edits[slot];
    if (!e) return { ...c, slot };
    keep.add(i);
    return { ...c, slot, root: e.root, quality: e.quality, name: chordName(e.root, e.quality, prefersSharps(s.key)), numeral: '' };
  });
  if (s.key && !played) base = chromaChords(base, eff.notes, s.key, rec.chroma ?? 0, keep);
  const spiced = s.key ? spiceChords(base, eff.notes, s.key, rec.spice ?? 0, keep) : base;
  // A sung take with a low voice gets the keys voiced a little higher, just above the voice.
  const voiced = revoice(spiced, played ? 0 : keysLift(eff.notes));
  return o.floaty && !played ? floatChords(voiced, eff.notes, (0.5 * 60) / s.bpm) : voiced;
}
