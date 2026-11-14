/** Playback of a recording with an optional click track on the beat grid. */

import { beatTimes } from '../model';
import type { Chord, DrumHit } from '../music/arrange';
import type { CompNote } from '../music/groove';

const mtof = (midi: number, cents: number): number => 440 * Math.pow(2, (midi - 69 + cents / 100) / 12);

export interface PlayNote {
  midi: number;
  start: number;
  duration: number;
  /** MIDI velocity 1–127 (default 100). */
  velocity?: number;
}

export interface PlayOptions {
  from: number;
  click: boolean;
  voice: boolean;
  /** Detected notes rendered with a simple synth. */
  notes: PlayNote[];
  /** Pitch offset applied to the synth so it sits in tune with the recording. */
  notesTuningCents: number;
  notesGain: number;
  drums: DrumHit[];
  /** 'lofi': a soft, dusty kit through tape-style filtering with a bed of hiss. Default: the plain kit. */
  drumStyle?: 'plain' | 'lofi' | 'latin';
  /** Written-out piano + bass part (the Latin montuno), played short and bright instead of `chords`. */
  comp?: CompNote[];
  /** How bright the floaty keys are (low-pass, Hz). Default 2800. */
  keysTone?: number;
  /** How much the piano does: 0 = one soft touch per chord, 1 = normal (default), 2 = busier, fills the space. */
  keysFeel?: number;
  /** How much room (reverb) is put on the recorded voice, 0–1. Default 0.07: barely there. */
  voiceRoom?: number;
  /** Rain on the window: a looped recording (public/sounds/rain.*) that keeps going across loop passes. */
  rain?: boolean;
  chords: Chord[];
  /** Pitch offset for chords/bass (match the recording when the voice is audible). */
  backingTuningCents: number;
  bpm: number;
  firstBeatMs: number;
  beatsPerBar: number;
  clickGain: number;
  /** 'floaty': soft Rhodes-style electric piano with strum, room and long tails. 'tight': synth pad + bass on the beat. */
  chordStyle: 'floaty' | 'tight';
  /** Loop this span (seconds) until stopped. */
  loop: { start: number; end: number } | null;
}

interface Segment {
  /** Audio-time span [start, end) played by this pass… */
  start: number;
  end: number;
  /** …starting at this AudioContext time. */
  at: number;
  nodes: AudioScheduledSourceNode[];
}

export class Player {
  private ctx: AudioContext | null = null;
  private segments: Segment[] = [];
  private stopped = 0;
  private duration = 0;
  private samples: Float32Array | null = null;
  private sampleRate = 44100;
  private buffer: { for: Float32Array; buf: AudioBuffer } | null = null;
  private opts: PlayOptions | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Sources of the pass being scheduled. */
  private nodes: AudioScheduledSourceNode[] = [];
  playing = false;
  onEnded: (() => void) | null = null;

  private context(): AudioContext {
    this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
    return this.ctx;
  }

  /** Current audio position (s), following loop wrap-arounds. */
  get position(): number {
    if (!this.playing || !this.ctx) return this.stopped;
    const now = this.ctx.currentTime;
    let seg = this.segments[0];
    for (const s of this.segments) if (s.at <= now) seg = s;
    if (!seg) return this.stopped;
    return Math.min(seg.end, seg.start + Math.max(0, now - seg.at));
  }

  /** Output latency (s): how far what you hear trails the scheduler. */
  get latency(): number {
    const c = this.ctx;
    return c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0;
  }

  private voiceBuffer(ctx: AudioContext): AudioBuffer {
    const samples = this.samples as Float32Array;
    if (this.buffer?.for !== samples || this.buffer.buf.sampleRate !== this.sampleRate) {
      const buf = ctx.createBuffer(1, samples.length, this.sampleRate);
      buf.copyToChannel(new Float32Array(samples), 0);
      this.buffer = { for: samples, buf };
    }
    return this.buffer.buf;
  }

  private loud: { for: Float32Array; rms: number } | null = null;

  /**
   * How loud the recording is where there is sound in it: the level of its
   * louder moments (80th percentile of 50 ms windows), so silence between
   * phrases doesn't drag the figure down.
   */
  private voiceLoudness(): number {
    const x = this.samples;
    if (!x || x.length === 0) return 0;
    if (this.loud?.for === x) return this.loud.rms;
    const win = Math.max(1, Math.round(this.sampleRate * 0.05));
    const frames: number[] = [];
    for (let i = 0; i + win <= x.length; i += win) {
      let sum = 0;
      for (let j = i; j < i + win; j++) sum += x[j] * x[j];
      frames.push(Math.sqrt(sum / win));
    }
    frames.sort((a, b) => a - b);
    const rms = frames.length ? frames[Math.floor(frames.length * 0.8)] : 0;
    this.loud = { for: x, rms };
    return rms;
  }

  /**
   * Gain for the keys so they sit just under the voice whatever level it was
   * recorded at: a loud take gets louder keys, a quiet one keeps them modest.
   */
  private keysLevel(): number {
    const KEYS_RMS = 0.045; // roughly what a held chord measures at gain 1
    const want = 0.7 * this.voiceLoudness();
    return Math.max(1.5, Math.min(5, want / KEYS_RMS));
  }

  private rainLoad: Promise<AudioBuffer | null> | null = null;
  private rainWanted = false;
  private rainNow: { src: AudioBufferSourceNode; gain: GainNode; off: ReturnType<typeof setTimeout> | null } | null = null;

  /**
   * The rain is a real recording (public/sounds/rain.*), not a synth. It is
   * loaded once, levelled, and its last two seconds are blended into its first
   * two so it loops without a seam. No file, or a format this browser can't
   * decode: no rain, and nothing else is affected.
   */
  private loadRain(ctx: AudioContext): Promise<AudioBuffer | null> {
    this.rainLoad ??= (async () => {
      for (const name of ['rain.m4a', 'rain.mp3', 'rain.ogg']) {
        try {
          const res = await fetch(new URL(`./sounds/${name}`, document.baseURI));
          if (!res.ok) continue;
          const raw = await ctx.decodeAudioData(await res.arrayBuffer());
          const fade = Math.min(Math.floor(raw.length / 4), Math.round(2 * raw.sampleRate));
          const len = raw.length - fade;
          const out = ctx.createBuffer(raw.numberOfChannels, len, raw.sampleRate);
          let sum = 0;
          for (let ch = 0; ch < raw.numberOfChannels; ch++) {
            const src = raw.getChannelData(ch);
            const dst = out.getChannelData(ch);
            dst.set(src.subarray(0, len));
            for (let i = 0; i < fade; i++) {
              const x = i / fade;
              dst[i] = src[i] * x + src[len + i] * (1 - x);
            }
            for (let i = 0; i < len; i += 7) sum += dst[i] * dst[i];
          }
          // Same quiet level whatever the recording was mastered at.
          const rms = Math.sqrt(sum / ((len / 7) * raw.numberOfChannels));
          const k = rms > 1e-5 ? Math.min(8, 0.035 / rms) : 1;
          for (let ch = 0; ch < out.numberOfChannels; ch++) {
            const d = out.getChannelData(ch);
            for (let i = 0; i < len; i++) d[i] *= k;
          }
          return out;
        } catch {
          // Missing or undecodable here: try the next format.
        }
      }
      return null;
    })();
    return this.rainLoad;
  }

  private startRain(ctx: AudioContext): void {
    const level = 1;
    this.rainWanted = true;
    if (this.rainNow) {
      // Still raining (or fading out from a restart): just bring it back up.
      const t = ctx.currentTime;
      if (this.rainNow.off) clearTimeout(this.rainNow.off);
      this.rainNow.off = null;
      const g = this.rainNow.gain.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(level, t, 0.15);
      return;
    }
    void this.loadRain(ctx).then((buf) => {
      if (!buf || !this.rainWanted || this.rainNow) return;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.setTargetAtTime(level, t, 0.4);
      src.connect(gain).connect(ctx.destination);
      src.start(t, Math.random() * Math.max(0, buf.duration - 1));
      this.rainNow = { src, gain, off: null };
    });
  }

  private stopRain(): void {
    this.rainWanted = false;
    const r = this.rainNow;
    const ctx = this.ctx;
    if (!r || !ctx || r.off) return;
    const t = ctx.currentTime;
    r.gain.gain.cancelScheduledValues(t);
    r.gain.gain.setTargetAtTime(0, t, 0.25);
    // Let it fade; if playback restarts meanwhile, startRain keeps this one going.
    r.off = setTimeout(() => {
      try {
        r.src.stop();
      } catch {
        // already stopped
      }
      if (this.rainNow === r) this.rainNow = null;
    }, 1500);
  }

  /** How the previous chord was played (so the next one is played differently). */
  private lastWay = '';

  private voiceIn: { ctx: AudioContext; node: AudioNode } | null = null;
  private voiceWet: GainNode | null = null;

  /**
   * A light polish on the recorded voice, barely there on purpose: rumble cut,
   * a little less boxiness, a touch of air, gentle levelling, and a whisper of
   * the same room the keys sit in.
   */
  private voiceBus(ctx: AudioContext): AudioNode {
    if (this.voiceIn?.ctx === ctx) return this.voiceIn.node;
    const input = ctx.createGain();
    const rumble = ctx.createBiquadFilter();
    rumble.type = 'highpass';
    rumble.frequency.value = 75;
    const box = ctx.createBiquadFilter();
    box.type = 'peaking';
    box.frequency.value = 320;
    box.Q.value = 0.9;
    box.gain.value = -2;
    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 7000;
    air.gain.value = 2.5;
    const level = ctx.createDynamicsCompressor();
    level.threshold.value = -24;
    level.knee.value = 18;
    level.ratio.value = 2.2;
    level.attack.value = 0.012;
    level.release.value = 0.22;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.2;
    input.connect(rumble).connect(box).connect(air).connect(level).connect(makeup).connect(ctx.destination);
    const room = ctx.createConvolver();
    room.buffer = this.roomImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.07;
    this.voiceWet = wet;
    makeup.connect(room).connect(wet).connect(ctx.destination);
    this.voiceIn = { ctx, node: input };
    return input;
  }

  async play(samples: Float32Array, sampleRate: number, o: PlayOptions): Promise<void> {
    this.stop();
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.opts = o;
    if (o.rain) this.startRain(ctx);
    this.voiceBus(ctx);
    this.voiceWet?.gain.setTargetAtTime(o.voiceRoom ?? 0.07, ctx.currentTime, 0.05);
    this.duration = samples.length / sampleRate;
    // A loop may run past the end of the recording (a whole-bar loop with a silent tail).
    const loop = o.loop && o.loop.end - o.loop.start >= 0.05 ? { start: Math.max(0, o.loop.start), end: o.loop.end } : null;
    let from = Math.max(0, Math.min(o.from, this.duration));
    if (loop && (from < loop.start || from >= loop.end)) from = loop.start;
    const t0 = ctx.currentTime + 0.05;
    this.playing = true;
    if (loop) {
      this.schedule(from, loop.end, t0);
      // Keep one pass queued ahead; drop finished passes.
      this.timer = setInterval(() => {
        const last = this.segments[this.segments.length - 1];
        if (!last || !this.playing) return;
        const lastEnd = last.at + (last.end - last.start);
        if (ctx.currentTime > lastEnd - 0.6) this.schedule(loop.start, loop.end, lastEnd);
        while (this.segments.length > 2 && this.segments[1].at + (this.segments[1].end - this.segments[1].start) < ctx.currentTime) {
          this.segments.shift();
        }
      }, 100);
    } else {
      this.schedule(from, this.duration, t0);
      this.timer = setTimeout(() => {
        this.stop(false);
        this.stopped = from;
        this.onEnded?.();
      }, (this.duration - from) * 1000 + 100) as unknown as ReturnType<typeof setInterval>;
    }
  }

  /** Schedule audio-time [a0, b0) of every enabled part to start at context time `at`. */
  private schedule(a0: number, b0: number, at: number): void {
    const ctx = this.context();
    const o = this.opts as PlayOptions;
    const nodes: AudioScheduledSourceNode[] = [];
    this.segments.push({ start: a0, end: b0, at, nodes });
    this.nodes = nodes; // tone() / drum() add their sources here
    if (o.voice) {
      const src = ctx.createBufferSource();
      src.buffer = this.voiceBuffer(ctx);
      const g = ctx.createGain();
      const len = b0 - a0;
      const fade = Math.min(0.005, len / 4);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(1, at + fade);
      g.gain.setValueAtTime(1, at + len - fade);
      g.gain.linearRampToValueAtTime(0, at + len);
      src.connect(g).connect(this.voiceBus(ctx));
      src.start(at, a0, len);
      nodes.push(src);
    }

    if (o.notes.length > 0) {
      // Simple monophonic synth: triangle + quiet sine an octave up, low-passed, ADSR.
      const bus = ctx.createBiquadFilter();
      bus.type = 'lowpass';
      bus.frequency.value = 3000;
      bus.connect(ctx.destination);
      for (const n of o.notes) {
        const end = Math.min(b0, n.start + n.duration);
        if (end <= a0 || n.start >= b0) continue;
        const startAt = at + Math.max(0, n.start - a0);
        const stopAt = at + (end - a0);
        const hz = 440 * Math.pow(2, (n.midi - 69 + o.notesTuningCents / 100) / 12);
        const g = ctx.createGain();
        // Velocity → loudness (a bit steeper than linear, like a keyboard), so faint notes stay faint.
        const peak = o.notesGain * Math.pow((n.velocity ?? 100) / 127, 1.6);
        g.gain.setValueAtTime(0, startAt);
        g.gain.linearRampToValueAtTime(peak, startAt + 0.012);
        g.gain.linearRampToValueAtTime(peak * 0.65, startAt + 0.12);
        g.gain.setValueAtTime(peak * 0.65, Math.max(startAt + 0.12, stopAt));
        g.gain.linearRampToValueAtTime(0, stopAt + 0.06);
        g.connect(bus);
        const oscs: [OscillatorType, number, number][] = [
          ['triangle', 1, 1],
          ['sine', 2, 0.25],
        ];
        for (const [type, mult, level] of oscs) {
          const osc = ctx.createOscillator();
          osc.type = type;
          osc.frequency.value = hz * mult;
          const lg = ctx.createGain();
          lg.gain.value = level;
          osc.connect(lg).connect(g);
          osc.start(startAt);
          osc.stop(stopAt + 0.08);
          nodes.push(osc);
        }
      }
    }

    if (o.drums.length > 0 && o.drumStyle === 'latin') {
      // A live, open room: bright, a touch of drive, no tape and no hiss.
      const top = ctx.createBiquadFilter();
      top.type = 'lowpass';
      top.frequency.value = 11500;
      top.Q.value = 0.5;
      const drive = ctx.createWaveShaper();
      drive.curve = this.warmCurve();
      drive.oversample = '2x';
      const out = ctx.createGain();
      out.gain.value = Math.max(0.5, Math.min(1.5, this.voiceLoudness() / 0.16)) * 0.7;
      top.connect(drive).connect(out).connect(ctx.destination);
      const room = ctx.createConvolver();
      room.buffer = this.roomImpulse(ctx);
      const wet = ctx.createGain();
      wet.gain.value = 0.1;
      drive.connect(room).connect(wet).connect(out);
      for (const h of o.drums) {
        if (h.time < a0 || h.time >= b0) continue;
        this.latinDrum(ctx, top, h, at + (h.time - a0));
      }
    } else if (o.drums.length > 0 && o.drumStyle === 'lofi') {
      // Everything through a dull, slightly driven "tape": no sharp highs, rounded peaks.
      const tape = ctx.createBiquadFilter();
      tape.type = 'lowpass';
      tape.frequency.value = 8200;
      tape.Q.value = 0.5;
      const warmth = ctx.createBiquadFilter();
      warmth.type = 'lowshelf';
      warmth.frequency.value = 140;
      warmth.gain.value = 3.5;
      const drive = ctx.createWaveShaper();
      drive.curve = this.warmCurve();
      drive.oversample = '2x';
      const out = ctx.createGain();
      // Sit with the recording: a loud take gets a louder kit.
      out.gain.value = Math.max(0.5, Math.min(1.5, this.voiceLoudness() / 0.16)) * 0.8;
      tape.connect(warmth).connect(drive).connect(out).connect(ctx.destination);
      for (const h of o.drums) {
        if (h.time < a0 || h.time >= b0) continue;
        this.lofiDrum(ctx, tape, h, at + (h.time - a0));
      }
      // A quiet bed of hiss under it all, which also hides the cuts between phrases.
      const hiss = ctx.createBufferSource();
      hiss.buffer = this.noiseBuffer(ctx);
      hiss.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 2400;
      band.Q.value = 0.4;
      const quiet = ctx.createGain();
      const len = b0 - a0;
      quiet.gain.setValueAtTime(0, at);
      quiet.gain.linearRampToValueAtTime(0.012, at + 0.05);
      quiet.gain.setValueAtTime(0.012, at + Math.max(0.05, len - 0.05));
      quiet.gain.linearRampToValueAtTime(0, at + len);
      hiss.connect(band).connect(quiet).connect(out);
      hiss.start(at);
      hiss.stop(at + len + 0.02);
      nodes.push(hiss);
    } else if (o.drums.length > 0) {
      const bus = ctx.createGain();
      bus.gain.value = 0.55;
      bus.connect(ctx.destination);
      for (const h of o.drums) {
        if (h.time < a0 || h.time >= b0) continue;
        this.drum(ctx, bus, h, at + (h.time - a0));
      }
    }

    if (o.chords.length > 0 && o.chordStyle === 'floaty') {
      // A warm electric piano played by a hand: soft drive, a slow stereo sway
      // (the classic suitcase tremolo) and a small room. Tails ring past each change.
      const bus = ctx.createBiquadFilter();
      bus.type = 'lowpass';
      bus.frequency.value = o.keysTone ?? 2800;
      bus.Q.value = 0.4;
      const drive = ctx.createWaveShaper();
      drive.curve = this.warmCurve();
      drive.oversample = '2x';
      const sway = ctx.createStereoPanner();
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 3.1;
      const depth = ctx.createGain();
      depth.gain.value = 0.28;
      lfo.connect(depth).connect(sway.pan);
      lfo.start(at);
      lfo.stop(at + (b0 - a0) + 8);
      nodes.push(lfo);
      const dry = ctx.createGain();
      dry.gain.value = 0.85;
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      const verb = ctx.createConvolver();
      verb.buffer = this.roomImpulse(ctx);
      const breathe = ctx.createGain();
      breathe.gain.value = 0.93;
      const swell = ctx.createOscillator();
      swell.frequency.value = 4.3;
      const swellDepth = ctx.createGain();
      swellDepth.gain.value = 0.07;
      swell.connect(swellDepth).connect(breathe.gain);
      swell.start(at);
      swell.stop(at + (b0 - a0) + 8);
      nodes.push(swell);
      bus.connect(drive).connect(breathe).connect(sway);
      const level = ctx.createGain();
      level.gain.value = this.keysLevel();
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -8;
      limit.knee.value = 6;
      limit.ratio.value = 12;
      limit.attack.value = 0.003;
      limit.release.value = 0.15;
      level.connect(limit).connect(ctx.destination);
      sway.connect(dry).connect(level);
      sway.connect(verb).connect(wet).connect(level);
      const beat = 60 / o.bpm;
      o.chords.forEach((c) => {
        const end = Math.min(b0, c.start + c.duration);
        if (end <= a0 || c.start >= b0) return;
        const b = at + (end - a0);
        const rnd = Math.random; // a fresh hand every time, every loop pass included
        const hz = (m: number): number => mtof(m, o.backingTuningCents);
        const touch = (m: number, t: number, vel: number): void => {
          if (t < a0 || t >= b0) return;
          this.rhodes(ctx, bus, hz(m), at + (t - a0), b, Math.max(0.12, Math.min(1, vel)));
        };
        // How this chord is played: never the same way twice in a row.
        const feel = o.keysFeel ?? 1;
        // Sparse: only the gentlest ways of laying a chord down.
        const ways: readonly string[] = feel <= 0 ? ['up', 'together', 'up', 'split'] : ['up', 'up', 'down', 'together', 'split', 'outside-in'];
        let way = ways[Math.floor(rnd() * ways.length)];
        if (way === this.lastWay) way = ways[(ways.indexOf(way) + (feel <= 0 ? 1 : 2)) % ways.length];
        this.lastWay = way;
        // How hard: mostly medium, sometimes a soft brush, now and then a firmer push. Sparse = always soft.
        const r = rnd();
        const force = feel <= 0 ? 0.6 + 0.12 * rnd() : r < 0.25 ? 0.62 + 0.1 * rnd() : r > 0.88 ? 1.08 : 0.82 + 0.16 * rnd();
        // The whole hand lands a few ms late or early, like a person.
        const land = c.start + 0.012 + rnd() * 0.022;
        const n = c.voicing.length;
        const top = n - 1;
        const gap = feel <= 0 ? 0.05 + 0.04 * rnd() : 0.026 + 0.04 * rnd(); // sparse: a slower, lazier roll
        c.voicing.forEach((m, k) => {
          let when: number;
          if (way === 'up') when = k * gap;
          else if (way === 'down') when = (top - k) * gap;
          else if (way === 'together') when = rnd() * 0.009;
          else if (way === 'split') when = 0.07 + 0.05 * rnd() + rnd() * 0.008; // bass first, then the hand as a block
          else when = (k === 0 || k === top ? 0 : 0.045 + (k - 1) * gap * 0.7) + rnd() * 0.006; // outer notes, then the inside
          touch(m, land + when + rnd() * 0.008, force * ((k === top ? 0.66 : 0.52) + 0.2 * rnd()));
        });
        // On a long chord the hand sometimes comes back: a soft re-touch off the beat.
        if (feel <= 0) {
          // Sparse: one touch and let it ring.
        } else if (c.duration >= 3.2 * beat && rnd() < (feel >= 2 ? 1 : 0.6)) {
          const t2 = c.start + (rnd() < 0.5 ? 2.5 : 3) * beat + rnd() * 0.03;
          const again = rnd() < 0.5 ? c.voicing.slice(-2) : c.voicing.slice(1, 3);
          again.forEach((m, k) => touch(m, t2 + k * 0.03, force * (0.26 + 0.1 * rnd())));
        } else if (c.duration >= 1.8 * beat && rnd() < (feel >= 2 ? 0.9 : 0.4)) {
          touch(c.voicing[top], c.start + 1.5 * beat + rnd() * 0.03, force * 0.26);
        }
        if (feel >= 2) {
          // Busier: single notes of the chord picked out between the beats, and the bass comes back halfway.
          let slow = beat;
          while (slow < 0.6) slow *= 2; // count in a relaxed pulse even when the take was read as fast
          for (let k = 0.5; k * slow < c.duration - 0.2; k += 1) {
            if (k === 0.5 || rnd() < 0.7) touch(c.voicing[Math.floor(rnd() * n)], c.start + k * slow + rnd() * 0.025, force * (0.22 + 0.12 * rnd()));
          }
          if (c.duration >= 3.2 * slow) touch(c.bass, c.start + 2 * slow + rnd() * 0.015, force * 0.6);
        }
        // The bass is the left hand of the same piano: it leads, then fades and wavers like every other note.
        touch(c.bass, c.start + rnd() * 0.01, force * (0.9 + 0.12 * rnd()));
      });
    } else if (o.chords.length > 0) {
      const pad = ctx.createBiquadFilter();
      pad.type = 'lowpass';
      pad.frequency.value = 1400;
      pad.Q.value = 0.5;
      pad.connect(ctx.destination);
      for (const c of o.chords) {
        const end = Math.min(b0, c.start + c.duration);
        if (end <= a0 || c.start >= b0) continue;
        const a = at + Math.max(0, c.start - a0);
        const b = at + (end - a0);
        // Pad: two slightly detuned saws per chord tone.
        for (const m of c.voicing) {
          for (const det of [-6, 6]) {
            this.tone(ctx, pad, 'sawtooth', mtof(m, o.backingTuningCents + det), a, b, 0.035, 0.04, 0.2);
          }
        }
        // Bass: root on beat 1, re-struck halfway through a full-bar chord.
        const half = c.duration / 2;
        const hits = c.duration > 1.2 ? [0, half] : [0];
        hits.forEach((off, k) => {
          if (c.start + off < a0 || c.start + off >= b0) return;
          const s = at + (c.start + off - a0);
          const e = k === hits.length - 1 ? b : at + (Math.min(b0, c.start + half) - a0);
          this.tone(ctx, ctx.destination, 'triangle', mtof(c.bass, o.backingTuningCents), s, e - 0.02, 0.32, 0.008, 0.08);
        });
      }
    }

    if (o.comp?.length) {
      // The montuno: the same electric piano, but bright, dry and stabbed short. The bass is its left hand, held.
      const bus = ctx.createBiquadFilter();
      bus.type = 'lowpass';
      bus.frequency.value = o.keysTone ?? 5200;
      bus.Q.value = 0.4;
      const drive = ctx.createWaveShaper();
      drive.curve = this.warmCurve();
      drive.oversample = '2x';
      const level = ctx.createGain();
      level.gain.value = this.keysLevel() * 0.8;
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -8;
      limit.knee.value = 6;
      limit.ratio.value = 12;
      limit.attack.value = 0.003;
      limit.release.value = 0.15;
      const verb = ctx.createConvolver();
      verb.buffer = this.roomImpulse(ctx);
      const wet = ctx.createGain();
      wet.gain.value = 0.12;
      bus.connect(drive).connect(level).connect(limit).connect(ctx.destination);
      drive.connect(verb).connect(wet).connect(level);
      for (const n of o.comp) {
        if (n.start < a0 || n.start >= b0) continue;
        const t = at + (n.start - a0) + Math.random() * 0.006;
        const vel = Math.max(0.12, Math.min(1, n.velocity * (0.9 + 0.2 * Math.random())));
        this.rhodes(ctx, bus, mtof(n.midi, o.backingTuningCents), t, t + n.duration, vel, n.bass ? 0.16 : 0.07);
      }
    }

    if (o.click) {
      for (const b of beatTimes(o.bpm, o.firstBeatMs, this.duration)) {
        if (b.time < a0 || b.time >= b0) continue;
        const t = at + (b.time - a0);
        const down = ((b.index % o.beatsPerBar) + o.beatsPerBar) % o.beatsPerBar === 0;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = down ? 1760 : 1100;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(o.clickGain * (down ? 1 : 0.7), t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
        osc.connect(g).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.06);
        nodes.push(osc);
      }
    }

  }

  /** Short audition blip for note editing (independent of playback). */
  async preview(midi: number, tuningCents: number): Promise<void> {
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    const t = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = mtof(midi, tuningCents);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.36);
  }

  /** Audition a chord on the soft keys (independent of playback). */
  async previewChord(voicing: number[], bass: number, tuningCents: number): Promise<void> {
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    const t = ctx.currentTime + 0.02;
    const keep = this.nodes;
    this.nodes = [];
    voicing.forEach((m, k) => this.rhodes(ctx, ctx.destination, mtof(m, tuningCents), t + k * 0.02, t + 0.9, 0.8));
    this.rhodes(ctx, ctx.destination, mtof(bass, tuningCents), t, t + 0.9, 0.9);
    this.nodes = keep;
  }

  private noise: AudioBuffer | null = null;
  private room: AudioBuffer | null = null;

  /** Stereo decaying-noise impulse: a soft ~2 s room. */
  private roomImpulse(ctx: AudioContext): AudioBuffer {
    if (this.room && this.room.sampleRate === ctx.sampleRate) return this.room;
    const len = Math.round(2.2 * ctx.sampleRate);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let seed = 12345 + ch * 777;
      for (let i = 0; i < len; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const t = i / ctx.sampleRate;
        d[i] = ((seed / 4294967296) * 2 - 1) * Math.exp(-t / 0.5) * Math.min(1, t / 0.01);
      }
    }
    this.room = buf;
    return buf;
  }

  private warm: Float32Array<ArrayBuffer> | null = null;

  /** Gentle tube-style saturation: rounds the peaks and adds a little warmth. */
  private warmCurve(): Float32Array<ArrayBuffer> {
    if (this.warm) return this.warm;
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
    }
    this.warm = curve;
    return curve;
  }

  /**
   * One electric-piano note, built so it never sits still like a held sine:
   *  - it decays the whole time it is held, like a real tine (quick settle, then a long fade);
   *  - two tines a few cents apart, left and right, beat slowly against each other;
   *  - each note is tuned a hair differently and wavers very slowly in pitch;
   *  - the FM "bark" settles to a body that keeps some overtones;
   *  - a soft triangle underneath starts bright and closes, giving weight;
   *  - notes in the upper middle (where a pure tone bites the ear) are played softer.
   */
  private rhodes(ctx: AudioContext, dest: AudioNode, hz: number, start: number, end: number, vel: number, release = 0.7): void {
    const balance = hz > 330 ? Math.pow(330 / hz, 0.45) : 1;
    const peak = 0.075 * vel * balance;
    const hold = Math.max(start + 0.05, end);
    const stop = hold + release * 4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.02);
    env.gain.setTargetAtTime(peak * 0.5, start + 0.02, 0.22);
    if (hold > start + 0.6) env.gain.setTargetAtTime(peak * 0.1, start + 0.6, 1.7);
    env.gain.setTargetAtTime(0, hold, release);
    env.connect(dest);
    const oscs: OscillatorNode[] = [];
    // A slow, shallow waver in pitch, different for every note.
    const waver = ctx.createOscillator();
    waver.frequency.value = 0.3 + Math.random() * 0.5;
    const waverDepth = ctx.createGain();
    waverDepth.gain.value = 2 + Math.random() * 2; // cents
    waver.connect(waverDepth);
    oscs.push(waver);
    const off = (Math.random() - 0.5) * 5; // cents: no two notes tuned exactly alike
    for (const [cents, pan] of [
      [-5, -0.4],
      [5, 0.4],
    ]) {
      const f = hz * Math.pow(2, (cents + off) / 1200);
      const car = ctx.createOscillator();
      car.frequency.value = f;
      const mod = ctx.createOscillator();
      mod.frequency.value = f;
      waverDepth.connect(car.detune);
      waverDepth.connect(mod.detune);
      const index = ctx.createGain();
      // Harder touch = more bark; it settles to a body with overtones left in it, then mellows.
      index.gain.setValueAtTime(f * (0.5 + 0.9 * vel), start);
      index.gain.setTargetAtTime(f * 0.45, start, 0.25);
      index.gain.setTargetAtTime(f * 0.28, start + 0.7, 1.5);
      mod.connect(index).connect(car.frequency);
      const side = ctx.createStereoPanner();
      side.pan.value = pan;
      const half = ctx.createGain();
      half.gain.value = 0.5;
      car.connect(half).connect(side).connect(env);
      oscs.push(car, mod);
    }
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.value = hz;
    waverDepth.connect(body.detune);
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.setValueAtTime(Math.min(2400, hz * 5), start);
    soft.frequency.setTargetAtTime(Math.min(1100, hz * 2), start, 0.5);
    const weight = ctx.createGain();
    weight.gain.value = 0.35;
    body.connect(soft).connect(weight).connect(env);
    oscs.push(body);
    for (const n of oscs) {
      n.start(start);
      n.stop(stop);
      this.nodes.push(n);
    }
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise && this.noise.sampleRate === ctx.sampleRate) return this.noise;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  /** Sustained oscillator voice with attack / release envelope. */
  private tone(
    ctx: AudioContext,
    dest: AudioNode,
    type: OscillatorType,
    hz: number,
    start: number,
    end: number,
    level: number,
    attack: number,
    release: number,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz;
    const g = ctx.createGain();
    const hold = Math.max(start + attack, end);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(level, start + attack);
    g.gain.setValueAtTime(level, hold);
    g.gain.linearRampToValueAtTime(0, hold + release);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(hold + release + 0.02);
    this.nodes.push(osc);
  }

  /** One hit of the lo-fi kit: soft thud of a kick, a dusty snare, short muffled hats. Never quite the same twice. */
  private lofiDrum(ctx: AudioContext, dest: AudioNode, h: DrumHit, t: number): void {
    const v = h.velocity * (0.88 + 0.24 * Math.random());
    const when = t + (Math.random() - 0.3) * 0.006; // a little loose, leaning late
    const noise = (): AudioBufferSourceNode => {
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuffer(ctx);
      n.loopStart = Math.random() * 0.5;
      return n;
    };
    if (h.kind === 'kick') {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(96, when);
      osc.frequency.exponentialRampToValueAtTime(40, when + 0.11);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.95 * v, when + 0.006);
      g.gain.setTargetAtTime(0, when + 0.035, 0.11);
      osc.connect(g).connect(dest);
      osc.start(when);
      osc.stop(when + 0.7);
      const click = noise();
      const cb = ctx.createBiquadFilter();
      cb.type = 'bandpass';
      cb.frequency.value = 2800;
      cb.Q.value = 1;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.1 * v, when);
      cg.gain.setTargetAtTime(0, when, 0.004);
      click.connect(cb).connect(cg).connect(dest);
      click.start(when, Math.random() * 0.5);
      click.stop(when + 0.05);
      this.nodes.push(osc, click);
    } else if (h.kind === 'snare') {
      const n = noise();
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1700 + Math.random() * 300;
      band.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.5 * v, when + 0.004);
      g.gain.setTargetAtTime(0, when + 0.01, 0.06);
      n.connect(band).connect(g).connect(dest);
      n.start(when, Math.random() * 0.5);
      n.stop(when + 0.4);
      const body = ctx.createOscillator();
      body.type = 'triangle';
      body.frequency.setValueAtTime(210, when);
      body.frequency.exponentialRampToValueAtTime(165, when + 0.08);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.28 * v, when);
      bg.gain.setTargetAtTime(0, when, 0.045);
      body.connect(bg).connect(dest);
      body.start(when);
      body.stop(when + 0.3);
      const top = noise();
      const hi = ctx.createBiquadFilter();
      hi.type = 'highpass';
      hi.frequency.value = 4800;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0, when);
      tg.gain.linearRampToValueAtTime(0.2 * v, when + 0.002);
      tg.gain.setTargetAtTime(0, when + 0.004, 0.03);
      top.connect(hi).connect(tg).connect(dest);
      top.start(when, Math.random() * 0.5);
      top.stop(when + 0.25);
      this.nodes.push(n, body, top);
    } else {
      const n = noise();
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = 8600;
      hp.Q.value = 0.9;
      const g = ctx.createGain();
      const open = h.kind === 'openhat';
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.22 * v, when + 0.002);
      g.gain.setTargetAtTime(0, when + 0.004, open ? 0.07 : 0.018);
      n.connect(hp).connect(g).connect(dest);
      n.start(when, Math.random() * 0.5);
      n.stop(when + (open ? 0.5 : 0.15));
      this.nodes.push(n);
    }
  }

  /** One hit of the Latin percussion: clave, congas (open tone / slap), cáscara, shaker, bell, timbale. */
  private latinDrum(ctx: AudioContext, dest: AudioNode, h: DrumHit, t: number): void {
    if (h.kind === 'kick' || h.kind === 'snare' || h.kind === 'hat' || h.kind === 'openhat') {
      this.lofiDrum(ctx, dest, h, t);
      return;
    }
    const v = h.velocity * (0.9 + 0.2 * Math.random());
    const when = t + (Math.random() - 0.5) * 0.004;
    /** A burst of filtered noise: [filter type, Hz, Q, level, attack s, decay time-constant s]. */
    const burst = (type: BiquadFilterType, hz: number, q: number, level: number, attack: number, decay: number): void => {
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuffer(ctx);
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(level * v, when + attack);
      g.gain.setTargetAtTime(0, when + attack, decay);
      n.connect(f).connect(g).connect(dest);
      n.start(when, Math.random() * 0.5);
      n.stop(when + attack + decay * 7 + 0.02);
      this.nodes.push(n);
    };
    /** A pitched knock: [wave, Hz at the hit, Hz it settles to, level, decay time-constant s]. */
    const knock = (type: OscillatorType, hz: number, to: number, level: number, decay: number): void => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(hz, when);
      osc.frequency.exponentialRampToValueAtTime(to, when + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(level * v, when + 0.002);
      g.gain.setTargetAtTime(0, when + 0.004, decay);
      osc.connect(g).connect(dest);
      osc.start(when);
      osc.stop(when + decay * 7 + 0.03);
      this.nodes.push(osc);
    };
    if (h.kind === 'clave') {
      knock('sine', 2500, 2450, 0.34, 0.022);
      knock('triangle', 5000, 4900, 0.05, 0.008);
    } else if (h.kind === 'conga') {
      knock('sine', 245 + Math.random() * 6, 205, 0.6, 0.085);
      burst('bandpass', 1300, 1.2, 0.12, 0.002, 0.012);
    } else if (h.kind === 'slap') {
      burst('bandpass', 1150, 1.6, 0.55, 0.001, 0.022);
      knock('sine', 420, 340, 0.2, 0.02);
    } else if (h.kind === 'shell') {
      burst('bandpass', 3900, 3.5, 0.5, 0.001, 0.012);
      knock('triangle', 1900, 1850, 0.07, 0.01);
    } else if (h.kind === 'shaker') {
      burst('highpass', 6500, 0.7, 0.11, 0.012, 0.022);
    } else if (h.kind === 'cowbell') {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 820;
      band.Q.value = 2.2;
      band.connect(dest);
      const keep = dest;
      dest = band;
      knock('square', 545, 545, 0.16, 0.05);
      knock('square', 815, 815, 0.16, 0.05);
      dest = keep;
    } else {
      // timbale
      knock('sine', 340, 300, 0.5, 0.11);
      knock('sine', 610, 560, 0.14, 0.07);
      burst('bandpass', 2600, 1, 0.3, 0.001, 0.018);
    }
  }

  private drum(ctx: AudioContext, dest: AudioNode, h: DrumHit, t: number): void {
    const v = h.velocity;
    if (h.kind === 'kick') {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.connect(g).connect(dest);
      osc.start(t);
      osc.stop(t + 0.36);
      this.nodes.push(osc);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    const filt = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const decay = h.kind === 'snare' ? 0.18 : h.kind === 'openhat' ? 0.22 : 0.045;
    filt.type = h.kind === 'snare' ? 'bandpass' : 'highpass';
    filt.frequency.value = h.kind === 'snare' ? 1800 : 7000;
    const level = h.kind === 'snare' ? 0.7 * v : 0.35 * v;
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(filt).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay + 0.01);
    this.nodes.push(src);
    if (h.kind === 'snare') {
      // Body of the snare.
      const osc = ctx.createOscillator();
      const og = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 185;
      og.gain.setValueAtTime(0.45 * v, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.connect(og).connect(dest);
      osc.start(t);
      osc.stop(t + 0.1);
      this.nodes.push(osc);
    }
  }

  stop(keepPosition = true): void {
    this.stopRain();
    if (this.playing && keepPosition) this.stopped = this.position;
    if (this.timer) {
      clearInterval(this.timer);
      clearTimeout(this.timer);
    }
    this.timer = null;
    for (const seg of this.segments) {
      for (const n of seg.nodes) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
        n.disconnect();
      }
    }
    this.segments = [];
    this.playing = false;
  }

  seek(sec: number): void {
    this.stopped = Math.max(0, sec);
  }
}
