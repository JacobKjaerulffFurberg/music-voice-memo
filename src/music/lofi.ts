/**
 * "Lo-fi my song": put a freely sung take on a steady grid so drums can sit
 * under it. The drums never follow the singer; the recording moves to them:
 *
 *  - the take is cut into phrases at the silences between them;
 *  - each phrase is slid so it starts on the beat grid (nothing is stretched for this);
 *  - within a phrase, a small even stretch (at most ±7 %) pulls the note starts
 *    onto the grid, pitch unchanged.
 *
 * Pure functions: the warped audio and the time map are derived on demand and
 * never stored, so switching lo-fi off gives the untouched take back.
 */

import type { DrumHit } from './arrange';

/** Stretch range inside a phrase. Small on purpose: more starts to sound watery on a voice. */
const MAX_STRETCH = 0.07;
/** A gap this long between notes starts a new phrase (seconds). */
const PHRASE_GAP = 0.28;

/**
 * Time-stretch without changing pitch (WSOLA): windows are copied from the
 * input at the new rate, each one nudged to where it lines up best with the
 * end of the one before, then overlap-added.
 */
export function stretch(x: Float32Array, ratio: number, sampleRate: number): Float32Array {
  const outLen = Math.max(1, Math.round(x.length * ratio));
  const win = Math.round(sampleRate * 0.04) & ~1;
  if (Math.abs(ratio - 1) < 0.004 || x.length < win * 3) {
    const out = new Float32Array(outLen);
    out.set(x.subarray(0, Math.min(x.length, outLen)));
    return out;
  }
  const hop = win / 2;
  const search = Math.round(sampleRate * 0.012);
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
  const out = new Float32Array(outLen + win);
  const norm = new Float32Array(outLen + win);
  const last = x.length - win;
  let prev = 0;
  for (let o = 0; o < outLen; o += hop) {
    const ideal = Math.max(0, Math.min(last, Math.round(o / ratio)));
    let best = ideal;
    const want = prev + hop; // where the previous window would naturally continue
    if (o > 0 && want <= last) {
      let bestScore = -Infinity;
      for (let d = -search; d <= search; d += 2) {
        const p = ideal + d;
        if (p < 0 || p > last) continue;
        let score = 0;
        for (let k = 0; k < win; k += 4) score += x[p + k] * x[want + k];
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
    }
    for (let k = 0; k < win; k++) {
      out[o + k] += x[best + k] * hann[k];
      norm[o + k] += hann[k];
    }
    prev = best;
  }
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) res[i] = out[i] / Math.max(norm[i], 1e-3);
  return res;
}

export interface Warp {
  samples: Float32Array;
  durationSec: number;
  /** Original time (s) → time in the warped take. */
  map: (t: number) => number;
  /** What was done, phrase by phrase (for tests and curiosity). */
  phrases: { from: number; to: number; ratio: number }[];
}

/** Slide each sung phrase onto the grid and stretch it gently so its notes land on it. */
export function alignToGrid(
  samples: Float32Array,
  sampleRate: number,
  notes: { start: number; duration: number }[],
  bpm: number,
  firstBeatSec: number,
): Warp {
  const dur = samples.length / sampleRate;
  const identity: Warp = { samples, durationSec: dur, map: (t) => t, phrases: [] };
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  if (sorted.length === 0 || !(bpm > 0)) return identity;

  const unit = 60 / bpm / 2; // eighth notes
  const off = (t: number): number => {
    const r = (t - firstBeatSec) / unit;
    return (r - Math.round(r)) * unit;
  };
  const snap = (t: number): number => t - off(t);

  // Phrases: runs of notes with only short gaps between them.
  const groups: { start: number; duration: number }[][] = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (g && prev && n.start - (prev.start + prev.duration) < PHRASE_GAP) g.push(n);
    else groups.push([n]);
  }

  const inPts: number[] = [];
  const outPts: number[] = [];
  const pieces: { at: number; audio: Float32Array }[] = [];
  const done: Warp['phrases'] = [];
  let prevOutEnd = 0;
  let prevInEnd = 0;

  groups.forEach((g, gi) => {
    const t0 = g[0].start;
    const tail = g[g.length - 1];
    const next = groups[gi + 1]?.[0].start ?? Infinity;
    const end = tail.start + tail.duration;
    // The phrase's audio: a breath before, the tail after, never into the neighbours.
    const a = Math.max(prevInEnd, t0 - 0.05, 0);
    const b = Math.min(dur, end + 0.3, (end + next) / 2);
    if (b - a < 0.05) return;

    // Best even stretch for this phrase: the one that puts its note starts nearest the grid.
    const T0 = snap(t0);
    let ratio = 1;
    if (g.length > 1) {
      let bestCost = Infinity;
      for (let s = 1 - MAX_STRETCH; s <= 1 + MAX_STRETCH + 1e-9; s += 0.005) {
        let cost = 0;
        let weight = 0;
        for (const n of g) {
          const w = Math.min(0.6, n.duration) + 0.1;
          const d = off(T0 + s * (n.start - t0)) / (unit / 2);
          cost += w * d * d;
          weight += w;
        }
        // A slight preference for leaving the phrase as sung.
        cost = cost / weight + 0.03 * Math.pow((s - 1) / MAX_STRETCH, 2);
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          ratio = s;
        }
      }
    }
    // Slide to the grid; if that would run into the phrase before, take the next grid line.
    let outStart = T0 - (t0 - a) * ratio;
    while (outStart < prevOutEnd - 1e-6) outStart += unit;

    const seg = samples.subarray(Math.round(a * sampleRate), Math.round(b * sampleRate));
    const audio = stretch(seg, ratio, sampleRate);
    // Short fades so the cut edges don't click.
    const fi = Math.min(audio.length >> 1, Math.round(sampleRate * 0.008));
    const fo = Math.min(audio.length >> 1, Math.round(sampleRate * 0.04));
    for (let i = 0; i < fi; i++) audio[i] *= i / fi;
    for (let i = 0; i < fo; i++) audio[audio.length - 1 - i] *= i / fo;
    pieces.push({ at: outStart, audio });

    const outEnd = outStart + audio.length / sampleRate;
    inPts.push(a, b);
    outPts.push(outStart, outEnd);
    done.push({ from: t0, to: outStart + (t0 - a) * ratio, ratio });
    prevOutEnd = outEnd;
    prevInEnd = b;
  });

  if (pieces.length === 0) return identity;
  // Before the first phrase and after the last, time just carries on.
  if (inPts[0] > 0) {
    inPts.unshift(0);
    outPts.unshift(Math.max(0, outPts[0] - inPts[1]));
  }
  const lastIn = inPts[inPts.length - 1];
  const lastOut = outPts[outPts.length - 1];
  if (dur > lastIn) {
    inPts.push(dur);
    outPts.push(lastOut + (dur - lastIn));
  }
  const durationSec = outPts[outPts.length - 1];
  const out = new Float32Array(Math.ceil(durationSec * sampleRate) + 1);
  for (const p of pieces) {
    const at = Math.max(0, Math.round(p.at * sampleRate));
    const n = Math.min(p.audio.length, out.length - at);
    for (let i = 0; i < n; i++) out[at + i] += p.audio[i];
  }

  const map = (t: number): number => {
    const n = inPts.length;
    if (t <= inPts[0]) return outPts[0] + (t - inPts[0]);
    if (t >= inPts[n - 1]) return outPts[n - 1] + (t - inPts[n - 1]);
    let i = 1;
    while (inPts[i] < t) i++;
    const span = inPts[i] - inPts[i - 1];
    return span <= 0 ? outPts[i] : outPts[i - 1] + ((t - inPts[i - 1]) / span) * (outPts[i] - outPts[i - 1]);
  };
  return { samples: out, durationSec, map, phrases: done };
}

/**
 * The tempo the lo-fi drums play at: always slow (50–100 BPM), whatever tempo
 * the take was read as. A take counted at 149 gets drums at 74.5, i.e. half
 * time on the very same grid, so the take's own tempo, bars and chords are untouched.
 */
export function lofiTempo(bpm: number): number {
  let t = bpm;
  while (t > 100) t /= 2;
  while (t < 50) t *= 2;
  return t;
}

/**
 * Where the drums' bar 1 goes. The slow drum bar spans several of the take's
 * beats, so there are several places it could start; pick the one where the
 * singing leans on the drums' strong beats: phrase starts and long notes on
 * the kick (beat 1) and on beat 3, less on 2 and 4, least in between.
 */
export function lofiDownbeat(notes: { start: number; duration: number }[], takeBpm: number, firstBeatSec: number): number {
  const drumBeat = 60 / lofiTempo(takeBpm);
  const takeBeat = 60 / takeBpm;
  const bar = 4 * drumBeat;
  const options = Math.max(1, Math.round(bar / takeBeat));
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  let best = firstBeatSec;
  let bestScore = -Infinity;
  for (let k = 0; k < options; k++) {
    const origin = firstBeatSec + k * takeBeat;
    let score = 0;
    sorted.forEach((n, i) => {
      const prev = sorted[i - 1];
      const opens = !prev || n.start - (prev.start + prev.duration) >= PHRASE_GAP;
      const weight = (Math.min(1, n.duration / drumBeat) + 0.2) * (opens ? 1.8 : 1);
      // Position in the drum bar, in drum beats.
      const pos = ((((n.start - origin) / drumBeat) % 4) + 4) % 4;
      const near = Math.round(pos * 2) / 2;
      if (Math.abs(pos - near) > 0.14) return;
      const at = near % 4;
      score += weight * (at === 0 ? 1 : at === 2 ? 0.75 : at === 1 || at === 3 ? 0.4 : 0.1);
    });
    // Prefer the take's own bar 1 unless another start is clearly better.
    if (score > bestScore * 1.08 + 1e-9 || bestScore === -Infinity) {
      bestScore = score;
      best = origin;
    }
  }
  return best;
}

/**
 * A lazy lo-fi beat on the grid: swung 16ths, a soft kick with a ghost note,
 * the snare a hair late, quiet uneven hats. Covers [0, endSec).
 */
export function lofiDrums(bpm: number, firstBeatSec: number, endSec: number, swing = 0.6): DrumHit[] {
  const beat = 60 / bpm;
  const bar = 4 * beat;
  const step = beat / 4;
  const hits: DrumHit[] = [];
  const at = (b: number, s: number): number => b + Math.floor(s / 2) * 2 * step + (s % 2 ? 2 * step * swing : 0);
  for (let k = Math.floor((0 - firstBeatSec) / bar); firstBeatSec + k * bar < endSec; k++) {
    const b = firstBeatSec + k * bar;
    const odd = ((k % 2) + 2) % 2 === 1;
    const add = (kind: DrumHit['kind'], s: number, velocity: number, late = 0): void => {
      const time = at(b, s) + late;
      if (time >= 0 && time < endSec) hits.push({ time, kind, velocity });
    };
    add('kick', 0, 1);
    add('kick', odd ? 7 : 10, 0.7);
    if (odd) add('kick', 11, 0.45);
    add('snare', 4, 0.85, 0.02);
    add('snare', 12, 0.9, 0.026);
    for (let s = 0; s < 16; s += 2) add('hat', s, s % 4 === 0 ? 0.55 : 0.8);
    add('hat', odd ? 15 : 7, 0.35);
  }
  return hits.sort((x, y) => x.time - y.time);
}
