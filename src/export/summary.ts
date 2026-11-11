/** JSON + plain-text summaries of a recording's analysis and effective DAW settings. */

import { noteName } from '../analysis/music';
import type { Settings, StoredRecording } from '../model';

export function buildSummary(rec: StoredRecording, s: Settings): Record<string, unknown> {
  const a = rec.analysis;
  return {
    name: rec.name,
    recordedAt: new Date(rec.createdAt).toISOString(),
    sampleRate: rec.sampleRate,
    durationSec: +(rec.samples.length / rec.sampleRate).toFixed(3),
    daw: {
      bpm: +s.bpm.toFixed(2),
      bpmConfidence: +s.bpmConfidence.toFixed(2),
      bpmSource: s.bpmSource,
      firstBeatMs: Math.round(s.firstBeatMs),
      key: s.key?.name ?? null,
      keyConfidence: +s.keyConfidence.toFixed(2),
      tuningCents: +s.tuningCents.toFixed(1),
      a4Hz: +s.a4Hz.toFixed(2),
      overridden: s.overridden,
    },
    analysis: a
      ? {
          keyFromNotes: a.key.fromNotes,
          keyFromAudio: a.key.fromAudio,
          tempoCandidates: a.tempo.candidates,
          tuning: a.tuning,
          pitchEngine: a.pitch.engine,
          essentia: a.engine,
          timingsMs: a.timingsMs,
        }
      : null,
    notes: (a?.notes ?? []).map((n) => ({
      midi: n.midi,
      name: noteName(n.midi),
      startMs: Math.round(n.start * 1000),
      durationMs: Math.round(n.duration * 1000),
      cents: +n.cents.toFixed(1),
    })),
  };
}

export function buildTextSummary(rec: StoredRecording, s: Settings): string {
  const a = rec.analysis;
  const lines = [
    `${rec.name} — ${new Date(rec.createdAt).toLocaleString()}`,
    '',
    `Tempo:       ${s.bpm.toFixed(2)} BPM (${s.bpmSource}, confidence ${(s.bpmConfidence * 100).toFixed(0)}%)`,
    `First beat:  ${Math.round(s.firstBeatMs)} ms`,
    `Key:         ${s.key?.name ?? '—'} (confidence ${(s.keyConfidence * 100).toFixed(0)}%)`,
    `Tuning:      ${s.tuningCents >= 0 ? '+' : ''}${s.tuningCents.toFixed(1)} cents (A4 = ${s.a4Hz.toFixed(2)} Hz)`,
  ];
  if (a?.key.fromNotes) lines.push(`Key (notes): ${a.key.fromNotes.candidates.map((c) => `${c.name} ${c.score.toFixed(2)}`).join(' · ')}`);
  if (a?.key.fromAudio) lines.push(`Key (audio): ${a.key.fromAudio.name} (${a.key.fromAudio.source})`);
  lines.push('', 'Notes (name, start ms, dur ms, cents):');
  for (const n of a?.notes ?? []) {
    lines.push(`  ${noteName(n.midi).padEnd(4)} ${String(Math.round(n.start * 1000)).padStart(6)} ${String(Math.round(n.duration * 1000)).padStart(5)} ${n.cents >= 0 ? '+' : ''}${n.cents.toFixed(0)}`);
  }
  return lines.join('\n');
}
