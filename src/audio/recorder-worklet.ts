/**
 * AudioWorklet processor, always running while the mic is "armed":
 *  - downmixes to mono and keeps a short ring buffer (pre-roll)
 *  - reports the input level ~every 50 ms (live meter, even when not recording)
 *  - on 'start': emits the pre-roll, then streams 4096-sample chunks
 *  - on 'stop': flushes and reports 'stopped'
 */

export type WorkletCommand = { type: 'start'; preRollSec: number } | { type: 'stop' };

export type WorkletMessage =
  | { type: 'chunk'; data: Float32Array }
  | { type: 'level'; peak: number; rms: number }
  | { type: 'started'; preRollSamples: number }
  | { type: 'stopped' };

const CHUNK = 4096;
const RING_SEC = 1;

// `sampleRate` is a global in AudioWorkletGlobalScope.
function sampleRateGlobal(): number {
  const g = globalThis as unknown as { sampleRate?: number };
  return g.sampleRate ?? 48000;
}

class RecorderProcessor extends AudioWorkletProcessor {
  private readonly ring = new Float32Array(Math.round(RING_SEC * sampleRateGlobal()));
  private ringPos = 0;
  private ringFilled = 0;
  private recording = false;
  private buf = new Float32Array(CHUNK);
  private n = 0;
  private peak = 0;
  private sumSq = 0;
  private count = 0;
  private readonly levelEvery = Math.round(0.05 * sampleRateGlobal());

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletCommand>) => {
      const cmd = e.data;
      if (cmd.type === 'start') this.start(cmd.preRollSec);
      else if (cmd.type === 'stop') this.stop();
    };
  }

  private post(msg: WorkletMessage, transfer: Transferable[] = []): void {
    this.port.postMessage(msg, transfer);
  }

  private start(preRollSec: number): void {
    const want = Math.min(this.ringFilled, Math.round(preRollSec * sampleRateGlobal()));
    const pre = new Float32Array(want);
    const L = this.ring.length;
    for (let i = 0; i < want; i++) pre[i] = this.ring[(this.ringPos - want + i + L) % L];
    this.n = 0;
    this.recording = true;
    if (want > 0) this.post({ type: 'chunk', data: pre }, [pre.buffer]);
    this.post({ type: 'started', preRollSamples: want });
  }

  private stop(): void {
    this.flush();
    this.recording = false;
    this.post({ type: 'stopped' });
  }

  private flush(): void {
    if (this.n === 0) return;
    const out = this.buf.slice(0, this.n);
    this.post({ type: 'chunk', data: out }, [out.buffer]);
    this.n = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    const L = this.ring.length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      s /= channels;
      this.ring[this.ringPos] = s;
      this.ringPos = (this.ringPos + 1) % L;
      if (this.ringFilled < L) this.ringFilled++;
      if (this.recording) {
        this.buf[this.n++] = s;
        if (this.n === CHUNK) this.flush();
      }
      const a = Math.abs(s);
      if (a > this.peak) this.peak = a;
      this.sumSq += s * s;
    }
    this.count += frames;
    if (this.count >= this.levelEvery) {
      this.post({ type: 'level', peak: this.peak, rms: Math.sqrt(this.sumSq / this.count) });
      this.peak = 0;
      this.sumSq = 0;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
