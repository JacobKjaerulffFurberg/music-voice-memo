/** Playback of a recording with an optional click track on the beat grid. */

import { stayAwake } from '../awake';
import { beatTimes } from '../model';
import type { Chord, DrumHit } from '../music/arrange';
import type { CompNote } from '../music/groove';

/**
 * Phones get a lighter sound engine: every room shares one mono-in reverb instead of each part
 * having its own. That is the big saving; the piano's touch, the drive and the room's length
 * stay as on a laptop, so it sounds the same.
 * `?lite=1` / `?lite=0` in the address forces it on or off.
 */
export const LITE = ((): boolean => {
  if (typeof navigator === 'undefined' || typeof location === 'undefined') return false;
  const force = new URLSearchParams(location.search).get('lite');
  if (force === '1' || force === '0') return force === '1';
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
})();

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
  /** How dark the lo-fi kit is, 0–1: muffled, tuned down, the hats tucked away. Default 0. */
  drumDark?: number;
  /** An echo on the recorded voice, 0–1: dull repeats, three quarters of a beat apart. Default 0. */
  voiceEcho?: number;
  /** How loud the band is next to the voice (1 = normal). Keys, guitar and pads follow it fully, the drums about half as much. */
  backing?: number;
  /** Written-out piano + bass part (the Latin montuno), played short and bright instead of `chords`. */
  comp?: CompNote[];
  /** What plays `comp`: the electric piano (default), a nylon-guitar pluck, or slow pads. */
  compSound?: 'keys' | 'pluck' | 'pad';
  /** Layers sung over the take: each plays at its place on the take's timeline, through the voice chain. */
  layers?: { samples: Float32Array; sampleRate: number; start: number }[];
  /** How bright the floaty keys are (low-pass, Hz). Default 2800. */
  keysTone?: number;
  /** How much the piano does: 0 = one soft touch per chord, 1 = normal (default), 2 = busier, fills the space. */
  keysFeel?: number;
  /**
   * Dust, 0–1: how worn the whole thing sounds. Vinyl crackle, a slow tape wobble in the pitch,
   * a duller top end, and the band ducking a little under each kick.
   */
  dust?: number;
  /** Voice effects turned up: 0 as set, 1 a bit of room and echo, 2 that and a narrow lo-fi voice. */
  voiceFx?: number;
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

  /** The context that plays out loud. */
  private live(): AudioContext {
    // 'playback': bigger audio buffers. Phones can't keep up with tiny ones and the sound crackles;
    // the extra delay is reported in `latency`, so layers still line up.
    // Always the phone's own sample rate: asking for another one (while the mic is open at its rate)
    // left some phones silent. A context the phone has closed is replaced; everything built on it
    // is keyed to the context and rebuilds itself.
    if (this.ctx?.state === 'closed') this.ctx = null;
    this.ctx ??= new AudioContext({ latencyHint: 'playback' });
    return this.ctx;
  }

  /** While a file is being rendered: the offline context it is rendered in. */
  private rendering: OfflineAudioContext | null = null;

  /** Where sound is being scheduled: the file being rendered, else the speakers. */
  private context(): BaseAudioContext {
    return this.rendering ?? this.live();
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

  private voiceBuffer(ctx: BaseAudioContext): AudioBuffer {
    const samples = this.samples as Float32Array;
    if (this.buffer?.for !== samples || this.buffer.buf.sampleRate !== this.sampleRate) {
      const buf = ctx.createBuffer(1, samples.length, this.sampleRate);
      buf.copyToChannel(new Float32Array(samples), 0);
      this.buffer = { for: samples, buf };
    }
    return this.buffer.buf;
  }

  // ---------------------------------------------------------------- master + dust

  private master: { ctx: BaseAudioContext; input: GainNode; wow: GainNode; flutter: GainNode; top: BiquadFilterNode } | null = null;
  private dust = 0;
  private crackle: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private crackleBuf: AudioBuffer | null = null;

  /**
   * Where every sound goes: one chain before the speakers. A few milliseconds of delay whose
   * length drifts slowly (tape wow, plus a faint flutter) and a low-pass for the top end.
   * With no dust both do nothing.
   */
  private out(ctx: BaseAudioContext): AudioNode {
    if (this.master?.ctx === ctx) return this.master.input;
    const input = ctx.createGain();
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.006;
    const lfo = (hz: number): GainNode => {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz;
      const depth = ctx.createGain();
      depth.gain.value = 0;
      osc.connect(depth).connect(delay.delayTime);
      osc.start();
      return depth;
    };
    const top = ctx.createBiquadFilter();
    top.type = 'lowpass';
    top.frequency.value = 18000;
    top.Q.value = 0.5;
    // A safety limiter last: when everything lands at once it is squeezed instead of clipping (the
    // harsh crunch). The trim takes back the compressor's built-in make-up gain (~+1.7 dB).
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -3;
    limit.knee.value = 3;
    limit.ratio.value = 20;
    limit.attack.value = 0.002;
    limit.release.value = 0.12;
    const trim = ctx.createGain();
    trim.gain.value = 0.82;
    input.connect(delay).connect(top).connect(limit).connect(trim).connect(ctx.destination);
    this.master = { ctx, input, wow: lfo(0.55), flutter: lfo(6.3), top };
    this.applyDust(ctx);
    return input;
  }

  /** Change the dust while it plays. */
  setDust(dust: number): void {
    this.dust = Math.max(0, Math.min(1, dust));
    if (this.ctx) this.applyDust(this.ctx);
  }

  private applyDust(ctx: BaseAudioContext): void {
    const m = this.master;
    const d = this.dust;
    const t = ctx.currentTime;
    if (m) {
      // Pitch moves by the speed the delay changes at: about ±9 cents of wow and ±3 of flutter at full dust.
      m.wow.gain.setTargetAtTime(0.0016 * d, t, 0.1);
      m.flutter.gain.setTargetAtTime(0.00004 * d, t, 0.1);
      m.top.frequency.setTargetAtTime(18000 * Math.pow(4200 / 18000, d), t, 0.1);
    }
    if (this.crackle) this.crackle.gain.gain.setTargetAtTime(0.085 * d, t, 0.1);
  }

  /** Six seconds of an old record: sparse little ticks, a pop now and then, a breath of hiss. */
  private crackleBuffer(ctx: BaseAudioContext): AudioBuffer {
    if (this.crackleBuf && this.crackleBuf.sampleRate === ctx.sampleRate) return this.crackleBuf;
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(1, Math.round(6 * sr), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.02;
    const tick = (at: number, amp: number, len: number): void => {
      for (let k = 0; k < len && at + k < d.length; k++) d[at + k] += amp * (k % 2 ? -1 : 1) * Math.exp((-4 * k) / len);
    };
    for (let i = 0; i < d.length; i++) {
      if (Math.random() < 16 / sr) tick(i, Math.pow(Math.random(), 3) * 0.7 + 0.05, 6 + Math.floor(Math.random() * 30));
      if (Math.random() < 0.7 / sr) tick(i, 0.9, 50 + Math.floor(Math.random() * 60));
    }
    this.crackleBuf = buf;
    return buf;
  }

  private startCrackle(ctx: BaseAudioContext): void {
    if (this.crackle || this.dust <= 0) return;
    const src = ctx.createBufferSource();
    src.buffer = this.crackleBuffer(ctx);
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 700;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.setTargetAtTime(0.085 * this.dust, ctx.currentTime, 0.2);
    src.connect(hp).connect(lp).connect(gain).connect(ctx.destination);
    src.start(ctx.currentTime, Math.random() * 5);
    this.crackle = { src, gain };
  }

  private stopCrackle(): void {
    const c = this.crackle;
    const ctx = this.ctx;
    if (!c || !ctx) return;
    this.crackle = null;
    c.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    setTimeout(() => {
      try {
        c.src.stop();
      } catch {
        // already stopped
      }
      c.src.disconnect();
    }, 600);
  }

  // ---------------------------------------------------------------- sampled kit

  private kit: Promise<Record<string, AudioBuffer[]> | null> | null = null;
  private kitNow: Record<string, AudioBuffer[]> | null = null;
  private lastHit: Record<string, number> = {};

  /**
   * The drum kit is real recordings (public/sounds/kit, Virtuosity Drums' close mics, CC0; the snare is the damped one):
   * a few takes of each drum so no two hits in a row are the same. Loaded once and levelled.
   * No files, or a format this browser can't decode: the synthesized kit plays instead.
   */
  private loadKit(ctx: BaseAudioContext): Promise<Record<string, AudioBuffer[]> | null> {
    this.kit ??= (async () => {
      const files: Record<string, string[]> = {
        kick: ['kick1', 'kick2', 'kick3'],
        snare: ['snare1', 'snare2', 'snare3'],
        ghost: ['ghost'],
        rim: ['rim'],
        hat: ['hat1', 'hat2', 'hat3'],
        open: ['open'],
      };
      try {
        const out: Record<string, AudioBuffer[]> = {};
        for (const [kind, names] of Object.entries(files)) {
          out[kind] = await Promise.all(
            names.map(async (name) => {
              const res = await fetch(new URL(`./sounds/kit/${name}.flac`, document.baseURI));
              if (!res.ok) throw new Error(name);
              const buf = await ctx.decodeAudioData(await res.arrayBuffer());
              let peak = 0;
              for (let ch = 0; ch < buf.numberOfChannels; ch++) for (const v of buf.getChannelData(ch)) peak = Math.max(peak, Math.abs(v));
              if (peak > 1e-4) for (let ch = 0; ch < buf.numberOfChannels; ch++) buf.getChannelData(ch).forEach((v, i, a) => (a[i] = v / peak));
              return buf;
            }),
          );
        }
        this.kitNow = out;
        return out;
      } catch {
        return null;
      }
    })();
    return this.kit;
  }

  /** Play a hit from the sampled kit. False if this kind of hit has no sample (or the kit isn't there). */
  private sampleHit(ctx: BaseAudioContext, dest: AudioNode, h: DrumHit, when: number, v: number): boolean {
    const kit = this.kitNow;
    const kind =
      h.kind === 'kick' ? 'kick' : h.kind === 'snare' ? (h.velocity >= 0.5 ? 'snare' : 'ghost') : h.kind === 'hat' ? 'hat' : h.kind === 'openhat' ? 'open' : h.kind === 'shell' ? 'rim' : null;
    const takes = kind && kit ? kit[kind] : null;
    if (!kind || !takes?.length) return false;
    let i = Math.floor(Math.random() * takes.length);
    if (takes.length > 1 && i === this.lastHit[kind]) i = (i + 1) % takes.length;
    this.lastHit[kind] = i;
    const src = ctx.createBufferSource();
    src.buffer = takes[i];
    // Lo-fi: the tape runs a hair slow, so the kit sits a little lower.
    // A dark kit runs slower still (about two semitones down) and keeps its hats in the background.
    const dark = this.opts?.drumStyle === 'lofi' ? Math.max(0, Math.min(1, this.opts.drumDark ?? 0)) : 0;
    src.playbackRate.value = (this.opts?.drumStyle === 'lofi' ? 0.97 : 1) * (1 - 0.11 * dark) * (1 + (Math.random() - 0.5) * 0.02);
    const tuck = kind === 'hat' || kind === 'open' ? 1 - 0.45 * dark : kind === 'snare' ? 1 - 0.2 * dark : 1;
    const level = ({ kick: 1, snare: 0.62, ghost: 0.42, rim: 0.26, hat: 0.3, open: 0.24 } as Record<string, number>)[kind] * Math.pow(v, 1.2) * tuck;
    // Every drum is cut short: the hit, then out, before the shell and the room start to ring.
    const [hold, fade] = ({ kick: [0.12, 0.09], snare: [0.09, 0.08], ghost: [0.05, 0.05], rim: [0.04, 0.05], hat: [0.04, 0.04], open: [0.14, 0.1] } as Record<string, [number, number]>)[kind];
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, when);
    g.gain.setTargetAtTime(0, when + hold, fade);
    src.connect(g).connect(dest);
    src.start(when);
    this.nodes.push(src);
    return true;
  }

  // ---------------------------------------------------------------- sampled piano

  private keys: Promise<{ midi: number; buf: AudioBuffer }[] | null> | null = null;
  private keysNow: { midi: number; buf: AudioBuffer }[] | null = null;

  /**
   * The keys are a real piano played softly with the soft pedal down (public/sounds/keys,
   * Osiris Piano, CC0): one recording every fourth or fifth, the notes in between are the
   * nearest one tuned up or down. No files: the synthesized electric piano plays instead.
   */
  private loadKeys(ctx: BaseAudioContext): Promise<{ midi: number; buf: AudioBuffer }[] | null> {
    this.keys ??= (async () => {
      try {
        const out = await Promise.all(
          [36, 43, 50, 57, 64, 71, 77, 84].map(async (midi) => {
            const res = await fetch(new URL(`./sounds/keys/${midi}.flac`, document.baseURI));
            if (!res.ok) throw new Error(String(midi));
            const buf = await ctx.decodeAudioData(await res.arrayBuffer());
            let peak = 0;
            for (let ch = 0; ch < buf.numberOfChannels; ch++) for (const v of buf.getChannelData(ch)) peak = Math.max(peak, Math.abs(v));
            if (peak > 1e-4) for (let ch = 0; ch < buf.numberOfChannels; ch++) buf.getChannelData(ch).forEach((v, i, a) => (a[i] = v / peak));
            return { midi, buf };
          }),
        );
        this.keysNow = out;
        return out;
      } catch {
        return null;
      }
    })();
    return this.keys;
  }

  /** One piano note from the recordings. It rings and dies away by itself; letting go damps it. False if the piano isn't loaded. */
  private pianoNote(ctx: BaseAudioContext, dest: AudioNode, hz: number, start: number, end: number, vel: number, release: number): boolean {
    const keys = this.keysNow;
    if (!keys?.length) return false;
    const midi = 69 + 12 * Math.log2(hz / 440);
    let s = keys[0];
    for (const k of keys) if (Math.abs(k.midi - midi) < Math.abs(s.midi - midi)) s = k;
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = Math.pow(2, (midi - s.midi) / 12);
    const balance = hz > 330 ? Math.pow(330 / hz, 0.3) : 1;
    const peak = 0.3 * vel * balance;
    const hold = Math.max(start + 0.05, end);
    const damp = Math.max(0.1, release * 0.5);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.004);
    env.gain.setTargetAtTime(0, hold, damp);
    // A softer touch is also a darker one.
    const touch = ctx.createBiquadFilter();
    touch.type = 'lowpass';
    touch.frequency.value = 900 + 5200 * vel;
    src.connect(touch).connect(env).connect(dest);
    src.start(start);
    src.stop(hold + damp * 6 + 0.1);
    this.nodes.push(src);
    return true;
  }

  private layerBuffers = new WeakMap<Float32Array, AudioBuffer>();

  private layerBuffer(ctx: BaseAudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
    let buf = this.layerBuffers.get(samples);
    if (!buf) {
      buf = ctx.createBuffer(1, samples.length, sampleRate);
      buf.copyToChannel(new Float32Array(samples), 0);
      this.layerBuffers.set(samples, buf);
    }
    return buf;
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
  private loadRain(ctx: BaseAudioContext): Promise<AudioBuffer | null> {
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

  private startRain(ctx: BaseAudioContext): void {
    const level = 0.4; // well under the music: there, but not in the way
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
      src.connect(gain).connect(this.out(ctx));
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

  private voiceIn: { ctx: BaseAudioContext; node: AudioNode } | null = null;
  private voiceWet: GainNode | null = null;
  private voiceEcho: { send: GainNode; delay: DelayNode } | null = null;
  private voiceTone: { low: BiquadFilterNode; high: BiquadFilterNode; gain: GainNode } | null = null;

  /**
   * A light polish on the recorded voice, barely there on purpose: rumble cut,
   * a little less boxiness, a touch of air, gentle levelling, and a whisper of
   * the same room the keys sit in.
   */
  private voiceBus(ctx: BaseAudioContext): AudioNode {
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
    // The lo-fi voice: open unless voiceFx asks for it narrow.
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 20;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 20000;
    input.connect(rumble).connect(box).connect(air).connect(high).connect(low).connect(level).connect(makeup).connect(this.out(ctx));
    this.voiceTone = { low, high, gain: makeup };
    const room = LITE ? this.sharedRoom(ctx) : this.roomNode(ctx);
    if (!LITE) room.connect(this.out(ctx));
    const wet = ctx.createGain();
    wet.gain.value = 0.07;
    this.voiceWet = wet;
    makeup.connect(wet).connect(room);
    // The echo (off unless asked for): dull repeats that feed back into themselves and into the room.
    const send = ctx.createGain();
    send.gain.value = 0;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.4;
    const dull = ctx.createBiquadFilter();
    dull.type = 'lowpass';
    dull.frequency.value = 2200;
    const again = ctx.createGain();
    again.gain.value = 0.42;
    makeup.connect(send).connect(delay).connect(dull);
    dull.connect(again).connect(delay);
    dull.connect(this.out(ctx));
    dull.connect(room);
    this.voiceEcho = { send, delay };
    this.voiceIn = { ctx, node: input };
    return input;
  }

  /** Set how much room and echo the voice gets for this playback. */
  private voiceSends(ctx: BaseAudioContext, o: PlayOptions): void {
    this.voiceBus(ctx);
    const fx = Math.max(0, Math.min(2, Math.round(o.voiceFx ?? 0)));
    this.voiceWet?.gain.setTargetAtTime(Math.max(o.voiceRoom ?? 0.07, [0, 0.15, 0.18][fx]), ctx.currentTime, 0.05);
    if (this.voiceTone) {
      const t = ctx.currentTime;
      this.voiceTone.high.frequency.setValueAtTime(fx === 2 ? 320 : 20, t);
      this.voiceTone.low.frequency.setValueAtTime(fx === 2 ? 3400 : 20000, t);
      this.voiceTone.gain.gain.setValueAtTime(fx === 2 ? 1.5 : 1.2, t);
    }
    if (this.voiceEcho) {
      // Three quarters of a (relaxed) beat: the repeats fall between the words, in time.
      let beat = 60 / Math.max(30, o.bpm);
      while (beat < 0.5) beat *= 2;
      while (beat > 1) beat /= 2;
      this.voiceEcho.delay.delayTime.setValueAtTime(0.75 * beat, ctx.currentTime);
      this.voiceEcho.send.gain.setTargetAtTime(Math.max(0, Math.min(1, Math.max(o.voiceEcho ?? 0, [0, 0.1, 0.14][fx]))), ctx.currentTime, 0.05);
    }
  }

  /**
   * The same thing `play` would play, as a finished stereo file: the loop span `passes` times
   * over (or the whole take once, without a loop), then a few seconds for the last chord, the
   * room and the rain to ring out and fade. Nothing is heard while it renders.
   */
  async render(samples: Float32Array, sampleRate: number, o: PlayOptions, passes = 2, onProgress?: (done: number) => void): Promise<AudioBuffer> {
    this.stop();
    const dur = samples.length / sampleRate;
    const loop = o.loop && o.loop.end - o.loop.start >= 0.05 ? o.loop : null;
    const [a, b] = loop ? [Math.max(0, loop.start), loop.end] : [0, dur];
    const len = b - a;
    const times = loop ? Math.max(1, Math.round(passes)) : 1;
    const lead = 0.05;
    const tail = 3.5;
    const rate = this.ctx?.sampleRate === 48000 ? 48000 : 44100;
    const off = new OfflineAudioContext(2, Math.ceil((lead + len * times + tail) * rate), rate);
    const keep = { master: this.master, fx: this.fx, shared: this.shared, voiceIn: this.voiceIn, voiceWet: this.voiceWet, voiceEcho: this.voiceEcho, voiceTone: this.voiceTone, samples: this.samples, sampleRate: this.sampleRate, opts: this.opts, dust: this.dust, duration: this.duration };
    try {
      this.rendering = off;
      this.master = null;
      this.fx = null;
      this.shared = null;
      this.voiceIn = null;
      this.crackle = null;
      this.samples = samples;
      this.sampleRate = sampleRate;
      this.opts = o;
      this.duration = dur;
      this.dust = Math.max(0, Math.min(1, o.dust ?? 0));
      if (o.drums.length && o.drumStyle && o.drumStyle !== 'plain') await this.loadKit(off);
      if ((o.chords.length > 0 && o.chordStyle === 'floaty') || (!!o.comp?.length && (o.compSound ?? 'keys') === 'keys')) await this.loadKeys(off);
      this.out(off);
      this.startCrackle(off);
      const rain = o.rain ? await this.loadRain(off) : null;
      if (rain) {
        const src = off.createBufferSource();
        src.buffer = rain;
        src.loop = true;
        const gain = off.createGain();
        gain.gain.setValueAtTime(0, 0);
        gain.gain.setTargetAtTime(0.4, 0, 0.4);
        src.connect(gain).connect(this.out(off));
        src.start(0, Math.random() * Math.max(0, rain.duration - 1));
      }
      this.voiceSends(off, o);
      this.resetBand(off, o);
      for (let p = 0; p < times; p++) this.schedule(this.pass(a, b, lead + p * len), a, b);
      // How far the file has got, for a progress bar (the context's clock runs ahead as it renders).
      const total = off.length / off.sampleRate;
      const watch = onProgress ? setInterval(() => onProgress(Math.min(1, off.currentTime / total)), 100) : null;
      const buf = await off.startRendering().finally(() => watch && clearInterval(watch));
      onProgress?.(1);
      // The ending: everything still ringing fades away over the last two seconds.
      const fade = Math.min(buf.length, Math.round(2 * rate));
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < fade; i++) {
          const x = i / fade;
          d[d.length - 1 - i] *= x * x;
        }
      }
      return buf;
    } finally {
      this.rendering = null;
      this.crackle = null;
      this.segments = [];
      Object.assign(this, keep);
    }
  }

  async play(samples: Float32Array, sampleRate: number, o: PlayOptions): Promise<void> {
    this.stop();
    const ctx = this.live();
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined); // 'suspended', or iOS 'interrupted' after a call
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.opts = o;
    if (o.rain) this.startRain(ctx);
    this.dust = Math.max(0, Math.min(1, o.dust ?? 0));
    this.out(ctx);
    this.applyDust(ctx);
    this.startCrackle(ctx);
    // The sampled kit: wait for it the first time (briefly), so the first bar isn't the synth kit.
    if (o.drums.length && o.drumStyle && o.drumStyle !== 'plain' && !this.kitNow) {
      await Promise.race([this.loadKit(ctx), new Promise((r) => setTimeout(r, 1500))]);
    }
    // Same for the piano.
    const wantsKeys = (o.chords.length > 0 && o.chordStyle === 'floaty') || (!!o.comp?.length && (o.compSound ?? 'keys') === 'keys');
    if (wantsKeys && !this.keysNow) await Promise.race([this.loadKeys(ctx), new Promise((r) => setTimeout(r, 2500))]);
    this.voiceSends(ctx, o);
    this.duration = samples.length / sampleRate;
    // A loop may run past the end of the recording (a whole-bar loop with a silent tail).
    const loop = o.loop && o.loop.end - o.loop.start >= 0.05 ? { start: Math.max(0, o.loop.start), end: o.loop.end } : null;
    let from = Math.max(0, Math.min(o.from, this.duration));
    if (loop && (from < loop.start || from >= loop.end)) from = loop.start;
    const t0 = ctx.currentTime + 0.05;
    this.playing = true;
    stayAwake('playing', true); // no screen sleep while the music plays
    this.resetBand(ctx, o);
    this.looping = loop;
    // Sound is queued a little at a time, a couple of seconds ahead of what is heard: a phone
    // only ever carries the notes of the next few seconds, not every note of the take at once.
    this.cursor = { seg: this.pass(from, loop ? loop.end : this.duration, t0), t: from };
    this.pump();
    this.timer = setInterval(() => this.pump(), 200);
    if (!this.pumpOnHide) {
      // Top the queue up the moment the page is hidden, before timers slow down.
      this.pumpOnHide = () => this.pump();
      document.addEventListener('visibilitychange', this.pumpOnHide);
    }
    if (!loop) {
      this.endTimer = setTimeout(() => {
        this.stop(false);
        this.stopped = from;
        this.onEnded?.();
      }, (this.duration - from) * 1000 + 100);
    }
  }

  /** How far ahead (s) sound is queued while playing, and in steps of how long. */
  private static readonly AHEAD = 2.5;
  private static readonly AHEAD_HIDDEN = 12;
  private static readonly STEP = 1;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpOnHide: (() => void) | null = null;
  private looping: { start: number; end: number } | null = null;
  /** Where queuing has got to: the pass being filled, and the take time it is filled up to. */
  private cursor: { seg: Segment; t: number } | null = null;

  /** A new pass over take time [a, b), heard from context time `at`. */
  private pass(a: number, b: number, at: number): Segment {
    const seg: Segment = { start: a, end: b, at, nodes: [] };
    this.segments.push(seg);
    return seg;
  }

  /** Queue whatever starts within the next few seconds; start the next loop pass when this one is all queued. */
  private pump(): void {
    const ctx = this.ctx;
    if (!ctx || !this.playing) return;
    // Screen off / app in the background: timers slow to about once a second (or less), so queue
    // well ahead to keep the music going until they come round again.
    const hidden = typeof document !== 'undefined' && document.hidden;
    const until = ctx.currentTime + (hidden ? Player.AHEAD_HIDDEN : Player.AHEAD);
    while (this.cursor) {
      const { seg, t } = this.cursor;
      if (seg.at + (t - seg.start) > until) break;
      const w1 = Math.min(seg.end, t + Player.STEP);
      this.schedule(seg, t, w1);
      if (w1 < seg.end) this.cursor = { seg, t: w1 };
      else if (this.looping) {
        const l = this.looping;
        this.cursor = { seg: this.pass(l.start, l.end, seg.at + (seg.end - seg.start)), t: l.start };
      } else this.cursor = null;
    }
    // Drop passes long finished (their tails have rung out by the time the next one ends).
    const now = ctx.currentTime;
    while (this.segments.length > 2 && this.segments[1].at + (this.segments[1].end - this.segments[1].start) < now) this.segments.shift();
  }

  // ---------------------------------------------------------------- the band's effect chains

  /**
   * Filters, drive, rooms and limiters for each part, built once per context and reused by every
   * pass. (Building them anew for each loop pass meant several reverbs running at once on the
   * overlaps, which is what a phone can't keep up with.)
   */
  private fx: {
    ctx: BaseAudioContext;
    band: GainNode;
    keys?: { bus: BiquadFilterNode; level: GainNode; wet: GainNode };
    comp?: { bus: BiquadFilterNode; level: GainNode; wet: GainNode };
    lofi?: { tape: BiquadFilterNode; warmth: BiquadFilterNode; out: GainNode };
    latin?: { top: BiquadFilterNode; out: GainNode; wet: GainNode };
    notes?: BiquadFilterNode;
    plain?: GainNode;
    pad?: BiquadFilterNode;
  } | null = null;

  /** The band (keys, guitar, pads) goes through one fader that dips under each kick. */
  private chains(ctx: BaseAudioContext): NonNullable<Player['fx']> {
    if (this.fx?.ctx === ctx) return this.fx;
    const band = ctx.createGain();
    band.connect(this.out(ctx));
    this.fx = { ctx, band };
    return this.fx;
  }

  /** Back to the plain band level, dropping dips queued for a playback that was stopped. */
  private resetBand(ctx: BaseAudioContext, o: PlayOptions): void {
    const g = this.chains(ctx).band.gain;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0, Math.min(2, o.backing ?? 1)), t);
  }

  private warmShaper(ctx: BaseAudioContext): WaveShaperNode {
    const drive = ctx.createWaveShaper();
    drive.curve = this.warmCurve();
    drive.oversample = '2x';
    return drive;
  }

  private roomNode(ctx: BaseAudioContext): ConvolverNode {
    const room = ctx.createConvolver();
    room.buffer = this.roomImpulse(ctx);
    return room;
  }

  private shared: { ctx: BaseAudioContext; room: ConvolverNode } | null = null;

  /** Phones: the one reverb every part sends to (mono in, so half the work of a stereo one). */
  private sharedRoom(ctx: BaseAudioContext): ConvolverNode {
    if (this.shared?.ctx === ctx) return this.shared.room;
    const room = this.roomNode(ctx);
    try {
      room.channelCount = 1;
      room.channelCountMode = 'explicit';
    } catch {
      // Older browsers: stereo in.
    }
    room.connect(this.out(ctx));
    this.shared = { ctx, room };
    return room;
  }

  /**
   * `from` into a room, returned through `wet`. Laptop: its own room, then `wet`, into `into`.
   * Phone: `wet` into the shared room, so the caller sets `wet` to include `into`'s level.
   */
  private roomSend(ctx: BaseAudioContext, from: AudioNode, into: AudioNode): GainNode {
    const wet = ctx.createGain();
    if (LITE) from.connect(wet).connect(this.sharedRoom(ctx));
    else from.connect(this.roomNode(ctx)).connect(wet).connect(into);
    return wet;
  }

  private limiter(ctx: BaseAudioContext): DynamicsCompressorNode {
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -8;
    limit.knee.value = 6;
    limit.ratio.value = 12;
    limit.attack.value = 0.003;
    limit.release.value = 0.15;
    return limit;
  }

  /**
   * The floaty keys: a warm electric piano played by a hand: soft drive, a slow stereo sway
   * (the classic suitcase tremolo) and a small room. Tails ring past each change.
   */
  private keysChain(ctx: BaseAudioContext, o: PlayOptions): AudioNode {
    const fx = this.chains(ctx);
    if (!fx.keys) {
      const bus = ctx.createBiquadFilter();
      bus.type = 'lowpass';
      bus.Q.value = 0.4;
      const drive = this.warmShaper(ctx);
      const sway = ctx.createStereoPanner();
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 3.1;
      const depth = ctx.createGain();
      depth.gain.value = 0.28;
      lfo.connect(depth).connect(sway.pan);
      lfo.start();
      const dry = ctx.createGain();
      dry.gain.value = 0.85;
      const breathe = ctx.createGain();
      breathe.gain.value = 0.93;
      const swell = ctx.createOscillator();
      swell.frequency.value = 4.3;
      const swellDepth = ctx.createGain();
      swellDepth.gain.value = 0.07;
      swell.connect(swellDepth).connect(breathe.gain);
      swell.start();
      bus.connect(drive).connect(breathe).connect(sway);
      const level = ctx.createGain();
      level.connect(this.limiter(ctx)).connect(fx.band);
      sway.connect(dry).connect(level);
      const wet = this.roomSend(ctx, sway, level);
      fx.keys = { bus, level, wet };
    }
    const level = this.keysLevel();
    fx.keys.bus.frequency.value = o.keysTone ?? 2800;
    fx.keys.level.gain.value = level;
    fx.keys.wet.gain.value = 0.3 * (LITE ? level : 1);
    return fx.keys.bus;
  }

  /** The montuno / bossa / dream part: bright and dry for keys, roomier for the pluck and pads. */
  private compChain(ctx: BaseAudioContext, o: PlayOptions): AudioNode {
    const fx = this.chains(ctx);
    if (!fx.comp) {
      const bus = ctx.createBiquadFilter();
      bus.type = 'lowpass';
      bus.Q.value = 0.4;
      const drive = this.warmShaper(ctx);
      const level = ctx.createGain();
      bus.connect(drive).connect(level).connect(this.limiter(ctx)).connect(fx.band);
      const wet = this.roomSend(ctx, drive, level);
      fx.comp = { bus, level, wet };
    }
    const sound = o.compSound ?? 'keys';
    fx.comp.bus.frequency.value = o.keysTone ?? 5200;
    const level = this.keysLevel() * 0.65;
    fx.comp.level.gain.value = level;
    fx.comp.wet.gain.value = (sound === 'pad' ? 0.42 : sound === 'pluck' ? 0.3 : 0.22) * (LITE ? level : 1);
    return fx.comp.bus;
  }

  /** The lo-fi kit's "tape": no sharp highs, rounded peaks, the boxy low-mids taken out. */
  private lofiChain(ctx: BaseAudioContext, o: PlayOptions): { tape: AudioNode; out: AudioNode } {
    const fx = this.chains(ctx);
    if (!fx.lofi) {
      const tape = ctx.createBiquadFilter();
      tape.type = 'lowpass';
      tape.Q.value = 0.5;
      const warmth = ctx.createBiquadFilter();
      warmth.type = 'lowshelf';
      warmth.frequency.value = 140;
      // Take out the boxy low-mids that make a small kit sound like cardboard.
      const box = ctx.createBiquadFilter();
      box.type = 'peaking';
      box.frequency.value = 430;
      box.Q.value = 0.9;
      box.gain.value = -5;
      const out = ctx.createGain();
      tape.connect(box).connect(warmth).connect(this.warmShaper(ctx)).connect(out).connect(this.out(ctx));
      fx.lofi = { tape, warmth, out };
    }
    // A dark kit is heard through a wall: the top closes down to about 2.4 kHz and the low end fills out.
    const dark = Math.max(0, Math.min(1, o.drumDark ?? 0));
    fx.lofi.tape.frequency.value = 8200 * Math.pow(2400 / 8200, dark);
    fx.lofi.warmth.gain.value = 3.5 + 2 * dark;
    // Sit with the recording: a loud take gets a louder kit.
    const backing = Math.max(0, Math.min(2, o.backing ?? 1));
    fx.lofi.out.gain.value = Math.max(0.5, Math.min(1.5, this.voiceLoudness() / 0.16)) * 0.8 * Math.sqrt(backing);
    return fx.lofi;
  }

  /** The Latin percussion: a live, open room: bright, a touch of drive, no tape and no hiss. */
  private latinChain(ctx: BaseAudioContext): AudioNode {
    const fx = this.chains(ctx);
    if (!fx.latin) {
      const top = ctx.createBiquadFilter();
      top.type = 'lowpass';
      top.frequency.value = 6800;
      top.Q.value = 0.5;
      const drive = this.warmShaper(ctx);
      const out = ctx.createGain();
      top.connect(drive).connect(out).connect(this.out(ctx));
      const wet = this.roomSend(ctx, drive, out);
      fx.latin = { top, out, wet };
    }
    const level = Math.max(0.5, Math.min(1.5, this.voiceLoudness() / 0.16)) * 0.55;
    fx.latin.out.gain.value = level;
    fx.latin.wet.gain.value = 0.18 * (LITE ? level : 1);
    return fx.latin.top;
  }

  /** Queue the part of pass `seg` whose sounds start within take time [w0, w1). */
  private schedule(seg: Segment, w0: number, w1: number): void {
    const ctx = this.context();
    const o = this.opts as PlayOptions;
    const { start: a0, end: b0, at } = seg;
    /** The pass's first step: the long sounds that run through all of it start here. */
    const first = w0 <= a0;
    const inStep = (t: number): boolean => t >= w0 && t < w1;
    this.nodes = seg.nodes; // tone() / drum() add their sources here
    const fx = this.chains(ctx);
    // The band dips under each kick: more dust, deeper dip.
    const band = fx.band;
    const backing = Math.max(0, Math.min(2, o.backing ?? 1));
    if (this.dust > 0) {
      for (const h of o.drums) {
        if (h.kind !== 'kick' || h.velocity < 0.45 || !inStep(h.time)) continue;
        const t = at + (h.time - a0);
        band.gain.setTargetAtTime(backing * (1 - 0.4 * this.dust), t, 0.006);
        band.gain.setTargetAtTime(backing, t + 0.07, 0.11);
      }
    }
    if (o.voice && first) {
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
      this.nodes.push(src);
    }

    for (const l of first ? (o.layers ?? []) : []) {
      const dur = l.samples.length / l.sampleRate;
      const from = Math.max(a0, l.start);
      const to = Math.min(b0, l.start + dur);
      if (to - from < 0.02) continue;
      const src = ctx.createBufferSource();
      src.buffer = this.layerBuffer(ctx, l.samples, l.sampleRate);
      const g = ctx.createGain();
      const t = at + (from - a0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.005);
      g.gain.setValueAtTime(1, t + (to - from) - 0.005);
      g.gain.linearRampToValueAtTime(0, t + (to - from));
      src.connect(g).connect(this.voiceBus(ctx));
      src.start(t, from - l.start, to - from);
      this.nodes.push(src);
    }

    if (o.notes.length > 0) {
      // Simple monophonic synth: triangle + quiet sine an octave up, low-passed, ADSR.
      if (!fx.notes) {
        fx.notes = ctx.createBiquadFilter();
        fx.notes.type = 'lowpass';
        fx.notes.frequency.value = 3000;
        fx.notes.connect(this.out(ctx));
      }
      const bus = fx.notes;
      for (const n of o.notes) {
        const end = Math.min(b0, n.start + n.duration);
        if (end <= a0 || n.start >= b0 || !inStep(Math.max(a0, n.start))) continue;
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
          this.nodes.push(osc);
        }
      }
    }

    if (o.drums.length > 0 && o.drumStyle === 'latin') {
      const top = this.latinChain(ctx);
      for (const h of o.drums) {
        if (!inStep(h.time)) continue;
        this.latinDrum(ctx, top, h, at + (h.time - a0));
      }
    } else if (o.drums.length > 0 && o.drumStyle === 'lofi') {
      // Everything through a dull, slightly driven "tape": no sharp highs, rounded peaks.
      const { tape, out } = this.lofiChain(ctx, o);
      for (const h of o.drums) {
        if (!inStep(h.time)) continue;
        this.lofiDrum(ctx, tape, h, at + (h.time - a0));
      }
      // A quiet bed of hiss under it all, which also hides the cuts between phrases.
      if (first) {
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
        this.nodes.push(hiss);
      }
    } else if (o.drums.length > 0) {
      if (!fx.plain) {
        fx.plain = ctx.createGain();
        fx.plain.gain.value = 0.55;
        fx.plain.connect(this.out(ctx));
      }
      const bus = fx.plain;
      for (const h of o.drums) {
        if (!inStep(h.time)) continue;
        this.drum(ctx, bus, h, at + (h.time - a0));
      }
    }

    if (o.chords.length > 0 && o.chordStyle === 'floaty') {
      const bus = this.keysChain(ctx, o);
      const beat = 60 / o.bpm;
      o.chords.forEach((c) => {
        const end = Math.min(b0, c.start + c.duration);
        if (end <= a0 || c.start >= b0 || !inStep(Math.max(a0, c.start))) return;
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
      if (!fx.pad) {
        fx.pad = ctx.createBiquadFilter();
        fx.pad.type = 'lowpass';
        fx.pad.frequency.value = 1400;
        fx.pad.Q.value = 0.5;
        fx.pad.connect(this.out(ctx));
      }
      const pad = fx.pad;
      for (const c of o.chords) {
        const end = Math.min(b0, c.start + c.duration);
        if (end <= a0 || c.start >= b0 || !inStep(Math.max(a0, c.start))) continue;
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
          this.tone(ctx, this.out(ctx), 'triangle', mtof(c.bass, o.backingTuningCents), s, e - 0.02, 0.32, 0.008, 0.08);
        });
      }
    }

    if (o.comp?.length) {
      // The montuno: the same electric piano, but bright, dry and stabbed short. The bass is its left hand, held.
      const bus = this.compChain(ctx, o);
      const sound = o.compSound ?? 'keys';
      for (const n of o.comp) {
        // A long held note that began before this pass is picked up where the pass starts.
        const held = n.duration > 1 && n.start < a0 && n.start + n.duration > a0 + 0.3;
        if ((n.start < a0 && !held) || n.start >= b0 || !inStep(Math.max(a0, n.start))) continue;
        const t = at + Math.max(0, n.start - a0) + Math.random() * 0.006;
        const stop = at + (n.start + n.duration - a0);
        const vel = Math.max(0.12, Math.min(1, n.velocity * (0.9 + 0.2 * Math.random())));
        const hz = mtof(n.midi, o.backingTuningCents);
        if (sound === 'pad') this.pad(ctx, bus, hz, t, stop, vel);
        else if (sound === 'pluck') this.pluck(ctx, bus, hz, t, vel, !!n.bass, n.duration);
        else this.rhodes(ctx, bus, hz, t, stop, vel, n.bass ? 0.2 : 0.14);
      }
    }

    if (o.click) {
      for (const b of beatTimes(o.bpm, o.firstBeatMs, this.duration)) {
        if (!inStep(b.time)) continue;
        const t = at + (b.time - a0);
        const down = ((b.index % o.beatsPerBar) + o.beatsPerBar) % o.beatsPerBar === 0;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = down ? 1760 : 1100;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(o.clickGain * (down ? 1 : 0.7), t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
        osc.connect(g).connect(this.out(ctx));
        osc.start(t);
        osc.stop(t + 0.06);
        this.nodes.push(osc);
      }
    }

  }

  /** Short audition blip for note editing (independent of playback). */
  async preview(midi: number, tuningCents: number): Promise<void> {
    const ctx = this.live();
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined); // 'suspended', or iOS 'interrupted' after a call
    const t = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = mtof(midi, tuningCents);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(g).connect(this.out(ctx));
    osc.start(t);
    osc.stop(t + 0.36);
  }

  /** Audition a chord on the soft keys (independent of playback). */
  async previewChord(voicing: number[], bass: number, tuningCents: number): Promise<void> {
    const ctx = this.live();
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined); // 'suspended', or iOS 'interrupted' after a call
    if (!this.keysNow) await Promise.race([this.loadKeys(ctx), new Promise((r) => setTimeout(r, 2500))]);
    const t = ctx.currentTime + 0.02;
    const keep = this.nodes;
    this.nodes = [];
    voicing.forEach((m, k) => this.rhodes(ctx, this.out(ctx), mtof(m, tuningCents), t + k * 0.02, t + 0.9, 0.8));
    this.rhodes(ctx, this.out(ctx), mtof(bass, tuningCents), t, t + 0.9, 0.9);
    this.nodes = keep;
  }

  private noise: AudioBuffer | null = null;
  private room: AudioBuffer | null = null;

  /** Stereo decaying-noise impulse: a soft ~2 s room. */
  private roomImpulse(ctx: BaseAudioContext): AudioBuffer {
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
  private rhodes(ctx: BaseAudioContext, dest: AudioNode, hz: number, start: number, end: number, vel: number, release = 0.7): void {
    if (this.pianoNote(ctx, dest, hz, start, end, vel, release)) return;
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

  /** One note of a slow pad: two soft voices a few cents apart that swell in over a second and let go in about one more. */
  private pad(ctx: BaseAudioContext, dest: AudioNode, hz: number, start: number, end: number, vel: number): void {
    const balance = hz > 330 ? Math.pow(330 / hz, 0.5) : 1;
    const peak = 0.05 * vel * balance;
    const hold = Math.max(start + 0.4, end);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + Math.min(1.1, (hold - start) * 0.6));
    env.gain.setTargetAtTime(0, hold, 0.3);
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = Math.min(1800, hz * 3);
    soft.connect(env).connect(dest);
    for (const [cents, pan] of [
      [-7, -0.5],
      [7, 0.5],
    ]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = hz * Math.pow(2, cents / 1200);
      const side = ctx.createStereoPanner();
      side.pan.value = pan;
      osc.connect(side).connect(soft);
      osc.start(start);
      osc.stop(hold + 2);
      this.nodes.push(osc);
    }
  }

  /** One plucked nylon string: a quick soft attack that closes and dies away on its own. A longer note is left to ring longer. */
  private pluck(ctx: BaseAudioContext, dest: AudioNode, hz: number, start: number, vel: number, bass: boolean, duration = 0): void {
    const balance = hz > 330 ? Math.pow(330 / hz, 0.4) : 1;
    const peak = (bass ? 0.2 : 0.14) * vel * balance;
    const ring = bass ? 0.5 : Math.max(0.32, Math.min(0.7, duration * 0.5));
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.004);
    env.gain.setTargetAtTime(0, start + 0.004, ring);
    const close = ctx.createBiquadFilter();
    close.type = 'lowpass';
    close.frequency.setValueAtTime(Math.min(3200, hz * 7), start);
    close.frequency.setTargetAtTime(Math.min(900, hz * 2.2), start, 0.12);
    close.connect(env).connect(dest);
    for (const [type, mult, level] of [
      ['triangle', 1, 1],
      ['sine', 2, 0.3],
      ['sine', 3, 0.1],
    ] as [OscillatorType, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz * mult * Math.pow(2, (Math.random() - 0.5) * 6 / 1200);
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(close);
      osc.start(start);
      osc.stop(start + ring * 7);
      this.nodes.push(osc);
    }
  }

  private noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
    if (this.noise && this.noise.sampleRate === ctx.sampleRate) return this.noise;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  /** Sustained oscillator voice with attack / release envelope. */
  private tone(
    ctx: BaseAudioContext,
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
  private lofiDrum(ctx: BaseAudioContext, dest: AudioNode, h: DrumHit, t: number): void {
    const v = h.velocity * (0.88 + 0.24 * Math.random());
    const when = t + (Math.random() - 0.3) * 0.006; // a little loose, leaning late
    if (this.sampleHit(ctx, dest, h, when, v)) return;
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
  private latinDrum(ctx: BaseAudioContext, dest: AudioNode, h: DrumHit, t: number): void {
    if (h.kind === 'kick' || h.kind === 'snare' || h.kind === 'hat' || h.kind === 'openhat') {
      this.lofiDrum(ctx, dest, h, t);
      return;
    }
    const v = h.velocity * (0.9 + 0.2 * Math.random());
    const when = t + (Math.random() - 0.5) * 0.004;
    if (h.kind === 'shell' && this.sampleHit(ctx, dest, h, when, v)) return;
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

  private drum(ctx: BaseAudioContext, dest: AudioNode, h: DrumHit, t: number): void {
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
    this.stopCrackle();
    if (this.playing && keepPosition) this.stopped = this.position;
    if (this.timer) clearInterval(this.timer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.timer = null;
    this.endTimer = null;
    this.cursor = null;
    this.looping = null;
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
    stayAwake('playing', false);
  }

  seek(sec: number): void {
    this.stopped = Math.max(0, sec);
  }
}
