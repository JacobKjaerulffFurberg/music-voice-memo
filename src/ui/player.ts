/** Playback of a recording with an optional click track on the beat grid. */

import { beatTimes } from '../model';
import type { Chord, DrumHit } from '../music/arrange';

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

  private voiceIn: { ctx: AudioContext; node: AudioNode } | null = null;

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
    this.duration = samples.length / sampleRate;
    const loop = o.loop && o.loop.end - o.loop.start >= 0.05 ? { start: Math.max(0, o.loop.start), end: Math.min(this.duration, o.loop.end) } : null;
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

    if (o.drums.length > 0) {
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
      bus.frequency.value = 3400;
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
      bus.connect(drive).connect(sway);
      sway.connect(dry).connect(ctx.destination);
      sway.connect(verb).connect(wet).connect(ctx.destination);
      // Bass: a round, filtered tone instead of a bare sine.
      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = 320;
      low.connect(ctx.destination);
      const beat = 60 / o.bpm;
      o.chords.forEach((c, ci) => {
        const end = Math.min(b0, c.start + c.duration);
        if (end <= a0 || c.start >= b0) return;
        const b = at + (end - a0);
        // The same chord always gets the same "hand": repeatable, but never two alike in a row.
        const rnd = (k: number): number => {
          const x = Math.sin((ci + 1) * 127.1 + k * 311.7) * 43758.5453;
          return x - Math.floor(x);
        };
        const hz = (m: number): number => mtof(m, o.backingTuningCents);
        const touch = (m: number, t: number, vel: number): void => {
          if (t < a0 || t >= b0) return;
          this.rhodes(ctx, bus, hz(m), at + (t - a0), b, vel);
        };
        // Rolled, not struck: the bass leads, then the hand unfolds low to high with
        // uneven gaps, the top note a touch louder so the chord sings.
        const gap = 0.034 + 0.03 * rnd(0);
        const top = c.voicing.length - 1;
        c.voicing.forEach((m, k) => {
          touch(m, c.start + 0.02 + k * gap + rnd(k + 1) * 0.014, k === top ? 0.82 : 0.55 + 0.14 * rnd(k + 7));
        });
        // On a long chord the hand comes back: a soft re-touch of the upper notes off the beat.
        if (c.duration >= 3.2 * beat) {
          const t2 = c.start + 2.5 * beat + rnd(20) * 0.02;
          c.voicing.slice(-2).forEach((m, k) => touch(m, t2 + k * 0.03, 0.36 + 0.08 * rnd(k + 30)));
        } else if (c.duration >= 1.8 * beat) {
          touch(c.voicing[top], c.start + 1.5 * beat + rnd(21) * 0.02, 0.34);
        }
        if (c.start >= a0) {
          const st = at + (c.start - a0);
          this.tone(ctx, low, 'triangle', hz(c.bass), st, b, 0.3, 0.04, 0.6);
          this.tone(ctx, low, 'sine', hz(c.bass), st, b, 0.12, 0.04, 0.6);
        }
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
    this.tone(ctx, ctx.destination, 'sine', mtof(bass, tuningCents), t, t + 0.9, 0.25, 0.02, 0.4);
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
   * One electric-piano note. Two tines a few cents apart, left and right, so the
   * note shimmers slowly instead of sitting still like a sine; their FM "bark"
   * settles to a warm body rather than fading to a pure tone; a soft low-passed
   * triangle underneath gives the note weight. Soft attack, no metallic ping.
   */
  private rhodes(ctx: AudioContext, dest: AudioNode, hz: number, start: number, end: number, vel: number): void {
    const peak = 0.07 * vel;
    const release = 0.75;
    const hold = Math.max(start + 0.05, end);
    const stop = hold + release * 4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.016);
    env.gain.setTargetAtTime(peak * 0.45, start + 0.016, 0.9);
    env.gain.setTargetAtTime(0, hold, release);
    env.connect(dest);
    const oscs: OscillatorNode[] = [];
    for (const [cents, pan] of [
      [-5, -0.4],
      [5, 0.4],
    ]) {
      const f = hz * Math.pow(2, cents / 1200);
      const car = ctx.createOscillator();
      car.frequency.value = f;
      const mod = ctx.createOscillator();
      mod.frequency.value = f;
      const index = ctx.createGain();
      // Harder touch = more bark; it settles to a warm, slightly hollow body.
      index.gain.setValueAtTime(f * (0.5 + 0.9 * vel), start);
      index.gain.setTargetAtTime(f * 0.24, start, 0.2);
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
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = Math.min(1600, hz * 3);
    const weight = ctx.createGain();
    weight.gain.value = 0.4;
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
