/**
 * Note segmentation from an f0 track:
 *  1. median-filter the pitch (in MIDI units) over voiced frames
 *  2. split on voicing gaps and on pitch jumps (> splitCents from the segment's running median)
 *  3. merge glide fragments: short, pitch-moving pieces that slide into the next
 *     note (scoops) or out of the previous one (fall-offs) become part of that note
 *  4. split long notes at deep energy dips (re-articulated repeated notes: "da-da-da")
 *  5. drop notes shorter than minNoteSec
 *  6. pitch = median of the note's stable core (scoop/release trimmed), quantised
 *     after removing the global tuning offset
 *  7. fix isolated octave jumps
 */

import { hzToMidi, median, midiToHz } from './music';
import type { Note, PitchTrack } from './types';

export interface NoteOptions {
  medianWindowSec: number;
  splitCents: number;
  /** Voicing gaps up to this length are bridged. */
  maxGapSec: number;
  minNoteSec: number;
  minConfidence: number;
  /** Split a note where RMS falls below this fraction of the surrounding peaks. */
  dipRatio: number;
  /** Fragments shorter than this that glide toward a neighbour are merged into it. */
  glideMaxSec: number;
  /** 'viterbi' (HMM note tracking, default) or 'median' (running-median splitter). */
  method: 'viterbi' | 'median';
  /** Viterbi: pitch tolerance around a note, semitones. */
  sigmaSemitones: number;
  /** Viterbi: cost of a note change (at a 5 ms hop). */
  switchPenalty: number;
  /** Detected attacks (s). A note is split where it is re-struck (energy jumps at an onset). */
  onsets: number[];
}

export const DEFAULT_NOTE_OPTIONS: NoteOptions = {
  medianWindowSec: 0.035,
  splitCents: 70,
  maxGapSec: 0.02,
  minNoteSec: 0.08,
  minConfidence: 0.3,
  dipRatio: 0.55,
  glideMaxSec: 0.2,
  method: 'viterbi',
  sigmaSemitones: 0.5,
  switchPenalty: 12,
  onsets: [],
};

/** Split segments at attacks where the energy jumps (re-plucked / re-struck / re-articulated notes). */
function splitAtOnsets(segs: Segment[], track: PitchTrack, onsets: number[], minFrames: number): Segment[] {
  if (onsets.length === 0) return segs;
  const { times, rms, hopSec } = track;
  const t0 = times.length ? times[0] : 0;
  const out: Segment[] = [];
  for (const s of segs) {
    const cuts: number[] = [];
    let last = s.a;
    for (const t of onsets) {
      const k = Math.round((t - t0) / hopSec);
      if (k - last < minFrames || s.b - k < minFrames) continue;
      let before = Infinity;
      for (let j = Math.max(s.a, k - 4); j < k; j++) before = Math.min(before, rms[j]);
      let after = 0;
      for (let j = k; j < Math.min(s.b, k + 8); j++) after = Math.max(after, rms[j]);
      if (after > 1.3 * before) {
        cuts.push(k);
        last = k;
      }
    }
    if (!cuts.length) {
      out.push(s);
      continue;
    }
    let a = s.a;
    let cut = s.cut;
    for (const k of [...cuts, s.b]) {
      const pa = Math.max(a, s.pa);
      const pb = Math.min(k, s.pb);
      out.push({ a, b: k, pa: pb > pa ? pa : a, pb: pb > pa ? pb : k, cut });
      a = k;
      cut = true;
    }
  }
  return out;
}

/** Median-filtered pitch in fractional MIDI; NaN for unvoiced frames. */
export function smoothPitch(track: PitchTrack, windowSec: number, minConfidence: number): Float32Array {
  const n = track.f0Hz.length;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = track.f0Hz[i];
    raw[i] = f > 0 && track.confidence[i] >= minConfidence ? hzToMidi(f) : NaN;
  }
  const half = Math.max(1, Math.floor(windowSec / track.hopSec / 2));
  const out = new Float32Array(n);
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(raw[i])) {
      out[i] = NaN;
      continue;
    }
    buf.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (!Number.isNaN(raw[j])) buf.push(raw[j]);
    out[i] = median(buf);
  }
  return out;
}

interface Segment {
  a: number; // first frame (inclusive)
  b: number; // last frame (exclusive)
  /** Frames whose pitch defines the note (excludes merged glides). */
  pa: number;
  pb: number;
  /** Starts at an energy-dip cut (a re-articulation): never merged into the previous note. */
  cut?: boolean;
}

function voiced(pitch: Float32Array, a: number, b: number): number[] {
  const v: number[] = [];
  for (let i = a; i < b; i++) if (!Number.isNaN(pitch[i])) v.push(pitch[i]);
  return v;
}

interface SegStats {
  med: number;
  startP: number;
  endP: number;
  range: number;
  /** Total linear-fit pitch change across the segment (semitones, signed). */
  drift: number;
}

function linearDrift(v: number[]): number {
  const n = v.length;
  if (n < 3) return n === 2 ? v[1] - v[0] : 0;
  const mx = (n - 1) / 2;
  let my = 0;
  for (const y of v) my += y;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (v[i] - my);
    sxx += (i - mx) * (i - mx);
  }
  return (sxy / sxx) * (n - 1);
}

function stats(pitch: Float32Array, s: Segment): SegStats {
  const v = voiced(pitch, s.pa, s.pb);
  if (v.length === 0) return { med: NaN, startP: NaN, endP: NaN, range: 0, drift: 0 };
  const k = Math.min(3, v.length);
  const sorted = [...v].sort((x, y) => x - y);
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    med: median(v),
    startP: median(v.slice(0, k)),
    endP: median(v.slice(-k)),
    range: q(0.9) - q(0.1),
    drift: linearDrift(v),
  };
}

/** Merge short gliding fragments into the note they slide into (or out of). */
function mergeGlides(segs: Segment[], pitch: Float32Array, hop: number, o: NoteOptions, maxGapFrames: number): Segment[] {
  const out = segs.map((s) => ({ ...s }));
  // `contiguous`: at most a short breath between (a scoop may follow a breath).
  // `touching`: no unvoiced frames between — anything after silence is a new attack,
  // so it is never merged backwards into the previous note.
  const contiguous = (x: Segment, y: Segment): boolean => y.a - x.b <= maxGapFrames + 1;
  const touching = (x: Segment, y: Segment): boolean => y.a - x.b <= 1;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      const dur = (s.b - s.a) * hop;
      const st = stats(pitch, s);
      // Same-pitch fragments with no gap (split by wide vibrato or a scoop-biased median) are one note.
      const nx = i + 1 < out.length ? out[i + 1] : null;
      if (nx && !nx.cut && touching(s, nx)) {
        const ns = stats(pitch, nx);
        if (Math.abs(st.med - ns.med) < 0.5) {
          out.splice(i, 2, { a: s.a, b: nx.b, pa: Math.min(s.pa, nx.pa), pb: Math.max(s.pb, nx.pb), cut: s.cut });
          changed = true;
          break;
        }
      }
      if (dur >= o.glideMaxSec) continue;
      const prev = i > 0 ? out[i - 1] : null;
      const next = i + 1 < out.length ? out[i + 1] : null;
      const nextSt = next ? stats(pitch, next) : null;
      const prevSt = prev ? stats(pitch, prev) : null;

      // Wobble: a short piece less than ~0.8 st from the note it hangs on to is
      // that note's vibrato/drift (a real neighbour note sits a full semitone away).
      if (!s.cut && prev && prevSt && touching(prev, s) && (prev.b - prev.a) * hop > dur && Math.abs(st.med - prevSt.med) < 0.8) {
        prev.b = s.b;
        out.splice(i, 1);
        changed = true;
        break;
      }
      if (next && nextSt && !next.cut && contiguous(s, next) && (next.b - next.a) * hop > dur && Math.abs(st.med - nextSt.med) < 0.8) {
        next.a = s.a;
        next.cut = s.cut;
        out.splice(i, 1);
        changed = true;
        break;
      }

      // A glide has a clear trend; vibrato on a short real note mostly doesn't.
      const moving = Math.abs(st.drift) > 0.4;
      const tiny = dur < o.minNoteSec;
      if (!moving && !tiny) continue;
      // Which way is the fragment travelling? A scoop heads toward the next note,
      // a fall-off heads away from the previous one.
      const dir = Math.sign(st.drift);
      const intoNext =
        next && nextSt && contiguous(s, next) && (next.b - next.a) * hop > dur &&
        (Math.abs(st.endP - nextSt.med) < 0.8 ||
          (Math.abs(st.med - nextSt.med) <= 2.5 && (tiny || (moving && dir === Math.sign(nextSt.med - st.med)))));
      const outOfPrev =
        prev && prevSt && touching(prev, s) && (prev.b - prev.a) * hop > dur &&
        (Math.abs(st.startP - prevSt.med) < 0.8 ||
          (Math.abs(st.med - prevSt.med) <= 2.5 && (tiny || (moving && dir === Math.sign(st.med - prevSt.med)))));
      if (intoNext && next && !next.cut) {
        next.a = s.a; // the note starts where the scoop starts
        next.cut = s.cut;
        out.splice(i, 1);
        changed = true;
        break;
      }
      if (outOfPrev && prev && !s.cut) {
        prev.b = s.b;
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function splitOnDips(seg: Segment, rms: Float32Array, minFrames: number, ratio: number, out: Segment[]): void {
  const { a, b } = seg;
  if (b - a < 2 * minFrames + 1) {
    out.push(seg);
    return;
  }
  let m = -1;
  for (let i = a + minFrames; i < b - minFrames; i++) if (m < 0 || rms[i] < rms[m]) m = i;
  let maxBefore = 0;
  let maxAfter = 0;
  for (let i = a; i < m; i++) maxBefore = Math.max(maxBefore, rms[i]);
  for (let i = m + 1; i < b; i++) maxAfter = Math.max(maxAfter, rms[i]);
  if (m >= 0 && rms[m] < ratio * Math.min(maxBefore, maxAfter)) {
    const left: Segment = { a, b: m, pa: Math.max(a, seg.pa), pb: Math.min(m, seg.pb), cut: seg.cut };
    const right: Segment = { a: m + 1, b, pa: Math.max(m + 1, seg.pa), pb: Math.min(b, seg.pb), cut: true };
    if (left.pb <= left.pa) [left.pa, left.pb] = [a, m];
    if (right.pb <= right.pa) [right.pa, right.pb] = [m + 1, b];
    splitOnDips(left, rms, minFrames, ratio, out);
    splitOnDips(right, rms, minFrames, ratio, out);
  } else {
    out.push(seg);
  }
}

/** Median of the stable core: trims the attack (≤ 25 % / 50 ms) and release (≤ 15 % / 30 ms). */
function corePitch(pitch: Float32Array, s: Segment, hop: number): number {
  const len = s.pb - s.pa;
  const head = Math.min(Math.floor(len * 0.25), Math.round(0.05 / hop));
  const tail = Math.min(Math.floor(len * 0.15), Math.round(0.03 / hop));
  const core = voiced(pitch, s.pa + head, s.pb - tail);
  return core.length >= 3 ? median(core) : median(voiced(pitch, s.pa, s.pb));
}

/** Short notes an octave away from both neighbours (which agree with each other) are octave errors. */
function fixOctaveJumps(notes: Note[]): void {
  for (let i = 1; i + 1 < notes.length; i++) {
    const n = notes[i];
    if (n.duration > 0.3) continue;
    const p = notes[i - 1].midi;
    const q = notes[i + 1].midi;
    if (Math.abs(p - q) > 5) continue;
    for (const shift of [-12, 12]) {
      const m = n.midi + shift;
      if (Math.abs(m - p) <= 5 && Math.abs(m - q) <= 5 && Math.abs(n.midi - p) >= 10) {
        n.midi = m;
        n.hz *= Math.pow(2, shift / 12);
        break;
      }
    }
  }
}

/** Legacy splitter: new note when a frame strays > split from the running median. */
function medianSplitSegments(pitch: Float32Array, split: number, maxGapFrames: number): Segment[] {
  const segments: Segment[] = [];
  let cur: { a: number; lastVoiced: number; values: number[] } | null = null;
  const close = (): void => {
    if (cur) segments.push({ a: cur.a, b: cur.lastVoiced + 1, pa: cur.a, pb: cur.lastVoiced + 1 });
    cur = null;
  };
  for (let i = 0; i < pitch.length; i++) {
    const v = pitch[i];
    if (Number.isNaN(v)) {
      if (cur && i - cur.lastVoiced > maxGapFrames) close();
      continue;
    }
    if (cur && Math.abs(v - median(cur.values)) > split) close();
    if (!cur) cur = { a: i, lastVoiced: i, values: [] };
    cur.values.push(v);
    cur.lastVoiced = i;
  }
  close();
  return segments;
}

/**
 * HMM note tracking per voiced run: states are semitones (after removing the
 * tuning offset); the observation cost is a clipped Gaussian on the distance
 * from the state's pitch; every note change costs `switchPenalty`. Viterbi
 * finds the piecewise-constant semitone path that best explains the curve, so
 * vibrato and brief wobbles don't create notes while real changes are placed
 * where the evidence says.
 */
function viterbiSegments(pitch: Float32Array, offset: number, hop: number, o: NoteOptions, maxGapFrames: number): Segment[] {
  const out: Segment[] = [];
  const inv2s2 = 1 / (2 * o.sigmaSemitones * o.sigmaSemitones);
  const P = o.switchPenalty * (0.005 / hop);
  const CAP = 8;
  const n = pitch.length;
  let i = 0;
  while (i < n) {
    if (Number.isNaN(pitch[i])) {
      i++;
      continue;
    }
    // Voiced run with short gaps bridged.
    const r0 = i;
    let last = i;
    let j = i + 1;
    while (j < n && j - last <= maxGapFrames + 1) {
      if (!Number.isNaN(pitch[j])) last = j;
      j++;
    }
    const r1 = last + 1;
    i = r1;

    let lo = Infinity;
    let hi = -Infinity;
    for (let t = r0; t < r1; t++) {
      const p = pitch[t];
      if (Number.isNaN(p)) continue;
      lo = Math.min(lo, p - offset);
      hi = Math.max(hi, p - offset);
    }
    const s0 = Math.floor(lo) - 1;
    const nS = Math.ceil(hi) + 1 - s0 + 1;
    const T = r1 - r0;
    let cost = new Float64Array(nS);
    let next = new Float64Array(nS);
    const back = new Int16Array(T * nS);
    const obs = (t: number, s: number): number => {
      const p = pitch[r0 + t];
      if (Number.isNaN(p)) return 0;
      const d = p - offset - (s0 + s);
      return Math.min(CAP, d * d * inv2s2);
    };
    for (let s = 0; s < nS; s++) cost[s] = obs(0, s);
    for (let t = 1; t < T; t++) {
      let m = Infinity;
      let arg = 0;
      for (let s = 0; s < nS; s++) if (cost[s] < m) [m, arg] = [cost[s], s];
      for (let s = 0; s < nS; s++) {
        const stay = cost[s];
        const jump = m + P;
        if (stay <= jump) {
          next[s] = stay + obs(t, s);
          back[t * nS + s] = s;
        } else {
          next[s] = jump + obs(t, s);
          back[t * nS + s] = arg;
        }
      }
      [cost, next] = [next, cost];
    }
    const path = new Int16Array(T);
    let best = 0;
    for (let s = 1; s < nS; s++) if (cost[s] < cost[best]) best = s;
    path[T - 1] = best;
    for (let t = T - 1; t > 0; t--) path[t - 1] = back[t * nS + path[t]];

    // Path → segments (trim unvoiced frames at the edges).
    let a = 0;
    for (let t = 1; t <= T; t++) {
      if (t === T || path[t] !== path[a]) {
        let sa = r0 + a;
        let sb = r0 + t;
        while (sa < sb && Number.isNaN(pitch[sa])) sa++;
        while (sb > sa && Number.isNaN(pitch[sb - 1])) sb--;
        if (sb > sa) out.push({ a: sa, b: sb, pa: sa, pb: sb });
        a = t;
      }
    }
  }
  return out;
}

/** Re-quantise notes that were segmented with one tuning offset to another. */
export function requantize(notes: Note[], fromCents: number, toCents: number): Note[] {
  return notes.map((n) => {
    const sung = n.midi + (n.cents + fromCents) / 100; // absolute fractional MIDI (A440)
    const corrected = sung - toCents / 100;
    const midi = Math.round(corrected);
    return { ...n, midi, cents: (corrected - midi) * 100 };
  });
}

export function segmentNotes(track: PitchTrack, tuningCents: number, options: Partial<NoteOptions> = {}): Note[] {
  const o: NoteOptions = { ...DEFAULT_NOTE_OPTIONS, ...options };
  const hop = track.hopSec;
  const pitch = smoothPitch(track, o.medianWindowSec, o.minConfidence);
  const maxGapFrames = Math.round(o.maxGapSec / hop);
  const split = o.splitCents / 100;

  const segments =
    o.method === 'viterbi'
      ? viterbiSegments(pitch, tuningCents / 100, hop, o, maxGapFrames)
      : medianSplitSegments(pitch, split, maxGapFrames);

  // Cut at energy dips first (breaths/consonants, which the tracker may have
  // bridged), then merge glide fragments and same-pitch pieces.
  const minFrames = Math.max(1, Math.round(o.minNoteSec / hop));
  const dipCut: Segment[] = [];
  for (const s of segments) splitOnDips(s, track.rms, Math.max(1, Math.round(minFrames / 2)), o.dipRatio, dipCut);
  const refined = splitAtOnsets(mergeGlides(dipCut, pitch, hop, o, maxGapFrames), track, o.onsets, minFrames);

  const notes: Note[] = [];
  const offset = tuningCents / 100;
  for (const s of refined) {
    const { a, b } = s;
    const start = track.times[a] - hop / 2;
    const end = track.times[b - 1] + hop / 2;
    const duration = end - start;
    if (duration < o.minNoteSec) continue;
    if (voiced(pitch, s.pa, s.pb).length === 0) continue;
    let level = 0;
    for (let i = a; i < b; i++) level += track.rms[i];
    const m = corePitch(pitch, s, hop);
    const corrected = m - offset;
    const midi = Math.round(corrected);
    notes.push({
      midi,
      start,
      duration,
      cents: (corrected - midi) * 100,
      hz: midiToHz(m),
      level: level / (b - a),
    });
  }
  fixOctaveJumps(notes);
  return notes;
}
