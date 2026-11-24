/**
 * IndexedDB persistence. Metadata (+ analysis) and audio live in separate
 * stores so the recordings list never has to load audio.
 */

import type { Layer, StoredRecording } from '../model';

export type RecordingMeta = Omit<StoredRecording, 'samples' | 'layers'> & { durationSec: number };

const DB_NAME = 'music-voice-memo';
const DB_VERSION = 2;
const META = 'meta';
const AUDIO = 'audio';
/** The take being recorded, saved piece by piece so a crash or a call can't lose it. */
const DRAFT = 'draft';

interface AudioRow {
  id: string;
  samples: Float32Array;
  layers?: Layer[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DRAFT)) db.createObjectStore(DRAFT, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function toMeta(rec: StoredRecording): RecordingMeta {
  const { samples, layers: _layers, ...rest } = rec;
  void _layers;
  return { ...rest, durationSec: samples.length / rec.sampleRate };
}

export async function saveRecording(rec: StoredRecording, includeAudio = true): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(includeAudio ? [META, AUDIO] : [META], 'readwrite');
  tx.objectStore(META).put(toMeta(rec));
  if (includeAudio) {
    // A caller that knows nothing about layers (layers undefined) leaves the stored ones alone.
    const kept = rec.layers ?? (await request(tx.objectStore(AUDIO).get(rec.id) as IDBRequest<AudioRow | undefined>))?.layers;
    const row: AudioRow = { id: rec.id, samples: rec.samples, ...(kept?.length ? { layers: kept } : {}) };
    tx.objectStore(AUDIO).put(row);
  }
  await done(tx);
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  const db = await openDb();
  const tx = db.transaction(META, 'readonly');
  const all = await request(tx.objectStore(META).getAll() as IDBRequest<RecordingMeta[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadRecording(id: string): Promise<StoredRecording | null> {
  const db = await openDb();
  const tx = db.transaction([META, AUDIO], 'readonly');
  const [meta, audio] = await Promise.all([
    request(tx.objectStore(META).get(id) as IDBRequest<RecordingMeta | undefined>),
    request(tx.objectStore(AUDIO).get(id) as IDBRequest<AudioRow | undefined>),
  ]);
  if (!meta || !audio) return null;
  const { durationSec: _d, ...rest } = meta;
  void _d;
  return { ...rest, samples: audio.samples, ...(audio.layers?.length ? { layers: audio.layers } : {}) };
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, AUDIO], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(AUDIO).delete(id);
  await done(tx);
}

/** Ask the browser / OS not to clear our storage when space runs low (ideas must never vanish). */
export async function keepStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported: nothing to do */
  }
}

interface DraftPiece {
  startedAt: number;
  sampleRate: number;
  samples: Float32Array;
}

/** Add the newest audio of the take being recorded. */
export async function appendDraft(startedAt: number, sampleRate: number, pieces: Float32Array[]): Promise<void> {
  if (!pieces.length) return;
  const n = pieces.reduce((t, c) => t + c.length, 0);
  const samples = new Float32Array(n);
  let o = 0;
  for (const c of pieces) {
    samples.set(c, o);
    o += c.length;
  }
  const db = await openDb();
  const tx = db.transaction(DRAFT, 'readwrite');
  tx.objectStore(DRAFT).add({ startedAt, sampleRate, samples } satisfies DraftPiece);
  await done(tx);
}

/** The take that started at `startedAt` is saved (or rescued): forget its pieces. */
export async function clearDraft(startedAt: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(DRAFT, 'readwrite');
  const req = tx.objectStore(DRAFT).openCursor();
  req.onsuccess = () => {
    const c = req.result;
    if (!c) return;
    if ((c.value as DraftPiece).startedAt === startedAt) c.delete();
    c.continue();
  };
  await done(tx);
}

/** A take that was cut off before it could be saved (the app was closed or crashed mid-recording). */
export async function takeDraft(): Promise<{ startedAt: number; sampleRate: number; samples: Float32Array } | null> {
  const db = await openDb();
  const tx = db.transaction(DRAFT, 'readonly');
  const all = await request(tx.objectStore(DRAFT).getAll() as IDBRequest<DraftPiece[]>);
  if (!all.length) return null;
  // Only the newest take's pieces (in the order they were added).
  const last = all[all.length - 1];
  const mine = all.filter((d) => d.startedAt === last.startedAt);
  const n = mine.reduce((t, d) => t + d.samples.length, 0);
  const samples = new Float32Array(n);
  let o = 0;
  for (const d of mine) {
    samples.set(d.samples, o);
    o += d.samples.length;
  }
  return { startedAt: last.startedAt, sampleRate: last.sampleRate, samples };
}
