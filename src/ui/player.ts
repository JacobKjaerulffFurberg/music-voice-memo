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
}

export class Player {
  private ctx: AudioContext | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private startCtxTime = 0;
  private startOffset = 0;
  private duration = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  playing = false;
  onEnded: (() => void) | null = null;

  private context(): AudioContext {
    this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
    return this.ctx;
  }

  get position(): number {
    if (!this.playing || !this.ctx) return this.startOffset;
    const elapsed = Math.max(0, this.ctx.currentTime - this.startCtxTime);
    return Math.min(this.duration, this.startOffset + elapsed);
  }

  async play(samples: Float32Array, sampleRate: number, o: PlayOptions): Promise<void> {
    this.stop();
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    this.duration = samples.length / sampleRate;
    const from = Math.max(0, Math.min(o.from, this.duration));
    const t0 = ctx.currentTime + 0.05;

    if (o.voice) {
      const buf = ctx.createBuffer(1, samples.length, sampleRate);
      buf.copyToChannel(new Float32Array(samples), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(t0, from);
      this.nodes.push(src);
    }

    if (o.notes.length > 0) {
      // Simple monophonic synth: triangle + quiet sine an octave up, low-passed, ADSR.
      const bus = ctx.createBiquadFilter();
      bus.type = 'lowpass';
      bus.frequency.value = 3000;
      bus.connect(ctx.destination);
      for (const n of o.notes) {
        const end = n.start + n.duration;
        if (end <= from) continue;
        const startAt = t0 + Math.max(0, n.start - from);
        const stopAt = t0 + (end - from);
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
          this.nodes.push(osc);
        }
      }
    }

    if (o.drums.length > 0) {
      const bus = ctx.createGain();
      bus.gain.value = 0.55;
      bus.connect(ctx.destination);
      for (const h of o.drums) {
        if (h.time < from) continue;
        this.drum(ctx, bus, h, t0 + (h.time - from));
      }
    }

    if (o.chords.length > 0) {
      const pad = ctx.createBiquadFilter();
      pad.type = 'lowpass';
      pad.frequency.value = 1400;
      pad.Q.value = 0.5;
      pad.connect(ctx.destination);
      for (const c of o.chords) {
        const end = c.start + c.duration;
        if (end <= from) continue;
        const a = t0 + Math.max(0, c.start - from);
        const b = t0 + (end - from);
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
          if (c.start + off < from) return;
          const s = t0 + (c.start + off - from);
          const e = k === hits.length - 1 ? b : t0 + (c.start + half - from);
          this.tone(ctx, ctx.destination, 'triangle', mtof(c.bass, o.backingTuningCents), s, e - 0.02, 0.32, 0.008, 0.08);
        });
      }
    }

    if (o.click) {
      for (const b of beatTimes(o.bpm, o.firstBeatMs, this.duration)) {
        if (b.time < from) continue;
        const t = t0 + (b.time - from);
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
        this.nodes.push(osc);
      }
    }

    this.startCtxTime = t0;
    this.startOffset = from;
    this.playing = true;
    this.endTimer = setTimeout(() => {
      this.stop(false);
      this.startOffset = 0;
      this.onEnded?.();
    }, (this.duration - from) * 1000 + 100);
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

  private noise: AudioBuffer | null = null;

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
    if (this.playing && keepPosition) this.startOffset = this.position;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
      n.disconnect();
    }
    this.nodes = [];
    this.playing = false;
  }

  seek(sec: number): void {
    this.startOffset = Math.max(0, sec);
  }
}
