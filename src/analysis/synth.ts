/**
 * Deterministic test-signal synthesis: a melody of (optionally harmonic) sine
 * tones on a beat grid. Used by unit tests and the debug page.
 */

export interface SynthNote {
  midi: number;
  beats: number;
}

export interface SynthOptions {
  bpm: number;
  sampleRate: number;
  detuneCents: number;
  startSec: number;
  /** Relative amplitudes of harmonics 1, 2, 3… */
  harmonics: number[];
  /** Silence at the end of each note (articulation gap). */
  gapSec: number;
  noise: number;
  vibratoCents: number;
  vibratoHz: number;
  tailSec: number;
  amplitude: number;
  seed: number;
  /** Singer-like imperfections. Each note starts this many cents off and glides in. */
  scoopCents: number;
  scoopSec: number;
  /** Random onset displacement, ± seconds. */
  timingJitterSec: number;
  /** Random per-note pitch error, ± cents. */
  pitchErrorCents: number;
}

export const DEFAULT_SYNTH: SynthOptions = {
  bpm: 120,
  sampleRate: 44100,
  detuneCents: 0,
  startSec: 0.5,
  harmonics: [1],
  gapSec: 0.05,
  noise: 0.002,
  vibratoCents: 0,
  vibratoHz: 5.5,
  tailSec: 0.5,
  amplitude: 0.4,
  seed: 1,
  scoopCents: 0,
  scoopSec: 0.07,
  timingJitterSec: 0,
  pitchErrorCents: 0,
};

/** Deterministic uniform random in [-1, 1). */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
}

export function synthMelody(notes: SynthNote[], options: Partial<SynthOptions> = {}): Float32Array {
  const o: SynthOptions = { ...DEFAULT_SYNTH, ...options };
  const beat = 60 / o.bpm;
  const totalBeats = notes.reduce((s, n) => s + n.beats, 0);
  const len = Math.ceil((o.startSec + totalBeats * beat + o.tailSec) * o.sampleRate);
  const out = new Float32Array(len);
  const fade = Math.round(0.01 * o.sampleRate);
  const hNorm = o.harmonics.reduce((s, h) => s + Math.abs(h), 0) || 1;

  const rng = makeRng(o.seed * 7919 + 13);
  const scoopLen = Math.round(o.scoopSec * o.sampleRate);
  let t0 = o.startSec;
  for (const n of notes) {
    const jitter = o.timingJitterSec * rng();
    const err = o.pitchErrorCents * rng();
    const dur = n.beats * beat - o.gapSec - Math.max(0, jitter);
    const a = Math.round((t0 + jitter) * o.sampleRate);
    const b = Math.min(len, Math.round((t0 + jitter + dur) * o.sampleRate));
    const f = 440 * Math.pow(2, (n.midi - 69 + (o.detuneCents + err) / 100) / 12);
    const phases = o.harmonics.map(() => 0);
    for (let i = a; i < b; i++) {
      const k = i - a;
      const env = Math.min(1, k / fade, (b - i) / fade);
      let cents = o.vibratoCents ? o.vibratoCents * Math.sin((2 * Math.PI * o.vibratoHz * k) / o.sampleRate) : 0;
      if (o.scoopCents && k < scoopLen) cents += o.scoopCents * (1 - k / scoopLen);
      const vib = cents ? Math.pow(2, cents / 1200) : 1;
      let s = 0;
      for (let h = 0; h < o.harmonics.length; h++) {
        phases[h] += (2 * Math.PI * f * vib * (h + 1)) / o.sampleRate;
        s += o.harmonics[h] * Math.sin(phases[h]);
      }
      out[i] += (o.amplitude * env * s) / hNorm;
    }
    t0 += n.beats * beat;
  }

  // Deterministic white noise (LCG).
  let state = o.seed >>> 0 || 1;
  for (let i = 0; i < len; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] += o.noise * ((state / 4294967296) * 2 - 1);
  }
  return out;
}

export interface InstrumentEvent {
  /** Pitches struck together (strummed low → high when `strumSec` > 0). */
  midis: number[];
  /** Start position and length in beats. */
  at: number;
  beats: number;
  /** Relative loudness (default 1). */
  gain?: number;
}

export interface InstrumentOptions {
  bpm: number;
  sampleRate: number;
  detuneCents: number;
  startSec: number;
  tailSec: number;
  /** Amplitude decay time constant of the fundamental (s). Upper partials decay faster. */
  decaySec: number;
  /** Piano-string inharmonicity coefficient (partials slightly stretched). */
  inharmonicity: number;
  strumSec: number;
  partials: number;
  amplitude: number;
  noise: number;
  seed: number;
}

export const DEFAULT_INSTRUMENT: InstrumentOptions = {
  bpm: 100,
  sampleRate: 44100,
  detuneCents: 0,
  startSec: 0.5,
  tailSec: 0.8,
  decaySec: 1.2,
  inharmonicity: 0.0002,
  strumSec: 0,
  partials: 12,
  amplitude: 0.18,
  noise: 0.002,
  seed: 3,
};

/** Plucked/struck harmonic tones (piano-ish or guitar-ish) for polyphonic tests. */
export function synthInstrument(events: InstrumentEvent[], options: Partial<InstrumentOptions> = {}): Float32Array {
  const o: InstrumentOptions = { ...DEFAULT_INSTRUMENT, ...options };
  const beat = 60 / o.bpm;
  const end = events.reduce((m, e) => Math.max(m, e.at + e.beats), 0);
  const len = Math.ceil((o.startSec + end * beat + o.tailSec) * o.sampleRate);
  const out = new Float32Array(len);
  const sr = o.sampleRate;
  for (const e of events) {
    e.midis.forEach((midi, idx) => {
      const t0 = o.startSec + e.at * beat + idx * o.strumSec;
      const a = Math.round(t0 * sr);
      const b = Math.min(len, Math.round((o.startSec + (e.at + e.beats) * beat) * sr));
      const rel = Math.round(0.06 * sr);
      const f0 = 440 * Math.pow(2, (midi - 69 + o.detuneCents / 100) / 12);
      for (let h = 1; h <= o.partials; h++) {
        const f = h * f0 * Math.sqrt(1 + o.inharmonicity * h * h);
        if (f > sr / 2 - 500) break;
        const amp = ((e.gain ?? 1) * o.amplitude) / Math.pow(h, 0.9) * (midi < 48 ? 1.3 : 1);
        // Higher strings / notes die away faster (halving per two octaves above middle C).
        const tau = (o.decaySec * Math.pow(2, -(midi - 60) / 24)) / (1 + 0.35 * (h - 1));
        const w = (2 * Math.PI * f) / sr;
        for (let i = a; i < Math.min(len, b + rel); i++) {
          const k = i - a;
          const attack = Math.min(1, k / (0.003 * sr));
          const release = i < b ? 1 : 1 - (i - b) / rel;
          out[i] += amp * attack * release * Math.exp(-k / (tau * sr)) * Math.sin(w * k);
        }
      }
    });
  }
  const rng = makeRng(o.seed);
  for (let i = 0; i < len; i++) out[i] += o.noise * rng();
  return out;
}

/** A few tonal test melodies (MIDI, beats). */
export const TEST_MELODIES: Record<string, { tonic: number; mode: 'major' | 'minor'; notes: SynthNote[] }> = {
  'D major': {
    tonic: 2,
    mode: 'major',
    notes: [62, 66, 69, 66, 67, 64, 61, 62, 69, 71, 69, 67, 66, 64, 62].map((midi, i) => ({
      midi,
      beats: i === 7 || i === 14 ? 2 : 1,
    })),
  },
  'E minor': {
    tonic: 4,
    mode: 'minor',
    notes: [64, 67, 71, 67, 69, 66, 63, 64, 71, 72, 71, 69, 67, 66, 64].map((midi, i) => ({
      midi,
      beats: i === 7 || i === 14 ? 2 : 1,
    })),
  },
  'F major': {
    tonic: 5,
    mode: 'major',
    notes: [65, 69, 72, 70, 69, 67, 65, 64, 65, 67, 69, 70, 72, 70, 67, 65].map((midi, i) => ({
      midi,
      beats: i === 8 || i === 15 ? 2 : 1,
    })),
  },
  'A minor': {
    tonic: 9,
    mode: 'minor',
    notes: [57, 60, 64, 60, 62, 59, 56, 57, 64, 65, 64, 62, 60, 59, 57].map((midi, i) => ({
      midi,
      beats: i === 7 || i === 14 ? 2 : 1,
    })),
  },
};
