/**
 * What Essentia adds: the same sung takes analysed with and without it (key from audio + tempo).
 * Run: npx vite-node tests/essentia-ab.ts
 */
import { essentiaKey, essentiaRhythm, loadEssentia } from '../src/analysis/essentia';
import { analyze, type ExternalInputs } from '../src/analysis/pipeline';
import { trackPitchYin } from '../src/analysis/pitch';
import { estimateTuning } from '../src/analysis/tuning';
import { cases } from './notes-bench';

const SR = 44100;
// The test melodies are named after their key; the repeated-note one is in D major.
const keyOf = (name: string): string => (name.startsWith('Repeats') ? 'D major' : name.split(' ').slice(0, 2).join(' '));

const es = await loadEssentia();
console.log('essentia', es.version);
const all = [...cases(24, false), ...cases(12, true)];
const tally = { js: { key: 0, bpm: 0, ms: 0 }, es: { key: 0, bpm: 0, ms: 0 } };
let differ = 0;
for (const c of all) {
  const truth = keyOf(c.name);
  const t0 = performance.now();
  const js = analyze(c.samples, SR, {});
  const t1 = performance.now();
  const pitch = trackPitchYin(c.samples, SR);
  const ext: ExternalInputs = { pitch, essentiaVersion: es.version };
  ext.audioKey = essentiaKey(es, c.samples, SR, estimateTuning(pitch).a4Hz);
  ext.rhythm = essentiaRhythm(es, c.samples, SR);
  const withEs = analyze(c.samples, SR, ext);
  const t2 = performance.now();
  for (const [name, r, ms] of [['js', js, t1 - t0], ['es', withEs, t2 - t1]] as const) {
    const k = r.key.chosen;
    const keyOk = k?.name === truth;
    const bpm = r.tempo.chosen?.bpm ?? 0;
    tally[name].key += keyOk ? 1 : 0;
    tally[name].bpm += Math.abs(bpm / c.bpm - 1) < 0.03 ? 1 : 0;
    tally[name].ms += ms;
  }
  const a = `${js.key.chosen?.name} ${Math.round(js.tempo.chosen?.bpm ?? 0)}`;
  const b = `${withEs.key.chosen?.name} ${Math.round(withEs.tempo.chosen?.bpm ?? 0)}`;
  if (a !== b) differ++;
  console.log(`${c.name.padEnd(34)} true ${c.bpm}  without: ${a.padEnd(16)} with: ${b}`);
}
const n = all.length;
for (const k of ['js', 'es'] as const) {
  console.log(`${k === 'js' ? 'without Essentia' : 'with Essentia   '}: key ${tally[k].key}/${n}, tempo ${tally[k].bpm}/${n}, ${Math.round(tally[k].ms / n)} ms/take`);
}
console.log(`takes where the result differs: ${differ}/${n}`);
