/** Main-thread wrapper around the analysis worker. */

import type { AnalysisResult, EnginePreference, InputSource } from './types';
import type { AnalyzeRequest, WorkerResponse } from './worker';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (r: AnalysisResult) => void; reject: (e: Error) => void; onProgress?: (stage: string) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') p.onProgress?.(msg.stage);
    else if (msg.type === 'result') {
      pending.delete(msg.id);
      p.resolve(msg.result);
    } else {
      pending.delete(msg.id);
      p.reject(new Error(msg.message));
    }
  });
  worker.addEventListener('error', (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Analysis worker crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}

export function analyzeInWorker(
  samples: Float32Array,
  sampleRate: number,
  engine: EnginePreference = 'auto',
  onProgress?: (stage: string) => void,
  source: InputSource = 'auto',
  quality: 'normal' | 'high' = 'normal',
): Promise<AnalysisResult> {
  const id = nextId++;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    // Copy so the caller keeps its buffer (needed for playback / storage).
    const copy = samples.slice();
    const req: AnalyzeRequest = { type: 'analyze', id, samples: copy, sampleRate, engine, source, quality };
    w.postMessage(req, [copy.buffer]);
  });
}
