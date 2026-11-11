/**
 * Polyphonic pitch detection for piano / guitar (no machine learning):
 *
 *  1. spectrogram (≈170 ms Hann frames at ~22–24 kHz, ~21 ms hop) and
 *     interpolated spectral peaks per frame
 *  2. global tuning from the strongest low peaks
 *  3. per frame, iterative estimation & cancellation (after Klapuri 2006):
 *     harmonic-sum salience for every semitone → take the best → remove its
 *     partials from the peak list → repeat while the next candidate is strong
 *  4. note tracking: per-pitch activations → notes, starts snapped to detected
 *     attacks, re-struck notes split at onsets
 */

import { tuningFromDeviations } from './tuning';
import { decimate } from './pitch';
import { stft, type Onset, type Spectrogram } from './spectrum';
import type { Note, TuningResult } from './types';

export interface Peak {
  freq: number;
  amp: number;
}

export interface PolyOptions {
  minMidi: number;
  maxMidi: number;
  maxPolyphony: number;
  harmonics: number;
  /** A further pitch is accepted if its salience ≥ this × the frame's strongest. */
  relThreshold: number;
  /** …and ≥ this × the 95th-percentile frame salience of the whole take. */
  absThreshold: number;
  minNoteSec: number;
}

export const DEFAULT_POLY: PolyOptions = {
  minMidi: 28,
  maxMidi: 96,
  maxPolyphony: 10,
  harmonics: 10,
  relThreshold: 0.2,
  absThreshold: 0.06,
  minNoteSec: 0.08,
};

const midiHz = (m: number, cents: number): number => 440 * Math.pow(2, (m - 69 + cents / 100) / 12);

/** Local maxima of the magnitude spectrum with parabolic (log-magnitude) interpolation. */
export function spectralPeaks(mag: Float32Array, sampleRate: number, fftSize: number, minHz = 35, maxHz = 5000, relDb = -45): Peak[] {
  const k0 = Math.max(2, Math.floor((minHz * fftSize) / sampleRate));
  const k1 = Math.min(mag.length - 2, Math.ceil((maxHz * fftSize) / sampleRate));
  let max = 0;
  for (let k = k0; k <= k1; k++) max = Math.max(max, mag[k]);
  if (max <= 1e-7) return [];
  const floor = max * Math.pow(10, relDb / 20);
  const peaks: Peak[] = [];
  for (let k = k0; k <= k1; k++) {
    const v = mag[k];
    if (v < floor || v < mag[k - 1] || v <= mag[k + 1]) continue;
    const a = Math.log(mag[k - 1] + 1e-12);
    const b = Math.log(v + 1e-12);
    const c = Math.log(mag[k + 1] + 1e-12);
    const den = a - 2 * b + c;
    const p = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    peaks.push({ freq: ((k + p) * sampleRate) / fftSize, amp: Math.exp(b - 0.25 * (a - c) * p) });
  }
  return peaks;
}

function nearestPeak(peaks: Peak[], f: number): number {
  let lo = 0;
  let hi = peaks.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (peaks[mid].freq < f) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(peaks[lo - 1].freq - f) < Math.abs(peaks[lo].freq - f)) return lo - 1;
  return lo;
}

/** Tuning from the deviations of strong low peaks (mostly fundamentals and low harmonics). */
export function tuningFromSpectrogram(spec: Spectrogram): TuningResult {
  const devs: number[] = [];
  for (const mag of spec.mags) {
    const peaks = spectralPeaks(mag, spec.sampleRate, spec.fftSize, 60, 1100, -20);
    for (const p of peaks) {
      const m = 69 + 12 * Math.log2(p.freq / 440);
      devs.push((m - Math.round(m)) * 100);
    }
  }
  const r = tuningFromDeviations(devs);
  return { ...r, source: 'frames' };
}

interface Candidate {
  midi: number;
  salience: number;
}

/** Iterative multi-pitch estimation for one frame. Returns candidates strongest first (unthresholded). */
export function multiPitchFrame(peaksIn: Peak[], tuningCents: number, o: PolyOptions): Candidate[] {
  return multiPitchAnalyze(peaksIn, tuningCents, o).cands;
}

/**
 * Multi-pitch estimation plus harmonicity: the share of the frame's spectral
 * peak energy explained by the detected notes' partials. Notes and chords are
 * ≳0.6; squeaks, scrapes and breath noise are low.
 */
export function multiPitchAnalyze(peaksIn: Peak[], tuningCents: number, o: PolyOptions): { cands: Candidate[]; harmonicity: number } {
  const peaks = peaksIn.map((p) => ({ ...p }));
  let energy = 0;
  for (const p of peaks) energy += p.amp * p.amp;
  const out: Candidate[] = [];
  for (let iter = 0; iter < o.maxPolyphony && peaks.length; iter++) {
    let best: Candidate | null = null;
    /** Matched peak index per harmonic (−1 = none), for the best candidate. */
    let bestMatches: number[] = [];
    for (let m = o.minMidi; m <= o.maxMidi; m++) {
      if (out.some((c) => c.midi === m)) continue;
      const f0 = midiHz(m, tuningCents);
      // Klapuri's partial weighting (f0 + α) / (h·f0 + β): high notes have few
      // partials below 5 kHz, so a plain sum would always favour low notes.
      const g = (h: number): number => (f0 + 27) / (h * f0 + 320);
      let s = 0;
      let fundamental = 0;
      let strongest = 0;
      const matches: number[] = [];
      for (let h = 1; h <= o.harmonics; h++) {
        const f = h * f0;
        if (f > 5000) break;
        const i = nearestPeak(peaks, f);
        if (i < 0) break;
        const dev = Math.abs(1200 * Math.log2(peaks[i].freq / f));
        // Tuning is already compensated, so a real note's fundamental is close to the
        // grid (±25 c; rejects e.g. the ~31 c-flat 7th partial of a bass note as a
        // fake "7th"). Upper partials get more room for string inharmonicity.
        const tol = h === 1 ? 25 : 35 + 4 * h;
        if (dev > tol || peaks[i].amp <= 0) {
          matches.push(-1);
          continue;
        }
        const a = peaks[i].amp * (1 - 0.5 * (dev / tol));
        s += g(h) * a;
        matches.push(i);
        if (h === 1) fundamental = a;
        strongest = Math.max(strongest, a);
      }
      // A real note has energy at its fundamental (avoids sub-octave ghosts)…
      if (fundamental < 0.12 * strongest) continue;
      // …and overtones: a lone sine-like peak (squeak, whistle of a string) isn't a note.
      if (f0 < 2000 && matches.filter((i) => i >= 0).length < 2) continue;
      if (!best || s > best.salience) {
        best = { midi: m, salience: s };
        bestMatches = matches;
      }
    }
    if (!best || best.salience <= 0) break;
    if (out.length && best.salience < 0.08 * out[0].salience) break;
    out.push(best);
    // Cancel with spectral smoothness (Klapuri): subtract the note's *expected*
    // partial level — the partial capped at its neighbours' average. A partial
    // shared with another note (e.g. an octave or twelfth above the bass)
    // sticks out above that envelope and keeps its excess.
    const amps = bestMatches.map((i) => (i >= 0 ? peaks[i].amp : 0));
    bestMatches.forEach((i, h) => {
      if (i < 0) return;
      const nb: number[] = [];
      if (h > 0) nb.push(amps[h - 1]);
      if (h + 1 < amps.length) nb.push(amps[h + 1]);
      const neighbour = nb.length ? nb.reduce((x, y) => x + y, 0) / nb.length : amps[h];
      const expected = h === 0 ? amps[h] : Math.min(amps[h], Math.max(neighbour, 0.5 * amps[h]));
      peaks[i].amp = Math.max(0, peaks[i].amp - expected * 0.95);
    });
  }
  let residual = 0;
  for (const p of peaks) residual += p.amp * p.amp;
  return { cands: out, harmonicity: energy > 0 ? 1 - residual / energy : 0 };
}

/** Frames whose spectrum is explained less than this by notes are treated as noise. */
export const MIN_HARMONICITY = 0.5;

export interface PolyFrames {
  spec: Spectrogram;
  tuning: TuningResult;
  frames: Candidate[][];
  /** Unthresholded candidates per frame (used to let ringing notes decay naturally). */
  raw: Candidate[][];
  /** Average number of simultaneous pitches over loud frames (≈1 for a voice, ≥2 for chords). */
  polyphony: number;
}

export function analyzePolyFrames(samples: Float32Array, sampleRate: number, options: Partial<PolyOptions> = {}): PolyFrames {
  const o: PolyOptions = { ...DEFAULT_POLY, ...options };
  const { data, rate } = decimate(samples, sampleRate, 22050);
  const fftSize = 4096;
  const spec = stft(data, rate, fftSize, 512);
  const tuning = tuningFromSpectrogram(spec);
  const analyzed = spec.mags.map((mag) => multiPitchAnalyze(spectralPeaks(mag, rate, fftSize), tuning.cents, o));
  const raw = analyzed.map((a) => a.cands);
  const noisy = analyzed.map((a) => a.harmonicity < MIN_HARMONICITY);

  // Global threshold from the distribution of frame-strongest saliences.
  const tops = raw.map((c) => c[0]?.salience ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
  const p95 = tops.length ? tops[Math.floor(0.95 * (tops.length - 1))] : 0;
  const abs = o.absThreshold * p95;
  let loud = 0;
  let count = 0;
  const frames = raw.map((cands, t) => {
    if (!cands.length || cands[0].salience < abs || noisy[t]) return [];
    const top = cands[0].salience;
    const kept = cands.filter((c) => c.salience >= abs && c.salience >= o.relThreshold * top);
    if (top >= 0.25 * p95) {
      loud++;
      count += kept.length;
    }
    return kept;
  });
  return { spec, tuning, frames, raw, polyphony: loud ? count / loud : 0 };
}

/** Per-pitch activations → notes. Starts snap to nearby onsets; re-struck notes split at onsets. */
export function trackPolyNotes(pf: PolyFrames, onsets: Onset[], tuningCents: number, options: Partial<PolyOptions> = {}): Note[] {
  const o: PolyOptions = { ...DEFAULT_POLY, ...options };
  const { spec, frames } = pf;
  const hop = spec.hop / spec.sampleRate;
  const T = frames.length;
  const notes: Note[] = [];
  // Noise attacks (squeaks, scrapes) must not pull note starts or split notes.
  const noiseAttacks = noisyOnsets(pf, onsets, tuningCents, o);
  const musicalOnsets = onsets.filter((x) => !noiseAttacks.includes(x.time));
  const onsetTimes = musicalOnsets.map((x) => x.time);
  const halfWin = spec.fftSize / spec.sampleRate / 2;

  const byPitch = new Map<number, Float32Array>();
  frames.forEach((cands, t) => {
    for (const c of cands) {
      let arr = byPitch.get(c.midi);
      if (!arr) byPitch.set(c.midi, (arr = new Float32Array(T)));
      arr[t] = c.salience;
    }
  });

  let maxSal = 0;
  for (const arr of byPitch.values()) for (const v of arr) maxSal = Math.max(maxSal, v);

  // Unthresholded salience per pitch (for decay hysteresis) and the strongest per frame.
  const rawByPitch = new Map<number, Float32Array>();
  const frameTop = new Float32Array(T);
  pf.raw.forEach((cands, t) => {
    frameTop[t] = cands[0]?.salience ?? 0;
    for (const c of cands) {
      let arr = rawByPitch.get(c.midi);
      if (!arr) rawByPitch.set(c.midi, (arr = new Float32Array(T)));
      arr[t] = c.salience;
    }
  });

  const nearestOnset = (t: number, before: number, after: number): number | null => {
    let best: number | null = null;
    for (const x of onsetTimes) {
      if (x < t - before || x > t + after) continue;
      if (best === null || Math.abs(x - t) < Math.abs(best - t)) best = x;
    }
    return best;
  };

  for (const [midi, act] of byPitch) {
    const sustain = rawByPitch.get(midi) ?? act;
    // Bridge dropouts of up to two frames.
    for (let t = 1; t + 1 < T; t++) {
      if (act[t] > 0 || act[t - 1] === 0) continue;
      const next = act[t + 1] > 0 ? t + 1 : t + 2 < T && act[t + 2] > 0 ? t + 2 : -1;
      if (next < 0) continue;
      for (let j = t; j < next; j++) act[j] = Math.max(sustain[j], 0.5 * (act[t - 1] + act[next]));
    }
    let t = 0;
    while (t < T) {
      if (act[t] === 0) {
        t++;
        continue;
      }
      const a = t;
      let runPeak = 0;
      while (t < T && act[t] > 0) runPeak = Math.max(runPeak, act[t++]);
      // Hysteresis: a ringing note keeps going while it is still clearly present
      // (unthresholded), even after it falls below the "new note" threshold.
      while (t < T && act[t] === 0 && sustain[t] >= 0.3 * runPeak) {
        act[t] = sustain[t];
        t++;
      }
      const b = t; // exclusive
      // Split at onsets inside the run where this pitch is re-struck (activation jumps up).
      // Compare the frame whose (long) window ends at the attack with the one
      // that mostly starts after it.
      const cuts: number[] = [a];
      const t0 = spec.times[0];
      for (const x of onsetTimes) {
        const k = Math.round((x - t0) / hop); // frame centred on the attack
        if (k <= a + 2 || k >= b - 2 || k - cuts[cuts.length - 1] < 3) continue;
        const kb = Math.max(a, Math.round((x - halfWin - t0) / hop));
        const ka = Math.min(b - 1, Math.round((x + 0.6 * halfWin - t0) / hop));
        const before = act[kb];
        const after = Math.max(act[ka], act[Math.min(b - 1, ka + 1)]);
        if (after > 1.2 * before) cuts.push(k);
      }
      cuts.push(b);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const s0 = cuts[i];
        const s1 = cuts[i + 1];
        let sum = 0;
        let peak = 0;
        let ratio = 0; // strongest share of what was sounding at the time
        for (let j = s0; j < s1; j++) {
          sum += act[j];
          peak = Math.max(peak, act[j]);
          if (frameTop[j] > 0) ratio = Math.max(ratio, act[j] / frameTop[j]);
        }
        const mean = sum / (s1 - s0);
        // Long analysis windows see a note ~half a window early; start at the attack if there is one.
        const rawStart = i === 0 ? spec.times[s0] - halfWin * 0.5 : spec.times[s0] - halfWin;
        const snapped = nearestOnset(rawStart, 0.12, 0.15);
        const start = Math.max(0, snapped ?? rawStart);
        const end = spec.times[s1 - 1] + hop / 2 - halfWin * 0.5;
        const duration = end - start;
        if (duration < o.minNoteSec) continue;
        // Judge a note against what was sounding at the same time, not the loudest strum of the take.
        if (ratio < 0.28 || peak < 0.03 * maxSal) continue;
        notes.push({ midi, start, duration, cents: 0, hz: midiHz(midi, tuningCents), level: mean / maxSal });
      }
    }
  }
  const cleaned = dropOvertoneGhosts(notes);
  const added = notesFromAttackSpectra(pf, musicalOnsets, tuningCents, cleaned, rawByPitch, maxSal, o);
  // Short notes born at a noise attack (squeak, scrape, pick noise) are not notes.
  return [...cleaned, ...added]
    .filter((n) => !(n.duration < 0.3 && noiseAttacks.some((t) => Math.abs(n.start - t) < 0.06)))
    .sort((x, y) => x.start - y.start || x.midi - y.midi);
}

/** Onsets whose spectral rise is not explained by harmonic notes. */
function noisyOnsets(pf: PolyFrames, onsets: Onset[], tuningCents: number, o: PolyOptions): number[] {
  const { spec } = pf;
  const hop = spec.hop / spec.sampleRate;
  const halfWin = spec.fftSize / spec.sampleRate / 2;
  const t0 = spec.times[0];
  const out: number[] = [];
  for (const on of onsets) {
    const kb = Math.round((on.time - halfWin - t0) / hop);
    const ka = Math.round((on.time + 0.6 * halfWin - t0) / hop);
    if (kb < 0 || ka >= spec.mags.length) continue;
    const before = spec.mags[kb];
    const after = spec.mags[ka];
    const rise = new Float32Array(after.length);
    for (let k = 0; k < after.length; k++) rise[k] = Math.max(0, after[k] - 1.5 * before[k]);
    const h = multiPitchAnalyze(spectralPeaks(rise, spec.sampleRate, spec.fftSize), tuningCents, o).harmonicity;
    if (h < MIN_HARMONICITY + 0.1) out.push(on.time);
  }
  return out;
}

/**
 * New notes hide when they sit on a partial of a ringing note (a lead A5 over
 * an Am chord's A3). At each attack, the *rise* in the spectrum (after − before)
 * contains only what was just struck, so multi-pitch estimation on that
 * difference finds those notes. Adds notes the main pass missed.
 */
function notesFromAttackSpectra(
  pf: PolyFrames,
  onsets: Onset[],
  tuningCents: number,
  existing: Note[],
  rawByPitch: Map<number, Float32Array>,
  maxSal: number,
  o: PolyOptions,
): Note[] {
  const { spec } = pf;
  const hop = spec.hop / spec.sampleRate;
  const halfWin = spec.fftSize / spec.sampleRate / 2;
  const T = spec.mags.length;
  const t0 = spec.times[0];
  const hits: { time: number; midi: number; frame: number; salience: number }[] = [];
  for (const on of onsets) {
    if (on.strength < 0.08) continue;
    const kb = Math.round((on.time - halfWin - t0) / hop);
    const ka = Math.round((on.time + 0.6 * halfWin - t0) / hop);
    if (kb < 0 || ka >= T) continue;
    const before = spec.mags[kb];
    const after = spec.mags[ka];
    const rise = new Float32Array(after.length);
    // Require a real rise (not the small level wobble of ringing partials).
    for (let k = 0; k < after.length; k++) rise[k] = Math.max(0, after[k] - 1.5 * before[k]);
    const analyzed = multiPitchAnalyze(spectralPeaks(rise, spec.sampleRate, spec.fftSize), tuningCents, o);
    // A squeak / scrape attack isn't explained by any note's partials.
    if (analyzed.harmonicity < MIN_HARMONICITY + 0.1) continue;
    const cands = analyzed.cands;
    const top = cands[0]?.salience ?? 0;
    // Octave check: a new note sitting on a ringing partial barely "rises" at its
    // fundamental, so its octave wins. If the pitch an octave down also gained
    // clearly in absolute terms, that lower pitch is the new note.
    const binOf = (f: number): number => Math.round((f * spec.fftSize) / spec.sampleRate);
    const gain = (m: number): number => {
      const k = binOf(midiHz(m, tuningCents));
      let g = 0;
      for (let j = Math.max(1, k - 1); j <= Math.min(after.length - 1, k + 1); j++) g = Math.max(g, after[j] - before[j]);
      return g;
    };
    for (const c of cands) {
      const lower = c.midi - 12;
      if (lower >= o.minMidi && gain(lower) > 0.35 * gain(c.midi) && !cands.some((d) => d.midi === lower)) c.midi = lower;
    }
    const struck = cands.filter((c) => c.salience >= 0.2 * top && c.salience >= 0.012 * maxSal);
    // Only picked notes / dyads: a full strum raises every string at once, its
    // partials then look like new notes, and the main pass handles chords well.
    if (struck.filter((c) => c.salience >= 0.4 * top).length > 2) continue;
    for (const c of struck) hits.push({ time: on.time, midi: c.midi, frame: ka, salience: c.salience });
  }
  const added: Note[] = [];
  for (const h of hits) {
    const dup = [...existing, ...added].some((n) => n.midi === h.midi && Math.abs(n.start - h.time) < 0.07);
    if (dup) continue;
    // Ends at the next attack in the same register (a melody moving on), when it fades, or after 2 s.
    const sustain = rawByPitch.get(h.midi);
    let end = h.time + 2;
    const nextInRegister = hits.find((x) => x.time > h.time + 0.05 && Math.abs(x.midi - h.midi) <= 12);
    if (nextInRegister) end = Math.min(end, nextInRegister.time);
    if (sustain) {
      const ref = sustain[h.frame];
      let k = h.frame;
      while (k < T && sustain[k] >= 0.3 * ref && sustain[k] > 0) k++;
      end = Math.min(end, Math.max(h.time + o.minNoteSec, spec.times[Math.min(T - 1, k)] - halfWin * 0.5));
    }
    if (end - h.time < o.minNoteSec) continue;
    added.push({ midi: h.midi, start: h.time, duration: end - h.time, cents: 0, hz: midiHz(h.midi, tuningCents), level: h.salience / maxSal });
  }
  return added;
}

/** Intervals (semitones) of the 2nd–8th partials above a fundamental. */
const OVERTONE_INTERVALS = new Set([12, 19, 24, 28, 31, 34, 36]);

/**
 * Attack transients leave short "ghost" notes on a held note's partials
 * (octave, twelfth, two octaves…). Drop a note when a longer, stronger note
 * that started together with it sits an overtone interval below. A real
 * doubled octave survives because it lasts as long as its partner.
 */
export function dropOvertoneGhosts(notes: Note[]): Note[] {
  return notes.filter(
    (n) =>
      !notes.some(
        (m) =>
          m !== n &&
          OVERTONE_INTERVALS.has(n.midi - m.midi) &&
          Math.abs(n.start - m.start) < 0.08 &&
          n.duration < 0.5 * m.duration &&
          n.level < 1.2 * m.level,
      ),
  );
}
