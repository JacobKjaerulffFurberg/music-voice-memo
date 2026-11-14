/**
 * Standard MIDI File (format 0) writer for the detected melody.
 * Bar 1 beat 1 of the file is the detected (or overridden) first downbeat;
 * notes sung before it become a pickup in an extra leading bar.
 */

import type { Mode, Note } from '../analysis/types';
import type { Chord, DrumHit } from '../music/arrange';

export interface MidiExportOptions {
  bpm: number;
  firstBeatSec: number;
  ppq: number;
  beatsPerBar: number;
  /** Grid subdivisions per beat to quantise to (e.g. 4 = 16ths); 0 = keep timing. */
  quantize: number;
  key: { tonic: number; mode: Mode } | null;
  trackName: string;
}

const DEFAULTS: MidiExportOptions = {
  bpm: 120,
  firstBeatSec: 0,
  ppq: 480,
  beatsPerBar: 4,
  quantize: 0,
  key: null,
  trackName: 'Voice memo melody',
};

function vlq(n: number): number[] {
  let v = Math.max(0, Math.round(n));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

const MAJOR_FIFTHS: Record<number, number> = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };

export function keySignatureFifths(tonic: number, mode: Mode): number {
  const relMajor = (((mode === 'major' ? tonic : tonic + 3) % 12) + 12) % 12;
  // Spell to match the UI's key names: F# major (6 sharps) but Eb minor (6 flats).
  if (relMajor === 6 && mode === 'minor') return -6;
  return MAJOR_FIFTHS[relMajor] ?? 0;
}

interface Ev {
  tick: number;
  order: number;
  bytes: number[];
}

/** Whole bars added at the start so a sung pickup before the first downbeat lands at tick ≥ 0. */
export function pickupShift(notes: Note[], o: MidiExportOptions): number {
  const barTicks = o.ppq * o.beatsPerBar;
  const q = o.quantize > 0 ? o.ppq / o.quantize : 0;
  let minOn = 0;
  for (const n of notes) {
    let on = ((n.start - o.firstBeatSec) / (60 / o.bpm)) * o.ppq;
    if (q > 0) on = Math.round(on / q) * q;
    minOn = Math.min(minOn, Math.round(on));
  }
  return minOn < 0 ? Math.ceil(-minOn / barTicks) * barTicks : 0;
}

/** Convert note times to ticks relative to the export grid. Exposed for tests. */
export function noteTicks(
  notes: Note[],
  o: MidiExportOptions,
): { on: number; off: number; midi: number; level: number; velocity: number | undefined }[] {
  const beat = 60 / o.bpm;
  const q = o.quantize > 0 ? o.ppq / o.quantize : 0;
  const raw = notes.map((n) => {
    let on = ((n.start - o.firstBeatSec) / beat) * o.ppq;
    let off = ((n.start + n.duration - o.firstBeatSec) / beat) * o.ppq;
    if (q > 0) {
      on = Math.round(on / q) * q;
      off = Math.max(on + q, Math.round(off / q) * q);
    }
    return { on: Math.round(on), off: Math.max(Math.round(on) + 1, Math.round(off)), midi: n.midi, level: n.level, velocity: n.velocity };
  });
  const shift = pickupShift(notes, o);
  // Trim overlaps between notes of the same pitch only (chords keep overlapping notes).
  const out = raw.map((n) => ({ ...n, on: n.on + shift, off: n.off + shift })).sort((a, b) => a.on - b.on);
  const lastByPitch = new Map<number, (typeof out)[number]>();
  for (const n of out) {
    const prev = lastByPitch.get(n.midi);
    if (prev && prev.off > n.on) prev.off = Math.max(prev.on + 1, n.on);
    lastByPitch.set(n.midi, n);
  }
  return out;
}

export interface MidiBacking {
  chords: Chord[];
  drums: DrumHit[];
}

const GM_DRUM: Record<DrumHit['kind'], number> = {
  kick: 36,
  snare: 38,
  hat: 42,
  openhat: 46,
  clave: 75,
  conga: 63,
  slap: 62,
  shell: 37,
  shaker: 70,
  cowbell: 56,
  timbale: 65,
};

function trackChunk(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const endTick = events.length ? events[events.length - 1].tick : 0;
  events.push({ tick: endTick, order: 3, bytes: [0xff, 0x2f, 0x00] });
  const data: number[] = [];
  let last = 0;
  for (const e of events) {
    data.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  const len = data.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...data];
}

function nameEvent(name: string): Ev {
  const bytes = Array.from(new TextEncoder().encode(name));
  return { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(bytes.length), ...bytes] };
}

/**
 * Melody only → format 0 (one track). With backing → format 1:
 * melody (ch 1), chords (ch 2, program 89 "warm pad"), bass (ch 3, program 33), drums (ch 10).
 */
export function encodeMidi(notes: Note[], options: Partial<MidiExportOptions> = {}, backing?: MidiBacking): Uint8Array {
  const o: MidiExportOptions = { ...DEFAULTS, ...options };
  const events: Ev[] = [];
  const meta = (tick: number, type: number, data: number[]): void => {
    events.push({ tick, order: 0, bytes: [0xff, type, ...vlq(data.length), ...data] });
  };

  events.push(nameEvent(o.trackName));
  const usPerQn = Math.round(60_000_000 / o.bpm);
  meta(0, 0x51, [(usPerQn >> 16) & 0xff, (usPerQn >> 8) & 0xff, usPerQn & 0xff]);
  meta(0, 0x58, [o.beatsPerBar, 2, 24, 8]);
  if (o.key) {
    const sf = keySignatureFifths(o.key.tonic, o.key.mode);
    meta(0, 0x59, [sf & 0xff, o.key.mode === 'minor' ? 1 : 0]);
  }

  const ticks = noteTicks(notes, o);
  const maxLevel = ticks.reduce((m, n) => Math.max(m, n.level), 0) || 1;
  for (const n of ticks) {
    const pitch = Math.max(0, Math.min(127, n.midi));
    // Detected/edited velocity when present; otherwise derived from loudness.
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity ?? 50 + 70 * Math.sqrt(n.level / maxLevel))));
    events.push({ tick: n.on, order: 2, bytes: [0x90, pitch, vel] });
    events.push({ tick: n.off, order: 1, bytes: [0x80, pitch, 0] });
  }
  const tracks: number[][] = [trackChunk(events)];

  if (backing && (backing.chords.length || backing.drums.length)) {
    // Same tick mapping (incl. pickup shift) as the melody.
    const shift = pickupShift(notes, o);
    const toTick = (t: number): number => Math.max(0, Math.round(((t - o.firstBeatSec) / (60 / o.bpm)) * o.ppq) + shift);
    const q = o.quantize > 0 ? o.ppq / o.quantize : 0;
    const snap = (tick: number): number => (q > 0 ? Math.round(tick / q) * q : tick);

    if (backing.chords.length) {
      const pad: Ev[] = [nameEvent('Chords'), { tick: 0, order: 0, bytes: [0xc1, 89] }];
      const bass: Ev[] = [nameEvent('Bass'), { tick: 0, order: 0, bytes: [0xc2, 33] }];
      for (const c of backing.chords) {
        const on = toTick(c.start);
        const off = Math.max(on + 1, toTick(c.start + c.duration) - 1);
        // Chord-symbol marker for DAWs that show them.
        const label = Array.from(new TextEncoder().encode(c.name));
        pad.push({ tick: on, order: 0, bytes: [0xff, 0x06, ...vlq(label.length), ...label] });
        for (const m of c.voicing) {
          pad.push({ tick: on, order: 2, bytes: [0x91, m, 70] });
          pad.push({ tick: off, order: 1, bytes: [0x81, m, 0] });
        }
        bass.push({ tick: on, order: 2, bytes: [0x92, c.bass, 95] });
        bass.push({ tick: off, order: 1, bytes: [0x82, c.bass, 0] });
      }
      tracks.push(trackChunk(pad), trackChunk(bass));
    }
    if (backing.drums.length) {
      const dr: Ev[] = [nameEvent('Drums')];
      for (const h of backing.drums) {
        const on = snap(toTick(h.time));
        const vel = Math.max(1, Math.min(127, Math.round(h.velocity * 110)));
        dr.push({ tick: on, order: 2, bytes: [0x99, GM_DRUM[h.kind], vel] });
        dr.push({ tick: on + o.ppq / 8, order: 1, bytes: [0x89, GM_DRUM[h.kind], 0] });
      }
      tracks.push(trackChunk(dr));
    }
  }

  const format = tracks.length > 1 ? 1 : 0;
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, tracks.length, (o.ppq >> 8) & 0xff, o.ppq & 0xff];
  return Uint8Array.from([...header, ...tracks.flat()]);
}
