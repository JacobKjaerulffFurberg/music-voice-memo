/**
 * Singing over a loop: what was sung is laid onto one loop-length strip of
 * audio. Each sample goes where the band was when it was sung; singing through
 * several passes stacks them on top of each other, like a looper pedal.
 */

/**
 * @param x        what the mic recorded
 * @param offsetSec where in the loop (seconds from its start) the first sample of `x` belongs;
 *                  may be negative or beyond the loop, it wraps
 * @param loopSec  length of the loop
 * @returns one loop of audio at `sampleRate`
 */
export function foldOntoLoop(x: Float32Array, sampleRate: number, offsetSec: number, loopSec: number): Float32Array {
  const out = new Float32Array(Math.max(1, Math.round(loopSec * sampleRate)));
  // A short fade at both ends so the layer never starts or stops with a click.
  const fade = Math.max(1, Math.min(Math.round(0.012 * sampleRate), Math.floor(x.length / 2)));
  const first = Math.round(offsetSec * sampleRate);
  for (let i = 0; i < x.length; i++) {
    const k = (((first + i) % out.length) + out.length) % out.length;
    out[k] += x[i] * Math.min(1, i / fade, (x.length - 1 - i) / fade);
  }
  return out;
}

/** Loudness (RMS) of a stretch of audio, sampled coarsely. */
export function roughLevel(x: Float32Array, from = 0): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < x.length; i += 4) {
    sum += x[i] * x[i];
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}
