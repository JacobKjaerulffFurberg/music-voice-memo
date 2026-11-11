/**
 * Microphone recorder: getUserMedia → AudioWorklet → Float32Array (mono,
 * native sample rate). Browser DSP (AEC/NS/AGC) is disabled so pitch and
 * dynamics are untouched.
 *
 * Like an armed track in a DAW, the mic + audio graph are opened once
 * ("warm") and kept running, so pressing record is instant. A short pre-roll
 * (audio from just before the press) is included so a first note sung right
 * on the button press isn't clipped. The mic is released after a period of
 * inactivity or when the page is hidden.
 */

import workletUrl from './recorder-worklet.ts?worker&url';
import type { WorkletCommand, WorkletMessage } from './recorder-worklet';

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
  /** Samples of pre-roll at the start (audio from before the record press). */
  preRollSamples: number;
}

export interface RecorderCallbacks {
  /** Live input level, whenever the mic is warm (not only while recording). */
  onLevel?: (peak: number, rms: number) => void;
  /** Mic armed / released. */
  onWarmChange?: (warm: boolean) => void;
}

export interface RecorderOptions {
  preRollSec: number;
  /** Release the mic after this long without recording. */
  idleReleaseMs: number;
}

const DEFAULTS: RecorderOptions = { preRollSec: 0.3, idleReleaseMs: 3 * 60 * 1000 };

interface Graph {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  sink: GainNode;
  /** Input monitoring (hear yourself); gain 0 = off. */
  monitor: GainNode;
  /** Spectrum tap for the live chord / note readout. */
  analyser: AnalyserNode;
}

export class Recorder {
  private graph: Graph | null = null;
  private warming: Promise<Graph> | null = null;
  private recording = false;
  private chunks: Float32Array[] = [];
  private preRollSamples = 0;
  private waiters: { started?: () => void; stopped?: () => void } = {};
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly o: RecorderOptions;

  constructor(
    private readonly cb: RecorderCallbacks = {},
    options: Partial<RecorderOptions> = {},
  ) {
    this.o = { ...DEFAULTS, ...options };
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get isWarm(): boolean {
    return this.graph !== null;
  }

  private monitorLevel = 0;

  /** Hear the mic live (0 = off). Use headphones to avoid feedback. */
  async setMonitor(level: number): Promise<void> {
    this.monitorLevel = Math.max(0, Math.min(1.5, level));
    if (this.monitorLevel > 0) {
      const g = await this.warm();
      if (g.ctx.state !== 'running') await g.ctx.resume();
    }
    const g = this.graph;
    if (g) g.monitor.gain.setTargetAtTime(this.monitorLevel, g.ctx.currentTime, 0.01);
    if (this.monitorLevel > 0 && this.idleTimer) clearTimeout(this.idleTimer);
    else if (this.monitorLevel === 0) this.armIdleRelease();
  }

  /** Current input spectrum for live analysis, or null when the mic isn't armed. */
  readSpectrum(): { mags: Float32Array; sampleRate: number; fftSize: number; rms: number } | null {
    const g = this.graph;
    if (!g || g.ctx.state !== 'running') return null;
    const a = g.analyser;
    const db = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(db);
    const mags = new Float32Array(db.length);
    for (let i = 0; i < db.length; i++) mags[i] = Number.isFinite(db[i]) ? Math.pow(10, db[i] / 20) : 0;
    const td = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(td);
    let e = 0;
    for (const v of td) e += v * v;
    return { mags, sampleRate: g.ctx.sampleRate, fftSize: a.fftSize, rms: Math.sqrt(e / td.length) };
  }

  /** Open the mic and audio graph (slow the first time; idempotent). */
  warm(): Promise<Graph> {
    if (this.graph) return Promise.resolve(this.graph);
    this.warming ??= this.open().finally(() => {
      this.warming = null;
    });
    return this.warming;
  }

  private async open(): Promise<Graph> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      },
      video: false,
    });
    try {
      // No sampleRate option → the device's native rate.
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(workletUrl);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCountMode: 'explicit',
        channelCount: 1,
      });
      node.port.onmessage = (e: MessageEvent<WorkletMessage>) => this.onMessage(e.data);
      // Keep the graph pulled without making sound.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node).connect(sink).connect(ctx.destination);
      // Monitoring: mic → speakers/headphones (off unless enabled).
      const monitor = ctx.createGain();
      monitor.gain.value = this.monitorLevel;
      source.connect(monitor).connect(ctx.destination);
      // Spectrum tap (~170 ms window at 48 kHz) for the live chord / note readout.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      // A context created outside a user gesture starts suspended; resume() is
      // cheap and is called again from the record press.
      void ctx.resume().catch(() => undefined);
      // If the mic goes away (unplugged, permission revoked), drop the graph.
      stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => this.release()));
      this.graph = { ctx, stream, source, node, sink, monitor, analyser };
      this.cb.onWarmChange?.(true);
      this.armIdleRelease();
      return this.graph;
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
  }

  private onMessage(msg: WorkletMessage): void {
    if (msg.type === 'chunk') {
      if (this.recording) this.chunks.push(msg.data);
    } else if (msg.type === 'level') this.cb.onLevel?.(msg.peak, msg.rms);
    else if (msg.type === 'started') {
      this.preRollSamples = msg.preRollSamples;
      this.waiters.started?.();
    } else if (msg.type === 'stopped') this.waiters.stopped?.();
  }

  private send(cmd: WorkletCommand): void {
    this.graph?.node.port.postMessage(cmd);
  }

  private armIdleRelease(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.recording && this.monitorLevel === 0) this.release();
    }, this.o.idleReleaseMs);
  }

  /** Start recording. Instant when warm; opens the mic first otherwise. */
  async start(): Promise<void> {
    if (this.recording) return;
    const g = await this.warm();
    if (g.ctx.state !== 'running') await g.ctx.resume();
    this.chunks = [];
    this.preRollSamples = 0;
    this.recording = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 300);
      this.waiters.started = () => {
        clearTimeout(t);
        resolve();
      };
      this.send({ type: 'start', preRollSec: this.o.preRollSec });
    });
    this.waiters.started = undefined;
  }

  async stop(): Promise<Recording> {
    const g = this.graph;
    if (!g || !this.recording) throw new Error('Not recording');
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 500);
      this.waiters.stopped = () => {
        clearTimeout(t);
        resolve();
      };
      this.send({ type: 'stop' });
    });
    this.waiters.stopped = undefined;
    this.recording = false;
    this.armIdleRelease();

    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    const samples = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      samples.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    return { samples, sampleRate: g.ctx.sampleRate, preRollSamples: this.preRollSamples };
  }

  /** Close the mic and audio graph (the browser's mic indicator turns off). */
  release(): void {
    const g = this.graph;
    if (!g) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.graph = null;
    this.recording = false;
    try {
      g.source.disconnect();
      g.node.disconnect();
      g.sink.disconnect();
      g.monitor.disconnect();
      g.analyser.disconnect();
    } catch {
      /* already disconnected */
    }
    g.stream.getTracks().forEach((t) => t.stop());
    void g.ctx.close().catch(() => undefined);
    this.cb.onWarmChange?.(false);
  }
}

/** True if the user has already granted mic access (so warming up won't prompt). */
export async function micPermissionGranted(): Promise<boolean> {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return p.state === 'granted';
  } catch {
    return false; // Permissions API not available for 'microphone' (e.g. some Firefox / iOS)
  }
}
