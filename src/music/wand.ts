/**
 * The magic wand's keys: the other keys this melody could just as well be in.
 * A tune heard as G major may as well be E minor (same notes, another home) or
 * A minor / C major when it never touches the note that tells them apart. Each
 * wand tap moves to the next one: a whole new mood from the same singing.
 */
import { scalePitchClasses } from '../analysis/music';
import type { Mode, Note } from '../analysis/types';

export interface KeyChoice {
  tonic: number;
  mode: Mode;
}

const pc = (m: number): number => ((Math.round(m) % 12) + 12) % 12;

/**
 * Keys that fit the melody, best first, the heard key always first. A key fits when
 * (almost) every sung note is in its scale; among those, one whose home note is sung
 * long, or last, ranks higher. At most `max`, at least the heard key and its relative.
 */
export function keyChoices(notes: Note[], heard: KeyChoice | null, max = 5): KeyChoice[] {
  if (!notes.length) return heard ? [heard, relative(heard)] : [];
  const weight = new Float64Array(12);
  let total = 0;
  for (const n of notes) {
    const w = Math.max(0.05, n.duration);
    weight[pc(n.midi)] += w;
    total += w;
  }
  const lastNote = notes.length ? [...notes].sort((a, b) => a.start + a.duration - (b.start + b.duration))[notes.length - 1] : null;
  const last = lastNote ? pc(lastNote.midi) : -1;
  const first = notes.length ? pc([...notes].sort((a, b) => a.start - b.start)[0].midi) : -1;
  const scored: { k: KeyChoice; fit: number; score: number }[] = [];
  for (const mode of ['major', 'minor'] as Mode[]) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const scale = scalePitchClasses(tonic, mode);
      let inside = 0;
      for (let p = 0; p < 12; p++) if (scale.has(p)) inside += weight[p];
      const fit = total > 0 ? inside / total : 0;
      // The home note: sung a lot, last, or first. The fifth helps a little.
      const home = total > 0 ? weight[tonic] / total : 0;
      const fifth = total > 0 ? weight[(tonic + 7) % 12] / total : 0;
      const score = fit + 0.35 * home + 0.1 * fifth + (last === tonic ? 0.08 : 0) + (first === tonic ? 0.04 : 0);
      scored.push({ k: { tonic, mode }, fit, score });
    }
  }
  const bestFit = Math.max(...scored.map((s) => s.fit));
  const same = (a: KeyChoice, b: KeyChoice): boolean => a.tonic === b.tonic && a.mode === b.mode;
  const out: KeyChoice[] = heard ? [heard] : [];
  for (const s of scored.filter((x) => x.fit >= bestFit - 0.06).sort((a, b) => b.score - a.score)) {
    if (out.length >= max) break;
    if (!out.some((k) => same(k, s.k))) out.push(s.k);
  }
  // Always somewhere to go: the relative key of the heard one.
  if (heard && out.length < 2) out.push(relative(heard));
  return out;
}

/** Same notes, the other home: G major ↔ E minor. */
function relative(k: KeyChoice): KeyChoice {
  return k.mode === 'major' ? { tonic: (k.tonic + 9) % 12, mode: 'minor' } : { tonic: (k.tonic + 3) % 12, mode: 'major' };
}
