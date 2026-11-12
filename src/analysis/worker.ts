/**
 * Analysis Web Worker. Loads essentia.js lazily, runs the pipeline and posts
 * the result back. The UI thread never does DSP.
 */

import { essentiaKey, essentiaPitch, essentiaRhythm, loadEssentia, type EssentiaApi } from './essentia';
import { analyze, analyzeHighQuality, type ExternalInputs } from './pipeline';
import { HQ_YIN, trackPitchYin } from './pitch';
import { estimateTuning } from './tuning';
import type { AnalysisResult, EnginePreference, InputSource, KeyResult, PitchTrack } from './types';

export interface AnalyzeRequest {
  type: 'analyze';
  id: number;
  samples: Float32Array;
  sampleRate: number;
  engine: EnginePreference;
  source: InputSource;
  /** 'high' = slower, more careful pass. */
  quality: 'normal' | 'high';
}

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string }
  | { type: 'result'; id: number; result: AnalysisResult }
  | { type: 'error'; id: number; message: string };

// The project compiles against lib.dom; describe just the worker scope we use.
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<AnalyzeRequest>) => void): void;
}
const ctx = self as unknown as WorkerScope;

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function run(req: AnalyzeRequest): Promise<void> {
  const { id, samples, sampleRate } = req;
  const progress = (stage: string): void => post({ type: 'progress', id, stage });

  let es: EssentiaApi | null = null;
  let essentiaError: string | null = null;
  if (req.engine !== 'js') {
    progress('Loading essentia.js…');
    try {
      es = await loadEssentia();
    } catch (e) {
      essentiaError = `load: ${errMsg(e)}`;
    }
  }

  progress('Tracking pitch…');
  let pitch: PitchTrack | null = null;
  if (es && req.engine === 'essentia-pyin') {
    try {
      pitch = essentiaPitch(es, samples, sampleRate);
    } catch (e) {
      essentiaError = `pitch: ${errMsg(e)}`;
    }
  }
  pitch ??= trackPitchYin(samples, sampleRate, req.quality === 'high' ? HQ_YIN : {});

  const ext: ExternalInputs = { pitch, essentiaError, essentiaVersion: es ? es.version : null };
  if (es) {
    const tuning = estimateTuning(pitch);
    progress('Key (KeyExtractor)…');
    try {
      const k: KeyResult | null = essentiaKey(es, samples, sampleRate, tuning.a4Hz);
      ext.audioKey = k;
    } catch (e) {
      ext.essentiaError = `key: ${errMsg(e)}`;
    }
    progress('Rhythm (RhythmExtractor2013)…');
    try {
      ext.rhythm = essentiaRhythm(es, samples, sampleRate);
    } catch (e) {
      ext.essentiaError = `rhythm: ${errMsg(e)}`;
    }
  }

  progress(req.quality === 'high' ? 'High quality: comparing note readings…' : 'Notes, chords, key, tempo…');
  const result =
    req.quality === 'high'
      ? analyzeHighQuality(samples, sampleRate, ext, { source: req.source })
      : analyze(samples, sampleRate, ext, { source: req.source });
  post({ type: 'result', id, result });
}

ctx.addEventListener('message', (e: MessageEvent<AnalyzeRequest>) => {
  const req = e.data;
  if (req.type !== 'analyze') return;
  run(req).catch((err: unknown) => post({ type: 'error', id: req.id, message: errMsg(err) }));
});
