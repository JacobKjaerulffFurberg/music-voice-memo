/**
 * IndexedDB persistence. Metadata (+ analysis) and audio live in separate
 * stores so the recordings list never has to load audio.
 */

import type { StoredRecording } from '../model';

export type RecordingMeta = Omit<StoredRecording, 'samples'> & { durationSec: number };

const DB_NAME = 'music-voice-memo';
const DB_VERSION = 1;
const META = 'meta';
const AUDIO = 'audio';

interface AudioRow {
  id: string;
  samples: Float32Array;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: 'id' });
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
  const { samples, ...rest } = rec;
  return { ...rest, durationSec: samples.length / rec.sampleRate };
}

export async function saveRecording(rec: StoredRecording, includeAudio = true): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(includeAudio ? [META, AUDIO] : [META], 'readwrite');
  tx.objectStore(META).put(toMeta(rec));
  if (includeAudio) {
    const row: AudioRow = { id: rec.id, samples: rec.samples };
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
  return { ...rest, samples: audio.samples };
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, AUDIO], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(AUDIO).delete(id);
  await done(tx);
}
